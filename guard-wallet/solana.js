// Solana for the guarded wallet: just enough to read a transaction message (legacy or v0, as x402's SVM client
// hands it to the signer) and to write addresses, without a Solana SDK.

// x402 network ids and the USDC mint on each.
export const SOLANA_USDC = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet
};
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const TRANSFER_CHECKED = 12;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

// A Solana message: its signer count, static account keys and instructions (program, accounts, data).
// Accounts that come from an address lookup table are null.
export function readSolanaMessage(messageBytes) {
  const b = messageBytes instanceof Uint8Array ? messageBytes : new Uint8Array(messageBytes);
  let i = 0;
  const need = (n) => { if (i + n > b.length) throw new Error("message too short"); };
  const shortvec = () => { let v = 0, shift = 0; for (;;) { need(1); const x = b[i++]; v |= (x & 0x7f) << shift; if (!(x & 0x80)) return v; shift += 7; if (shift > 14) throw new Error("bad length"); } };
  const bytes = (n) => { need(n); const s = b.subarray(i, i + n); i += n; return s; };
  need(1);
  const versioned = (b[0] & 0x80) !== 0;
  if (versioned) { if ((b[0] & 0x7f) !== 0) throw new Error(`message version ${b[0] & 0x7f} not supported`); i += 1; }
  const [numSigners] = bytes(3);
  const keys = Array.from({ length: shortvec() }, () => base58(bytes(32)));
  bytes(32); // recent blockhash or durable nonce
  const instructions = Array.from({ length: shortvec() }, () => {
    const [programIndex] = bytes(1);
    const accounts = Array.from(bytes(shortvec())).map((k) => keys[k] ?? null);
    const data = bytes(shortvec());
    return { program: keys[programIndex] ?? null, accounts, data };
  });
  let lookups = 0;
  if (versioned) { lookups = shortvec(); for (let l = 0; l < lookups; l++) { bytes(32); bytes(shortvec()); bytes(shortvec()); } }
  if (i !== b.length) throw new Error("trailing bytes");
  return { numSigners, keys, instructions, lookups };
}

// The base64 wire transaction for a message, with empty signatures (what presign-guard's check reads).
export function wireTransaction(messageBytes, numSigners) {
  const n = numSigners;
  const head = n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7];
  return Buffer.concat([Buffer.from(head), Buffer.alloc(64 * n), Buffer.from(messageBytes)]).toString("base64");
}

// An x402 payment as the SVM client builds it: compute-budget settings, one USDC TransferChecked from `owner`, and
// a memo. Returns { mint, amount, source, destination }, or throws with why it is something else.
export function readSolanaPayment(messageBytes, owner, network) {
  const usdc = SOLANA_USDC[network];
  const msg = readSolanaMessage(messageBytes);
  const transfers = [];
  for (const ix of msg.instructions) {
    if (ix.program === COMPUTE_BUDGET || MEMO.has(ix.program)) continue;
    if (TOKEN_PROGRAMS.has(ix.program) && ix.data[0] === TRANSFER_CHECKED && ix.data.length >= 10) { transfers.push(ix); continue; }
    throw new Error(`it calls ${ix.program ?? "a program from a lookup table"}, not only a USDC transfer`);
  }
  if (transfers.length !== 1) throw new Error(`it has ${transfers.length} token transfers, not one`);
  const [source, mint, destination, authority] = transfers[0].accounts;
  if (authority !== owner) throw new Error("the transfer is not signed by this account");
  if (mint !== usdc) throw new Error(`token ${mint} is not USDC (${usdc})`);
  if (!destination) throw new Error("the receiver comes from a lookup table");
  const d = transfers[0].data;
  const amount = new DataView(d.buffer, d.byteOffset).getBigUint64(1, true);
  return { mint, amount, source, destination, numSigners: msg.numSigners };
}
