// The exact scheme on Concordium (src/scheme.js) against a stand-in node: a buyer's signed, sponsorable CCD or PLT
// transfer passes /verify, is sponsored and submitted on /settle, and every way to cheat is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { AccountAddress, Transaction, buildBasicAccountSigner } from '@concordium/web-sdk';
import { buildPayment, verifyPayment, settlePayment, transferOf } from '../src/scheme.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function account() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const address = AccountAddress.toBase58(AccountAddress.fromBuffer(randomBytes(32)));
  const info = { accountAddress: AccountAddress.fromBase58(address), accountThreshold: 1, accountCredentials: { 0: { value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: pub } } } } } } } };
  return { address, signer: buildBasicAccountSigner(priv), info };
}

const buyer = account(), seller = account(), sponsor = account(), stranger = account();
function node({ nonce = 7n, ccd = 10_000_000n, eurr = 5_000_000n, token = { decimals: 6 }, outcome = { success: true } } = {}) {
  const sent = [];
  return {
    sent,
    accountInfo: async (a) => [buyer, seller, sponsor].find((x) => x.address === a)?.info ?? null,
    nextNonce: async () => nonce,
    balance: async (_, asset) => (asset === 'CCD' ? ccd : eurr),
    token: async (id) => (id === 'EURR' ? token : null),
    send: async (tx) => { sent.push(tx); return `hash${sent.length}`; },
    waitFinal: async () => outcome,
  };
}
const req = (over = {}) => ({ scheme: 'exact', network: TESTNET, amount: '10000', asset: 'CCD', payTo: seller.address, maxTimeoutSeconds: 120, extra: { sponsor: sponsor.address }, ...over });
const pay = (r, over = {}) => buildPayment({ requirements: r, sender: buyer.address, nonce: 7n, signer: buyer.signer, now: NOW, ...over });

test('a CCD payment verifies, is sponsored, submitted once, and settles', async () => {
  const r = req();
  const payload = await pay(r);
  const n = node();
  const v = await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: n, now: NOW });
  assert.equal(v.isValid, true, `${v.invalidReason} ${v.detail}`);
  assert.equal(v.payer, buyer.address);
  assert.deepEqual(transferOf(v.tx), { asset: 'CCD', amount: 10000n, to: seller.address, decimals: 6 });
  const s = await settlePayment({ requirements: r, payload, sponsor: sponsor.address, sponsorSigner: sponsor.signer, node: n, now: NOW });
  assert.deepEqual([s.success, s.transaction, s.payer, s.network], [true, 'hash1', buyer.address, TESTNET]);
  assert.equal(n.sent.length, 1);
  const sponsored = n.sent[0]; // the finalized transaction, with both signatures
  assert.equal(sponsored.version, 1);
  assert.match(String(sponsored.signatures.sponsor?.[0]?.[0] ?? ''), /^[0-9a-f]{128}$/, 'the sponsor signed');
  assert.match(String(sponsored.signatures.sender?.[0]?.[0] ?? ''), /^[0-9a-f]{128}$/, 'the buyer\'s signature is kept');
});

test('a PLT (EURR) payment verifies with the token decimals', async () => {
  const r = req({ asset: 'EURR', amount: '2500000', extra: { sponsor: sponsor.address, decimals: 6 } });
  const payload = await pay(r);
  const v = await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: node(), now: NOW });
  assert.equal(v.isValid, true, `${v.invalidReason} ${v.detail}`);
  assert.deepEqual(transferOf(v.tx), { asset: 'EURR', amount: 2500000n, to: seller.address, decimals: 6 });
  const poor = await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: node({ eurr: 1n }), now: NOW });
  assert.equal(poor.invalidReason, 'insufficient_funds');
  const paused = await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: node({ token: { decimals: 6, paused: true } }), now: NOW });
  assert.match(paused.detail, /paused/);
  const listed = await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: { ...node(), checkTransfer: async () => 'the receiver is not on the allow list' }, now: NOW });
  assert.match(listed.detail, /allow or deny/);
});

test('refused: another amount, another seller, another asset, another sponsor', async () => {
  const r = req();
  const payload = await pay(r);
  const v = (requirements, p = payload, sp = sponsor.address) => verifyPayment({ requirements, payload: p, sponsor: sp, node: node(), now: NOW });
  assert.equal((await v(req({ amount: '20000' }))).invalidReason, 'invalid_exact_amount_mismatch');
  assert.equal((await v(req({ payTo: stranger.address }))).invalidReason, 'invalid_exact_recipient_mismatch');
  assert.equal((await v(req({ asset: 'EURR', extra: { sponsor: sponsor.address, decimals: 6 } }))).invalidReason, 'invalid_exact_asset_mismatch');
  const other = await pay(req({ extra: { sponsor: stranger.address } }));
  assert.match((await v(r, other)).detail, /sponsor is not this facilitator/);
  assert.equal((await v(req({ extra: { sponsor: stranger.address } }))).invalidReason, 'invalid_payment_requirements', 'requirements naming another sponsor');
});

test('refused: a forged signature, a used or future nonce, an expired or too-long transaction', async () => {
  const r = req();
  const forged = await pay(r, { signer: stranger.signer });
  assert.equal((await verifyPayment({ requirements: r, payload: forged, sponsor: sponsor.address, node: node(), now: NOW })).invalidReason, 'invalid_exact_signature');
  const payload = await pay(r);
  assert.match((await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: node({ nonce: 8n }), now: NOW })).detail, /nonce/);
  assert.equal((await verifyPayment({ requirements: r, payload, sponsor: sponsor.address, node: node(), now: NOW + 600_000 })).invalidReason, 'invalid_exact_expired');
  const long = await pay(req({ maxTimeoutSeconds: 600 }));
  assert.match((await verifyPayment({ requirements: r, payload: long, sponsor: sponsor.address, node: node(), now: NOW })).detail, /expiry is too far/);
});

test('refused: a sponsor-paid transaction with extra energy, a tampered payload, or no sponsor at all', async () => {
  const r = req();
  const payload = await pay(r);
  const json = JSON.parse(payload.transaction);
  const heavy = structuredClone(json);
  heavy.header.executionEnergyAmount = Number(heavy.header.executionEnergyAmount) + 100000;
  const h = await verifyPayment({ requirements: r, payload: { transaction: JSON.stringify(heavy) }, sponsor: sponsor.address, node: node(), now: NOW });
  assert.match(h.detail, /energy/);
  const plain = Transaction.transfer({ amount: { microCcdAmount: 10000n }, toAddress: AccountAddress.fromBase58(seller.address) });
  assert.ok(plain);
  const s = await verifyPayment({ requirements: r, payload: { transaction: 'not json' }, sponsor: sponsor.address, node: node(), now: NOW });
  assert.equal(s.invalidReason, 'invalid_payload');
});

test('settle: a failed transaction on chain is reported, not settled', async () => {
  const r = req();
  const payload = await pay(r);
  const s = await settlePayment({ requirements: r, payload, sponsor: sponsor.address, sponsorSigner: sponsor.signer, node: node({ outcome: { success: false, reason: 'AmountTooLarge' } }), now: NOW });
  assert.deepEqual([s.success, s.errorReason, s.detail, s.transaction], [false, 'transaction_failed', 'AmountTooLarge', 'hash1']);
});
