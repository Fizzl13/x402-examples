// Algorand for the guarded wallet: just enough to read an unsigned transaction (msgpack, as x402's AVM
// client hands them to the signer) and to write addresses, without an Algorand SDK.
import { createHash } from "node:crypto";

// x402 network ids and the USDC asset (ASA) on each.
export const ALGORAND_USDC = {
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": 31566704n, // mainnet
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=": 10458941n, // testnet
};

// A small msgpack decoder: maps, strings, binary, integers (as BigInt above 2^53), booleans, nil, arrays.
export function msgpackDecode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const str = (n) => { const s = new TextDecoder().decode(b.subarray(i, i + n)); i += n; return s; };
  const bin = (n) => { const s = b.slice(i, i + n); i += n; return s; };
  const map = (n) => { const o = {}; for (let k = 0; k < n; k++) { const key = read(); o[String(key)] = read(); } return o; };
  const arr = (n) => { const a = []; for (let k = 0; k < n; k++) a.push(read()); return a; };
  const u64 = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
  function read() {
    if (i >= b.length) throw new Error("msgpack: unexpected end");
    const t = b[i++];
    if (t <= 0x7f) return t;
    if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f);
    if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f);
    if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
    if (t >= 0xe0) return t - 0x100;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { const n = b[i]; i += 1; return bin(n); }
      case 0xc5: { const n = dv.getUint16(i); i += 2; return bin(n); }
      case 0xc6: { const n = dv.getUint32(i); i += 4; return bin(n); }
      case 0xcc: return b[i++];
      case 0xcd: { const v = dv.getUint16(i); i += 2; return v; }
      case 0xce: { const v = dv.getUint32(i); i += 4; return v; }
      case 0xcf: { const v = dv.getBigUint64(i); i += 8; return u64(v); }
      case 0xd0: { const v = dv.getInt8(i); i += 1; return v; }
      case 0xd1: { const v = dv.getInt16(i); i += 2; return v; }
      case 0xd2: { const v = dv.getInt32(i); i += 4; return v; }
      case 0xd3: { const v = dv.getBigInt64(i); i += 8; return u64(v); }
      case 0xd9: { const n = b[i]; i += 1; return str(n); }
      case 0xda: { const n = dv.getUint16(i); i += 2; return str(n); }
      case 0xdb: { const n = dv.getUint32(i); i += 4; return str(n); }
      case 0xdc: { const n = dv.getUint16(i); i += 2; return arr(n); }
      case 0xdd: { const n = dv.getUint32(i); i += 4; return arr(n); }
      case 0xde: { const n = dv.getUint16(i); i += 2; return map(n); }
      case 0xdf: { const n = dv.getUint32(i); i += 4; return map(n); }
      default: throw new Error(`msgpack: type 0x${t.toString(16)} not supported`);
    }
  }
  const out = read();
  if (i !== b.length) throw new Error("msgpack: trailing bytes");
  return out;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// An Algorand address from a 32-byte public key: base32 of the key and a 4-byte checksum.
export function algorandAddress(pub) {
  const raw = Buffer.concat([Buffer.from(pub), createHash("sha512-256").update(pub).digest().subarray(28)]);
  let bits = 0, v = 0, out = "";
  for (const byte of raw) { v = (v << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(v << (5 - bits)) & 31];
  return out;
}

// An unsigned transaction's fields that matter for spending, as plain values (addresses as strings).
export function readAlgorandTxn(bytes) {
  const t = msgpackDecode(bytes);
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("not an Algorand transaction");
  const addr = (v) => (v instanceof Uint8Array && v.length === 32 ? algorandAddress(v) : null);
  return {
    type: t.type ?? null,
    sender: addr(t.snd),
    receiver: addr(t.arcv) ?? addr(t.rcv),
    amount: BigInt(t.aamt ?? t.amt ?? 0),
    assetId: t.xaid === undefined ? null : BigInt(t.xaid),
    closeTo: addr(t.aclose) ?? addr(t.close),
    rekeyTo: addr(t.rekey),
    clawbackFrom: addr(t.asnd),
    fee: BigInt(t.fee ?? 0),
  };
}
