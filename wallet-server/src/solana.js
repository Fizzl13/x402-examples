// The Solana side of hosted accounts: sign in with a Solana wallet (Phantom)
// and pay for Pro in USDC on Solana. Small on purpose: base58, ed25519
// signatures, associated token accounts, and one USDC transfer, built as a
// legacy transaction message that the wallet signs and sends itself. The
// server never holds a Solana key; it only reads the chain to check payments.
import { createPublicKey, verify, createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
export function b58decode(str) {
  if (typeof str !== "string" || !str) throw new TypeError("not base58");
  let n = 0n;
  for (const c of str) { const i = ALPHABET.indexOf(c); if (i < 0) throw new TypeError("not base58"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// A Solana address: base58 of 32 bytes.
export function isSolanaAddress(v) {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  try { return b58decode(v).length === 32; } catch { return false; }
}
// A transaction signature: base58 of 64 bytes.
export function isSolanaSignature(v) {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v)) return false;
  try { return b58decode(v).length === 64; } catch { return false; }
}

// Did this address's key sign this message? (ed25519, as Phantom's signMessage does.)
export function verifySolanaSignature(address, message, signature) {
  try {
    const pub = b58decode(address), sig = typeof signature === "string" ? b58decode(signature) : signature;
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig));
  } catch { return false; }
}

const Point = ed25519.ExtendedPoint ?? ed25519.Point;
const onCurve = (bytes) => { try { Point.fromHex(bytes); return true; } catch { return false; } };
// The associated token account of an owner for a mint (a program-derived address).
export function associatedTokenAccount(owner, mint = USDC_MINT) {
  const seeds = [b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(mint)];
  const program = b58decode(ATA_PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(program).update("ProgramDerivedAddress");
    const addr = new Uint8Array(h.digest());
    if (!onCurve(addr)) return b58encode(addr);
  }
  throw new Error("no associated token account address");
}

const compactU16 = (n) => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return out; } } };
const u64le = (v) => { const b = new Uint8Array(8); let n = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };

// The message of a transaction that sends `amount` (base units) of USDC from `from` to `to`:
// first make sure the recipient's USDC account exists (idempotent, a no-op when it does),
// then a checked transfer. `from` pays the fee and signs. Returns base58, as Phantom's
// signAndSendTransaction takes it.
export function usdcTransferMessage({ from, to, amount, blockhash, mint = USDC_MINT, decimals = USDC_DECIMALS }) {
  const fromAta = associatedTokenAccount(from, mint), toAta = associatedTokenAccount(to, mint);
  // Order: signer+writable, then writable, then read-only.
  const keys = [from, fromAta, toAta, to, mint, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM];
  const ix = (k) => keys.indexOf(k);
  const instructions = [
    { program: ix(ATA_PROGRAM), accounts: [ix(from), ix(toAta), ix(to), ix(mint), ix(SYSTEM_PROGRAM), ix(TOKEN_PROGRAM)], data: [1] },
    { program: ix(TOKEN_PROGRAM), accounts: [ix(fromAta), ix(mint), ix(toAta), ix(from)], data: [12, ...u64le(amount), decimals] },
  ];
  const bytes = [1, 0, 5, ...compactU16(keys.length)];
  for (const k of keys) bytes.push(...b58decode(k));
  bytes.push(...b58decode(blockhash), ...compactU16(instructions.length));
  for (const i of instructions) bytes.push(i.program, ...compactU16(i.accounts.length), ...i.accounts, ...compactU16(i.data.length), ...i.data);
  return b58encode(Uint8Array.from(bytes));
}

// How much USDC (base units) went from `payer` to `payee` in a parsed transaction,
// from the token balances before and after. Null when the payer didn't sign it.
export function usdcPaid(tx, { payer, payee, mint = USDC_MINT }) {
  if (!tx || tx.meta?.err) return null;
  const signers = (tx.transaction?.message?.accountKeys ?? []).filter((k) => k.signer).map((k) => k.pubkey);
  if (!signers.includes(payer)) return null;
  const delta = (owner) => {
    const sum = (list) => (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
    return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  };
  const received = delta(payee), sent = -delta(payer);
  return received > 0n && sent >= received ? received : 0n;
}
