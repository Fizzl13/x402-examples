// The x402 "exact" scheme on Concordium with sponsored transactions (SPEC.md): the buyer signs a transfer of CCD or a
// protocol-level token (PLT) to the seller, with this facilitator as sponsor; the facilitator checks it, adds its
// signature as sponsor (paying the fee) and submits it. It never holds the buyer's funds.
import {
  AccountAddress, AccountTransactionType, CcdAmount, SequenceNumber, Transaction, TransactionExpiry,
} from '@concordium/web-sdk';
import { CborAccountAddress, TokenAmount, TokenId, createTokenUpdatePayload, parseTokenUpdatePayload } from '@concordium/web-sdk/plt';

export const NETWORKS = {
  'ccd:9dd9ca4d19e9393877d2c44b70f89acb': { name: 'Concordium', testnet: false },
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': { name: 'Concordium Testnet', testnet: true },
};
export const CCD_DECIMALS = 6;
const EXPIRY_SLACK_SECONDS = 30;

const isCcd = (asset) => typeof asset === 'string' && asset.toUpperCase() === 'CCD';
const bad = (invalidReason, detail) => ({ isValid: false, invalidReason, ...(detail ? { detail } : {}) });

// What a seller asks: checked before anything else, the same on /verify and /settle.
export function checkRequirements(req, sponsor) {
  if (!req || typeof req !== 'object') return 'invalid_payment_requirements';
  if (req.scheme !== 'exact') return 'unsupported_scheme';
  if (!NETWORKS[req.network]) return 'invalid_network';
  if (typeof req.amount !== 'string' || !/^\d+$/.test(req.amount) || BigInt(req.amount) === 0n) return 'invalid_payment_requirements';
  if (typeof req.payTo !== 'string' || !safeAddress(req.payTo)) return 'invalid_payment_requirements';
  if (typeof req.asset !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(req.asset)) return 'invalid_payment_requirements';
  if (req.extra?.sponsor !== undefined && req.extra.sponsor !== sponsor) return 'invalid_payment_requirements';
  return null;
}
function safeAddress(s) { try { AccountAddress.fromBase58(s); return true; } catch { return false; } }

// The buyer's side: build and sign the sponsorable transfer the requirements ask for. `token` (for a PLT) is
// { decimals }. Returns the x402 payload { transaction } (the signed transaction as JSON).
export async function buildPayment({ requirements: req, sender, nonce, signer, token = null, now = Date.now() }) {
  const sponsor = req.extra?.sponsor;
  if (!sponsor) throw new Error('requirements.extra.sponsor is missing: the facilitator sponsoring the fee');
  const expiry = TransactionExpiry.fromEpochSeconds(BigInt(Math.floor(now / 1000) + Math.min(Number(req.maxTimeoutSeconds) || 120, 600)));
  const to = AccountAddress.fromBase58(req.payTo);
  let tx;
  if (isCcd(req.asset)) {
    tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(BigInt(req.amount)), toAddress: to });
  } else {
    const decimals = token?.decimals ?? req.extra?.decimals;
    if (!Number.isInteger(decimals)) throw new Error(`the decimals of ${req.asset} are needed (token.decimals or extra.decimals)`);
    const op = { transfer: { amount: TokenAmount.create(BigInt(req.amount), decimals), recipient: CborAccountAddress.fromAccountAddress(to) } };
    tx = Transaction.tokenUpdate(createTokenUpdatePayload(TokenId.fromString(req.asset), op));
  }
  const signable = tx
    .addMetadata({ sender: AccountAddress.fromBase58(sender), nonce: SequenceNumber.create(BigInt(nonce)), expiry })
    .addSponsor(AccountAddress.fromBase58(sponsor))
    .build();
  const signed = await Transaction.sign(signable, signer);
  return { transaction: Transaction.toJSONString(signed) };
}

// What the transfer in a parsed transaction pays: { asset, amount (atomic bigint), to (base58) }, or null when the
// payload is anything but exactly one plain transfer.
export function transferOf(tx) {
  const p = tx.payload;
  if (p.type === AccountTransactionType.Transfer || p.type === AccountTransactionType.TransferWithMemo) {
    return { asset: 'CCD', amount: BigInt(p.amount.microCcdAmount), to: AccountAddress.toBase58(p.toAddress), decimals: CCD_DECIMALS };
  }
  if (p.type === AccountTransactionType.TokenUpdate) {
    let ops;
    try { ops = parseTokenUpdatePayload(p).operations; } catch { return null; }
    if (ops.length !== 1 || !ops[0] || typeof ops[0] !== 'object' || !('transfer' in ops[0])) return null;
    const t = ops[0].transfer;
    let to;
    try { to = AccountAddress.toBase58(t.recipient.address); } catch { return null; }
    return { asset: p.tokenId.value, amount: BigInt(t.amount.value), decimals: Number(t.amount.decimals), to };
  }
  return null;
}

// Facilitator: is this payment good for these requirements? `node` reads the chain:
//   accountInfo(address) -> the SDK AccountInfo (credentials, threshold) or null
//   nextNonce(address) -> bigint
//   balance(address, asset) -> bigint in the asset's smallest unit (CCD: at disposal), or null if unknown
//   token(asset) -> { decimals, paused? } for a PLT, or null if it doesn't exist
//   checkTransfer(asset, from, to, amount, decimals) -> null, or why the token refuses it (allow/deny list, paused)
export async function verifyPayment({ requirements: req, payload, sponsor, node, now = Date.now() }) {
  const r = checkRequirements(req, sponsor);
  if (r) return bad(r);
  let tx;
  try { tx = Transaction.signableFromJSON(JSON.parse(payload?.transaction)); } catch {
    try { tx = Transaction.signableFromJSON(Transaction.fromJSONString(payload?.transaction)); } catch { return bad('invalid_payload', 'the transaction does not parse'); }
  }
  if (tx.version !== 1 || !tx.header.sponsor) return bad('invalid_payload', 'not a sponsored (v1) transaction');
  if (AccountAddress.toBase58(tx.header.sponsor.account) !== sponsor || tx.header.sponsor.numSignatures !== 1n) return bad('invalid_payload', 'the sponsor is not this facilitator');
  const payer = AccountAddress.toBase58(tx.header.sender);
  const pay = transferOf(tx);
  if (!pay) return bad('invalid_payload', 'the transaction is not exactly one transfer');
  if (pay.to !== req.payTo) return bad('invalid_exact_recipient_mismatch', 'the transfer goes to another account than payTo');
  if (isCcd(req.asset) ? pay.asset !== 'CCD' : pay.asset !== req.asset) return bad('invalid_exact_asset_mismatch');
  if (pay.amount !== BigInt(req.amount)) return bad('invalid_exact_amount_mismatch');
  if (payer === req.payTo || payer === sponsor) return bad('invalid_payload', 'the sender is the seller or the sponsor');
  // Expiry: in the future, and no further than the seller allowed.
  const exp = Number(tx.header.expiry.expiryEpochSeconds), nowS = Math.floor(now / 1000);
  if (exp <= nowS) return bad('invalid_exact_expired');
  if (exp > nowS + (Number(req.maxTimeoutSeconds) || 120) + EXPIRY_SLACK_SECONDS) return bad('invalid_payload', 'the expiry is too far away');
  // Energy: exactly what this payload needs, so the sponsor never pays for more than the transfer.
  const base = (tx.payload.type === AccountTransactionType.TokenUpdate ? Transaction.tokenUpdate(tx.payload) : Transaction.transfer(tx.payload)).header.executionEnergyAmount;
  if (tx.header.executionEnergyAmount?.value !== base.value) return bad('invalid_payload', 'the energy is not what this transfer needs');
  const cost = Transaction.getEnergyCost(tx);
  // On chain: the signature, the nonce, the balance, and for a PLT that it may move.
  const info = await node.accountInfo(payer);
  if (!info) return bad('invalid_payload', 'the sender account does not exist');
  let sigOk = false;
  try { sigOk = await Transaction.verifySignature(tx, tx.signatures.sender, info); } catch { sigOk = false; }
  if (!sigOk) return bad('invalid_exact_signature');
  const next = await node.nextNonce(payer);
  if (tx.header.nonce.value !== BigInt(next)) return bad('invalid_payload', `the nonce is not the sender's next one (${next})`);
  if (!isCcd(req.asset)) {
    const token = await node.token(req.asset);
    if (!token) return bad('invalid_exact_asset_mismatch', 'no such token');
    if (token.decimals !== pay.decimals) return bad('invalid_exact_amount_mismatch', `the token has ${token.decimals} decimals`);
    if (token.paused) return bad('invalid_payload', 'the token is paused');
    const refused = node.checkTransfer ? await node.checkTransfer(req.asset, payer, req.payTo, pay.amount, pay.decimals) : null;
    if (refused) return bad('invalid_payload', `the token does not allow this transfer (allow or deny list): ${refused}`);
  }
  const balance = await node.balance(payer, isCcd(req.asset) ? 'CCD' : req.asset);
  if (balance !== null && balance < pay.amount) return bad('insufficient_funds');
  return { isValid: true, payer, tx, energy: cost };
}

// Facilitator: verify, sign as sponsor, submit, and wait for the outcome. `sponsorSigner` signs for `sponsor`;
// `node.send(signedTx)` returns the transaction hash, `node.waitFinal(hash)` the outcome { success, reason }.
export async function settlePayment({ requirements, payload, sponsor, sponsorSigner, node, now = Date.now() }) {
  const v = await verifyPayment({ requirements, payload, sponsor, node, now });
  if (!v.isValid) return { success: false, errorReason: v.invalidReason, ...(v.detail ? { detail: v.detail } : {}), network: requirements?.network, transaction: '' };
  const sponsored = await Transaction.sponsor(v.tx, sponsorSigner);
  const hash = await node.send(Transaction.finalize(sponsored));
  const outcome = await node.waitFinal(hash);
  if (!outcome?.success) return { success: false, errorReason: 'transaction_failed', detail: outcome?.reason ?? null, network: requirements.network, transaction: hash, payer: v.payer };
  return { success: true, network: requirements.network, transaction: hash, payer: v.payer };
}
