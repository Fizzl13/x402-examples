// Spending mandates per agent (the x402 `authority` extension draft, x402-mandate/1,
// x402-foundation/x402#3220). The owner sets the terms on the dashboard: a total budget in USDC on
// Base, a maximum per payment, the sellers (or any), until when, and what for. The server signs them
// for the owner with an Ed25519 key of the account (derived from MANDATE_SECRET, never stored) and
// hands the signed mandate to the agent (GET /v1/mandate), whose x402 payments then carry its binding
// so presign-guard can check them. The server is also the accountant: every spend of the agent is
// held to the terms here, including the running total, which a pre-sign check alone cannot see.
// The purpose is judged per purchase by TypeSafe's Jev (src/jev-rule.js): outside it, the owner is asked.
import { createHmac, createPrivateKey, createPublicKey, sign, randomBytes } from "node:crypto";
import { parseUnits, formatUnits, isAddress, getAddress } from "viem";

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE = 8453;
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

// RFC 8785 (JCS) for the mandate object: strings and a string array.
export const jcs = (v) => (Array.isArray(v) ? `[${v.map(jcs).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`
  : JSON.stringify(v));

// The account's signing key: the same for the same secret and account, so nothing has to be stored.
export function issuerFor(secret, accountId) {
  if (!secret || secret.length < 16) return null;
  const seed = createHmac("sha256", secret).update(`fizzl-wallet-mandate/1:${accountId}`).digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key).export({ format: "jwk" }).x;
  return { publicKey, sign: (bytes) => sign(null, bytes, key).toString("base64url") };
}

const usd = (v, field) => {
  const s = String(v ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s) || Number(s) <= 0) throw Object.assign(new Error(`${field}: an amount in USDC, e.g. 5 or 0.25`), { status: 400 });
  return parseUnits(s, 6).toString();
};

// Terms as the owner set them -> what is kept on the agent. Throws a 400 for anything off.
export function cleanTerms(t, { now = Date.now() } = {}) {
  if (!t || typeof t !== "object") throw Object.assign(new Error("terms required"), { status: 400 });
  const cap = usd(t.cap, "cap");
  const perPayment = t.perPayment === undefined || t.perPayment === null || t.perPayment === "" ? null : usd(t.perPayment, "perPayment");
  if (perPayment && BigInt(perPayment) > BigInt(cap)) throw Object.assign(new Error("perPayment can't be more than the total budget"), { status: 400 });
  const list = Array.isArray(t.recipients) ? t.recipients.map((r) => String(r).trim()).filter(Boolean) : [];
  if (!list.length || (list.includes("*") && list.length > 1)) throw Object.assign(new Error("recipients: seller addresses (0x…), or [\"*\"] for any seller"), { status: 400 });
  if (list.length > 20) throw Object.assign(new Error("recipients: at most 20 sellers"), { status: 400 });
  const recipients = list[0] === "*" ? ["*"] : list.map((r) => { if (!isAddress(r)) throw Object.assign(new Error(`recipients: ${r} is not an address`), { status: 400 }); return getAddress(r); });
  const days = Number(t.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw Object.assign(new Error("days: 1 to 366"), { status: 400 });
  const purpose = typeof t.purpose === "string" ? t.purpose.trim().slice(0, 200) : "";
  if (!purpose) throw Object.assign(new Error("purpose: say in a few words what the agent may spend it on"), { status: 400 });
  const notAfter = new Date(Math.floor((now + days * 86400_000) / 1000) * 1000).toISOString().replace(".000Z", "Z");
  return { cap, perPayment, recipients, notAfter, purpose, nonce: `fw-${randomBytes(9).toString("base64url")}`, createdAt: now, spent: "0" };
}

// The signed x402-mandate/1 envelope for this agent's wallet (subject).
export function signedMandate(terms, issuer, subject) {
  const mandate = {
    v: "x402-mandate/1", issuer: issuer.publicKey, subject: getAddress(subject), asset: `eip155:${BASE}/erc20:${USDC_BASE}`,
    cap: terms.cap, ...(terms.perPayment ? { perPayment: terms.perPayment } : {}), recipients: terms.recipients,
    accountant: issuer.publicKey, purpose: terms.purpose, notAfter: terms.notAfter, nonce: terms.nonce,
  };
  return { mandate, alg: "Ed25519", sig: issuer.sign(Buffer.from(`x402-mandate/1\n${jcs(mandate)}`, "utf8")) };
}

const fmt = (x) => formatUnits(BigInt(x), 6);

// Is this spend inside the mandate? items: [{ chainId, token, amount (bigint|null), to }] (limits.spendFor).
// Returns { amount } (the USDC to count) or { reason } (outside it: stopped, the owner is not asked).
export function mandateCheck(terms, items, { now = Date.now() } = {}) {
  const stop = (message) => ({ reason: { code: "mandate", message: `outside the mandate: ${message}` } });
  if (now >= Date.parse(terms.notAfter)) return stop(`it expired on ${terms.notAfter.slice(0, 10)}`);
  let total = 0n;
  for (const it of items) {
    if (it.chainId !== BASE || String(it.token).toLowerCase() !== USDC_BASE.toLowerCase()) return stop("it only covers USDC on Base");
    if (it.amount === null || it.amount === undefined) return stop("an unlimited amount");
    if (terms.recipients[0] !== "*" && !terms.recipients.some((r) => r.toLowerCase() === String(it.to).toLowerCase())) return stop(`${it.to} is not one of its sellers`);
    if (terms.perPayment && it.amount > BigInt(terms.perPayment)) return stop(`${fmt(it.amount)} USDC is over its ${fmt(terms.perPayment)} USDC per payment`);
    total += it.amount;
  }
  const left = BigInt(terms.cap) - BigInt(terms.spent ?? "0");
  if (total > left) return stop(`${fmt(total)} USDC is more than the ${fmt(left > 0n ? left : 0n)} USDC left of its ${fmt(terms.cap)} USDC`);
  return { amount: total };
}

// What the dashboard shows.
export const publicTerms = (t) => (t ? {
  cap: fmt(t.cap), perPayment: t.perPayment ? fmt(t.perPayment) : null, recipients: t.recipients, notAfter: t.notAfter,
  purpose: t.purpose, spent: fmt(t.spent ?? "0"), left: fmt(BigInt(t.cap) > BigInt(t.spent ?? "0") ? BigInt(t.cap) - BigInt(t.spent ?? "0") : 0n),
  expired: Date.now() >= Date.parse(t.notAfter),
} : null);
