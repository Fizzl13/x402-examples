// The Algorand side of hosted accounts: sign in with Pera. Pera's signData signs "MX" + the bytes with the
// account's ed25519 key (the same as algosdk's signBytes), so the server checks it itself: the address is
// the public key with a checksum, nothing to look up. Rekeyed accounts (signing with another key) and
// hardware accounts can't sign in this way; they use e-mail or a passkey.
import { createHash, createPublicKey, verify } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of str) {
    const i = B32.indexOf(c);
    if (i < 0) throw new TypeError("not base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// The 32-byte public key of an Algorand address, or null when it isn't one (58 characters, checksum checked).
export function algorandPublicKey(address) {
  if (typeof address !== "string" || !/^[A-Z2-7]{58}$/.test(address)) return null;
  try {
    const raw = b32decode(address);
    // The last character carries 2 padding bits: only the canonical spelling (padding zero) is an address.
    if (B32.indexOf(address[57]) & 3) return null;
    if (raw.length !== 36) return null;
    const pub = raw.subarray(0, 32);
    const sum = createHash("sha512-256").update(pub).digest().subarray(28);
    return sum.equals(raw.subarray(32)) ? pub : null;
  } catch { return null; }
}
export const isAlgorandAddress = (address) => algorandPublicKey(address) !== null;

// Did this address's key sign the message, the way Pera's signData does ("MX" + the UTF-8 bytes)?
// signature: base64 (or a Uint8Array) of 64 bytes.
export function verifyAlgorandSignature(address, message, signature) {
  try {
    const pub = algorandPublicKey(address);
    const sig = typeof signature === "string" ? Buffer.from(signature, "base64") : Buffer.from(signature);
    if (!pub || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
    return verify(null, Buffer.concat([Buffer.from("MX"), Buffer.from(message, "utf8")]), key, sig);
  } catch { return false; }
}

// Sign in with Defly: Defly signs transactions only, not arbitrary data. So the sign-in is a payment of 0 ALGO
// from the account to itself, with the sign-in message as its note and a fee of 0. This server builds the exact
// bytes, the wallet signs them, and the server checks the signature over them; the transaction is never sent,
// and a fee of 0 is below the network's minimum, so it could never be confirmed on its own anyway.
const mpStr = (t) => { const b = Buffer.from(t, "utf8"); return Buffer.concat([b.length < 32 ? Buffer.from([0xa0 | b.length]) : Buffer.from([0xd9, b.length]), b]); };
const mpBin = (b) => Buffer.concat([b.length < 256 ? Buffer.from([0xc4, b.length]) : Buffer.from([0xc5, b.length >> 8, b.length & 0xff]), b]);
function mpUint(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("not an unsigned integer");
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0xcc, n]);
  if (n < 65536) return Buffer.from([0xcd, n >> 8, n & 0xff]);
  const b = Buffer.alloc(n < 2 ** 32 ? 5 : 9);
  if (n < 2 ** 32) { b[0] = 0xce; b.writeUInt32BE(n, 1); } else { b[0] = 0xcf; b.writeBigUInt64BE(BigInt(n), 1); }
  return b;
}
// The canonical encoding of that transaction (keys sorted, zero values left out), as algosdk and the wallet make it.
export function algorandAuthTxn({ address, note, firstValid, lastValid, genesisHash, genesisId }) {
  const pub = algorandPublicKey(address);
  if (!pub) throw new TypeError("not an Algorand address");
  const noteBytes = Buffer.from(note, "utf8");
  if (noteBytes.length > 1024) throw new TypeError("note too long");
  const fields = [["fv", mpUint(firstValid)], ["gen", mpStr(genesisId)], ["gh", mpBin(Buffer.from(genesisHash, "base64"))], ["lv", mpUint(lastValid)], ["note", mpBin(noteBytes)], ["rcv", mpBin(pub)], ["snd", mpBin(pub)], ["type", mpStr("pay")]];
  return Buffer.concat([Buffer.from([0x80 | fields.length]), ...fields.flatMap(([k, v]) => [mpStr(k), v])]);
}
// Did this address's own key sign exactly those transaction bytes? signed: the signed transaction (base64 or bytes),
// which must be { sig, txn } and nothing else: a rekeyed account (signed by another key, "sgnr") can't sign in this way.
export function verifyAlgorandAuthTxn(address, txnBytes, signed) {
  try {
    const pub = algorandPublicKey(address);
    const s = typeof signed === "string" ? Buffer.from(signed, "base64") : Buffer.from(signed);
    const head = Buffer.concat([Buffer.from([0x82]), mpStr("sig"), Buffer.from([0xc4, 64])]);
    const mid = mpStr("txn");
    if (!pub || s.length !== head.length + 64 + mid.length + txnBytes.length) return false;
    if (!s.subarray(0, head.length).equals(head) || !s.subarray(head.length + 64, head.length + 64 + mid.length).equals(mid) || !s.subarray(head.length + 64 + mid.length).equals(txnBytes)) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
    return verify(null, Buffer.concat([Buffer.from("TX"), txnBytes]), key, s.subarray(head.length, head.length + 64));
  } catch { return false; }
}

// Pro paid in USDC on Algorand: an asset transfer of USDC (ASA 31566704) to the owner's address.
export const ALGO_USDC = 31566704;
export const isAlgorandTxId = (v) => typeof v === "string" && /^[A-Z2-7]{52}$/.test(v);

// What an indexer transaction (GET /v2/transactions/{id}) paid: { id, from, units, at } or { error }.
// Only a confirmed, top-level USDC transfer to payTo counts.
export function algoUsdcPaid(tx, { payTo }) {
  if (!tx) return { error: "not_found" };
  if (!tx["confirmed-round"]) return { error: "not_confirmed" };
  const x = tx["asset-transfer-transaction"];
  if (tx["tx-type"] !== "axfer" || !x) return { error: "not_usdc" };
  if (Number(x["asset-id"]) !== ALGO_USDC) return { error: "not_usdc" };
  if (x.receiver !== payTo) return { error: "not_to_us" };
  if (tx["asset-close-transaction"] || x["close-to"]) return { error: "not_usdc" };
  return { id: tx.id, from: tx.sender, units: BigInt(x.amount ?? 0), at: Number(tx["round-time"] ?? 0) * 1000 };
}
