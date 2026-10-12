// presign-guard-payer-screen: screen who pays your x402 API against the OFAC SDN list, before the payment settles.
//
// An Express middleware for sellers, placed before the x402 payment middleware: it reads the payer from the payment
// header (EVM EIP-3009 or Permit2, Solana, Algorand, XRP Ledger), looks the address up in the OFAC SDN list, and
// answers 451 Unavailable For Legal Reasons for a listed payer, so the payment is never settled and the money never
// arrives. Everyone else goes straight on.
//
// The list is presign-guard's free open copy of the US Treasury's SDN digital currency addresses
// (https://presign-guard.fizzl.eu/v1/sanctions), downloaded once and refreshed every 6 hours; each payment is
// screened in memory, with no call and no cost. No dependencies.
import { createHash } from "node:crypto";

export const VERSION = "0.1.0";
export const LIST_URL = "https://presign-guard.fizzl.eu/v1/sanctions";
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

// ---------- the payer of an x402 payment ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const XRPL_B58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
function base58(bytes, alphabet = B58) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = alphabet[0] + s; }
  return s;
}
const sha256 = (b) => createHash("sha256").update(b).digest();

// Solana (x402 exact): the transfer authority, signer #2 after the facilitator's fee payer.
function solanaPayer(base64Tx) {
  const b = Buffer.from(base64Tx, "base64");
  let o = 0;
  const compact = () => { let v = 0, shift = 0, byte; do { byte = b[o++]; v |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80); return v; };
  const signatures = compact(); // compact() moves o itself, so not "o += 64 * compact()"
  o += 64 * signatures;
  if (b[o] & 0x80) o++; // versioned message prefix
  const required = b[o];
  o += 3;
  const keys = compact();
  if (required < 2 || keys < 2 || b.length < o + 64) return null;
  return base58(b.subarray(o + 32, o + 64));
}

// A minimal MessagePack reader, enough for an Algorand transaction (maps, strings, bytes, numbers, arrays, booleans).
function msgpack(buf) {
  let o = 0;
  const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[o++]; return v; };
  const read = () => {
    const t = buf[o++];
    if (t === undefined) throw new Error("truncated");
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if ((t & 0xf0) === 0x80) return map(t & 0x0f);
    if ((t & 0xf0) === 0x90) return arr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u(1));
      case 0xc5: return bin(u(2));
      case 0xc6: return bin(u(4));
      case 0xcc: return u(1);
      case 0xcd: return u(2);
      case 0xce: return u(4);
      case 0xcf: return u(8);
      case 0xd0: return u(1);
      case 0xd1: return u(2);
      case 0xd2: return u(4);
      case 0xd3: return u(8);
      case 0xd9: return str(u(1));
      case 0xda: return str(u(2));
      case 0xdc: return arr(u(2));
      case 0xde: return map(u(2));
      default: throw new Error(`msgpack type 0x${t.toString(16)}`);
    }
  };
  const bin = (n) => { const v = buf.subarray(o, o + n); o += n; return v; };
  const str = (n) => bin(n).toString("utf8");
  const arr = (n) => Array.from({ length: n }, read);
  const map = (n) => { const m = {}; for (let i = 0; i < n; i++) { const k = read(); m[k] = read(); } return m; };
  return read();
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function algorandAddress(pk) {
  const bytes = Buffer.concat([pk, createHash("sha512-256").update(pk).digest().subarray(28)]);
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Algorand (x402 exact): the sender of the payment transaction in the group (signed: { sig, txn }, else the txn).
function algorandPayer(payload) {
  const raw = payload.paymentGroup?.[payload.paymentIndex];
  if (typeof raw !== "string") return null;
  const m = msgpack(Buffer.from(raw, "base64"));
  const snd = (m?.txn ?? m)?.snd;
  return Buffer.isBuffer(snd) && snd.length === 32 ? algorandAddress(snd) : null;
}

// XRP Ledger (x402 exact): the Account field of the signed transaction blob. Fields come in canonical order (by
// type, then field), so Account (AccountID type 8, field 1) is reached after the fixed-size, amount and blob fields.
function xrplPayer(hex) {
  const b = Buffer.from(hex, "hex");
  let o = 0;
  const vl = () => { const a = b[o++]; if (a <= 192) return a; if (a <= 240) return 193 + (a - 193) * 256 + b[o++]; return 12481 + (a - 241) * 65536 + b[o++] * 256 + b[o++]; };
  while (o < b.length) {
    const h = b[o++];
    let type = h >> 4, field = h & 0x0f;
    if (type === 0) type = b[o++];
    if (field === 0) field = b[o++];
    if (type === 8) {
      const n = vl();
      if (field === 1 && n === 20) {
        const body = Buffer.concat([Buffer.from([0]), b.subarray(o, o + 20)]);
        return base58(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]), XRPL_B58);
      }
      o += n;
      continue;
    }
    const size = { 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 16: 1, 17: 20 }[type];
    if (size) { o += size; continue; }
    if (type === 6) { o += b[o] & 0x80 ? 48 : 8; continue; } // Amount: XRP (8 bytes) or a token (48)
    if (type === 7) { const n = vl(); o += n; continue; } // Blob (vl() moves o itself, so not "o += vl()")
    return null; // objects and arrays come after Account; something unexpected
  }
  return null;
}

/**
 * The payer of an x402 payment: the decoded PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) header, or the object.
 * @returns {{ payer: string, network: string|null, kind: "eip3009"|"permit2"|"solana"|"algorand"|"xrpl" } | null}
 */
export function payerOf(header) {
  let p = header;
  try {
    if (typeof header === "string") p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const payload = p?.payload;
  if (!payload || typeof payload !== "object") return null;
  const network = (p.accepted ?? p).network ?? null;
  try {
    if (payload.authorization?.from) return { payer: String(payload.authorization.from), network, kind: "eip3009" };
    if (payload.permit2Authorization?.from) return { payer: String(payload.permit2Authorization.from), network, kind: "permit2" };
    if (typeof payload.transaction === "string") { const payer = solanaPayer(payload.transaction); return payer && { payer, network, kind: "solana" }; }
    if (Array.isArray(payload.paymentGroup)) { const payer = algorandPayer(payload); return payer && { payer, network, kind: "algorand" }; }
    if (typeof payload.signedTxBlob === "string") { const payer = xrplPayer(payload.signedTxBlob); return payer && { payer, network, kind: "xrpl" }; }
  } catch {
    return null;
  }
  return null;
}

// ---------- the list ----------

// The lookup key: EVM and bech32 addresses are case-insensitive, the rest are not (as in presign-guard).
export function addressKey(address) {
  const a = String(address).trim();
  return /^0x[0-9a-f]{40}$/i.test(a) || /^(bc1|ltc1|tb1)[0-9a-z]+$/i.test(a) ? a.toLowerCase() : a;
}

/**
 * A screen over the OFAC SDN list. `list` (the JSON of /v1/sanctions) skips the download, e.g. in tests.
 */
export function createScreen({ listUrl = LIST_URL, refreshMs = REFRESH_MS, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20000, list = null, now = () => Date.now() } = {}) {
  let state = null; // { index: Map, published, checkedAt, count, loadedAt }
  let loading = null;
  let lastAttempt = -Infinity;
  let lastError = null;
  const use = (body) => {
    if (!body || !Array.isArray(body.addresses)) throw new Error("not a sanctions list");
    const index = new Map(body.addresses.map((a) => [addressKey(a.address), a.entries ?? []]));
    state = { index, published: body.published ?? null, checkedAt: body.checkedAt ?? null, count: index.size, loadedAt: now() };
    lastError = null;
  };
  if (list) use(list);
  const load = () => {
    if (loading) return loading;
    lastAttempt = now();
    loading = (async () => {
      try {
        const res = await fetchImpl(listUrl, { headers: { accept: "application/json", "user-agent": `presign-guard-payer-screen/${VERSION}` }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        use(await res.json());
      } catch (err) {
        lastError = String(err?.message ?? err).slice(0, 160);
      }
      return state;
    })().finally(() => { loading = null; });
    return loading;
  };
  // The list, loading it the first time, refreshing it when it is older than refreshMs (in the background while an
  // older list is still there), and trying again at most once a minute while it can't be had.
  const ready = async () => {
    const stale = state && now() - state.loadedAt > refreshMs && now() - lastAttempt > RETRY_MS;
    if (stale) load();
    if (state) return state;
    if (loading) return loading;
    return now() - lastAttempt > RETRY_MS ? load() : null;
  };
  return {
    ready,
    /** { listed, entries, published } for an address, or null when no list is loaded. */
    check(address) {
      if (!state) return null;
      const entries = state.index.get(addressKey(address)) ?? [];
      return { listed: entries.length > 0, entries, published: state.published };
    },
    status: () => (state ? { addresses: state.count, published: state.published, checkedAt: state.checkedAt, ...(lastError && { lastError }) } : { addresses: 0, ...(lastError && { lastError }) }),
  };
}

/**
 * Screen one payment header: { blocked, payer, network, kind, entries, published } once a list is loaded, { blocked:
 * false, unscreened: reason } when there is no payer to read or no list. For frameworks other than Express.
 */
export async function checkPayment(header, screen) {
  if (!header) return { blocked: false, unscreened: "no_payment" };
  const who = payerOf(header);
  if (!who) return { blocked: false, unscreened: "payer_unreadable" };
  if (!(await screen.ready())) return { blocked: false, unscreened: "list_unavailable", ...who };
  const hit = screen.check(who.payer);
  return { blocked: hit.listed, ...who, entries: hit.entries, published: hit.published };
}

/**
 * Express middleware: put it before the x402 payment middleware.
 * @param {object} [options]
 * @param {boolean} [options.failClosed] answer 503 while no list can be loaded (default: let payments through)
 * @param {(info: object, req: any) => void} [options.onBlocked] called for every payment it refuses
 * @param {string} [options.listUrl] @param {number} [options.refreshMs] @param {typeof fetch} [options.fetch] @param {object} [options.list]
 */
export function screenPayers({ failClosed = false, onBlocked, ...options } = {}) {
  const screen = options.screen ?? createScreen(options);
  let warned = false;
  const middleware = async (req, res, next) => {
    const header = req.headers?.["payment-signature"] ?? req.headers?.["x-payment"];
    if (!header) return next();
    try {
      const r = await checkPayment(String(header), screen);
      if (r.unscreened === "list_unavailable") {
        if (!warned) { warned = true; console.warn(`[presign-guard-payer-screen] OFAC list unavailable (${screen.status().lastError ?? "loading"}); ${failClosed ? "refusing payments" : "payments go through unscreened"}`); }
        if (failClosed) {
          res.setHeader("Retry-After", "60");
          return res.status(503).json({ error: "screen_unavailable", message: "Payments can't be screened right now; try again in a minute" });
        }
        return next();
      }
      warned = false;
      if (!r.blocked) return next();
      const info = { payer: r.payer, network: r.network, kind: r.kind, list: "OFAC SDN", entries: r.entries.map(({ name, programs }) => ({ name, programs })), published: r.published };
      try { onBlocked?.(info, req); } catch { /* a logging hook must not break the answer */ }
      return res.status(451).json({ error: "payer_sanctioned", message: "This payment comes from an address on the OFAC SDN sanctions list; it was not accepted and nothing was charged.", ...info });
    } catch (err) {
      return next(err);
    }
  };
  middleware.screen = screen;
  return middleware;
}
