// Connector payments in USDC on Solana, signed in the owner's own Solana wallet (Phantom, Solflare, Backpack: any
// Wallet Standard wallet; src/connector-pay.js uses this). The transaction is the one x402's own Solana client builds:
// a compute-unit limit and price, a checked USDC transfer from the owner to the seller, and a memo, with the seller's
// facilitator as fee payer (it adds its signature and submits). The owner's wallet signs it on the approve page; the
// server checks that what came back is still that payment before sending it. A wallet may add its own guard
// instructions (Phantom's Lighthouse), which facilitators accept; anything else changed is refused.
import { randomBytes } from "node:crypto";
import { b58encode, b58decode, isSolanaAddress, associatedTokenAccount, verifySolanaSignature, USDC_MINT, USDC_DECIMALS } from "./solana.js";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const COMPUTE_UNITS = 20_000; // as @x402/svm's client
const MICRO_LAMPORTS = 1;
const MAX_INSTRUCTIONS = 7; // what facilitators take

const compactU16 = (n) => { const out = []; for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); return out; } } };
const le = (v, bytes) => { const out = []; let n = BigInt(v); for (let i = 0; i < bytes; i++) { out.push(Number(n & 0xffn)); n >>= 8n; } return out; };

// The USDC-on-Solana "exact" offer in an x402 v2 challenge, with the facilitator that pays the fee. null: none.
export function solanaOffer(challenge) {
  if (!challenge || Number(challenge.x402Version) !== 2 || !Array.isArray(challenge.accepts)) return null;
  for (const a of challenge.accepts) {
    if (a?.scheme !== "exact" || a.network !== SOLANA_MAINNET || a.asset !== USDC_MINT) continue;
    const amount = String(a.amount ?? "");
    const extra = a.extra ?? {};
    if (!/^[1-9]\d{0,17}$/.test(amount) || !isSolanaAddress(a.payTo) || !isSolanaAddress(extra.feePayer) || a.payTo === extra.feePayer) continue;
    const memo = typeof extra.memo === "string" && extra.memo ? extra.memo : null;
    if (memo && Buffer.byteLength(memo) > 256) continue;
    return { network: SOLANA_MAINNET, accepted: a, resource: challenge.resource ?? null, amount, price: Number(amount) / 10 ** USDC_DECIMALS, payTo: a.payTo, feePayer: extra.feePayer, memo };
  }
  return null;
}

// The v0 message to sign: fee payer (the facilitator) and the owner sign; the owner's USDC account pays the seller's.
export function paymentMessage(offer, from, blockhash, memo = randomBytes(16).toString("hex")) {
  const fromAta = associatedTokenAccount(from), toAta = associatedTokenAccount(offer.payTo);
  // Signer+writable, signer read-only, writable, read-only.
  const keys = [offer.feePayer, from, fromAta, toAta, USDC_MINT, TOKEN_PROGRAM, COMPUTE_BUDGET, MEMO_PROGRAM];
  if (new Set(keys).size !== keys.length) throw new Error("that wallet can't pay this seller");
  const at = (k) => keys.indexOf(k);
  const instructions = [
    { program: at(COMPUTE_BUDGET), accounts: [], data: [2, ...le(COMPUTE_UNITS, 4)] },
    { program: at(COMPUTE_BUDGET), accounts: [], data: [3, ...le(MICRO_LAMPORTS, 8)] },
    { program: at(TOKEN_PROGRAM), accounts: [at(fromAta), at(USDC_MINT), at(toAta), at(from)], data: [12, ...le(offer.amount, 8), USDC_DECIMALS] },
    { program: at(MEMO_PROGRAM), accounts: [], data: [...Buffer.from(offer.memo ?? memo, "utf8")] },
  ];
  const bytes = [0x80, 2, 1, 4, ...compactU16(keys.length)];
  for (const k of keys) bytes.push(...b58decode(k));
  bytes.push(...b58decode(blockhash), ...compactU16(instructions.length));
  for (const i of instructions) bytes.push(i.program, ...compactU16(i.accounts.length), ...i.accounts, ...compactU16(i.data.length), ...i.data);
  bytes.push(0); // no address lookup tables
  return Uint8Array.from(bytes);
}

// The transaction as the wallet takes it: a slot for each signature (empty until signed), then the message.
export function unsignedTransaction(message) {
  return Uint8Array.from([...compactU16(2), ...new Uint8Array(128), ...message]);
}

function readCompact(bytes, at) {
  let n = 0, shift = 0;
  for (;;) { const b = bytes[at.i++]; if (b === undefined) throw new Error("short"); n |= (b & 0x7f) << shift; if (!(b & 0x80)) return n; shift += 7; if (shift > 14) throw new Error("bad length"); }
}
const take = (bytes, at, n) => { if (at.i + n > bytes.length) throw new Error("short"); const out = bytes.subarray(at.i, at.i + n); at.i += n; return out; };

// A wire transaction -> its signatures and message bytes.
export function parseTransaction(bytes) {
  const at = { i: 0 };
  const n = readCompact(bytes, at);
  if (n < 1 || n > 8) throw new Error("bad signature count");
  const signatures = Array.from({ length: n }, () => take(bytes, at, 64));
  return { signatures, message: bytes.subarray(at.i) };
}
// A v0 message without lookup tables -> its signers, fee payer, blockhash and instructions (with addresses).
export function parseMessage(bytes) {
  const at = { i: 0 };
  if (bytes[at.i++] !== 0x80) throw new Error("not a v0 message");
  const [signers, readonlySigned, readonlyUnsigned] = take(bytes, at, 3);
  const keys = Array.from({ length: readCompact(bytes, at) }, () => b58encode(take(bytes, at, 32)));
  const blockhash = b58encode(take(bytes, at, 32));
  const instructions = Array.from({ length: readCompact(bytes, at) }, () => {
    const program = keys[bytes[at.i++]];
    const accounts = Array.from({ length: readCompact(bytes, at) }, () => keys[bytes[at.i++]]);
    const data = take(bytes, at, readCompact(bytes, at));
    if (!program || accounts.some((a) => !a)) throw new Error("bad account index");
    return { program, accounts, data };
  });
  if (readCompact(bytes, at) !== 0) throw new Error("address lookup tables");
  if (at.i !== bytes.length) throw new Error("trailing bytes");
  return { signers, readonlySigned, readonlyUnsigned, keys, feePayer: keys[0], blockhash, instructions };
}

// What the wallet sent back, against the message built for it: the same fee payer, blockhash and instructions (a
// wallet's Lighthouse guards after them aside), only the fee payer and the owner signing, and the owner's signature
// valid. { transaction (base64, for the x402 payload) } or { error }.
export function checkSigned(signedB64, builtMessage, from) {
  const changed = { error: "Your wallet changed the payment, so it wasn't sent. Nothing was paid." };
  let tx, got, ours;
  try {
    tx = parseTransaction(Buffer.from(String(signedB64), "base64"));
    got = parseMessage(tx.message);
    ours = parseMessage(builtMessage);
  } catch { return { error: "Your wallet sent back something that isn't a Solana transaction. Nothing was paid." }; }
  if (got.feePayer !== ours.feePayer || got.blockhash !== ours.blockhash || got.signers !== 2 || tx.signatures.length !== 2) return changed;
  if (got.instructions.length > MAX_INSTRUCTIONS) return changed;
  const same = (a, b) => a.program === b.program && a.accounts.join() === b.accounts.join() && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
  const head = got.instructions.slice(0, ours.instructions.length);
  if (head.length !== ours.instructions.length || head.some((ix, i) => !same(ix, ours.instructions[i]))) return changed;
  if (got.instructions.slice(ours.instructions.length).some((ix) => ix.program !== LIGHTHOUSE)) return changed;
  const index = got.keys.indexOf(from);
  if (index !== 1) return changed;
  if (!verifySolanaSignature(from, tx.message, tx.signatures[1])) return { error: `That signature isn't from ${from.slice(0, 4)}…${from.slice(-4)}. Nothing was paid.` };
  return { transaction: Buffer.from(String(signedB64), "base64").toString("base64") };
}

// The Solana reads needed: a recent blockhash, and an owner's USDC balance (base units; null: couldn't be read).
export function createSolanaReader({ rpcUrl = "https://api.mainnet-beta.solana.com", fetch: fetchImpl = globalThis.fetch } = {}) {
  const rpc = async (method, params) => {
    const j = await (await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) })).json();
    if (j?.error) throw new Error(String(j.error.message ?? "rpc error"));
    return j?.result;
  };
  return {
    async blockhash() {
      const h = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]))?.value?.blockhash;
      if (!isSolanaAddress(h)) throw new Error("Solana can't be read right now");
      return h;
    },
    async usdc(owner) {
      try { return BigInt((await rpc("getTokenAccountBalance", [associatedTokenAccount(owner), { commitment: "confirmed" }]))?.value?.amount ?? "x"); }
      catch (err) { return /could not find account|invalid param/i.test(err.message) ? 0n : null; }
    },
  };
}
