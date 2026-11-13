// x402-safe-fetch: a fetch for agents that checks an unknown x402 endpoint
// before paying it.
//
// A free endpoint is answered as is. For a paid one (HTTP 402), the agent first
// pays $0.001 for an x402 Doctor preflight and acts on it:
//   no_go   → throws SafePayError (the payment would fail, is over budget, or
//             should not be made); the endpoint is not paid
//   caution → onCaution: "stop" (default, throws), "pay", or your own async
//             function that decides (e.g. ask the user)
//   go      → pays the endpoint, never more than maxUsd
// Trusted hosts skip the preflight. A verdict is reused while the endpoint's 402 offers the same thing
// (up to an hour); a changed price, payout address, token or network is checked again at once.
// With diagnoseOnFailure, a payment that still fails (the endpoint answers 402
// again, or paying throws) gets a $0.01 Doctor diagnosis that says why and how
// to fix it: onDiagnosis(report), diagnosisOf(response) or error.diagnosis.
// With shareOutcomes, after paying it tells Doctor what happened (paid_ok,
// paid_failed, paid_error), with the signed preflight as proof, so later
// preflights for that endpoint learn from what agents ran into. When it does
// not pay (no_go, or a caution it stops at), it reports "refused" with the
// preflight's reason code, so the seller learns why nobody pays (Doctor shows
// sellers the counts per reason, never who). Off by default; no keys, amounts
// or response content are sent.
// With tellSellers, a refusal also goes to the seller itself when its 402 names a refusal url on its own site (the
// draft refusal extension, x402-foundation/x402#4087): the ready report from Doctor's preflight (reason code and the
// hash of the refused offer; no query, no keys, nothing about the buyer or this client), once a day per endpoint and
// reason. A screening_hit isn't sent: the draft takes it only signed. Off by default.
// A paid request answered without delivery (an error, or another 402) is never paid again on its own: the same
// endpoint (method, origin and path; any query or body) within paidErrorMs throws SafePayError code
// "paid_no_delivery" (onPaidError "stop", the default). The most common loss in the agent exam (exam.fizzl.eu) was paying again after a seller took the payment
// and answered with an error; a preflight can't see that, it only reads the 402 before paying (paid-guard.js).
// Every preflight must carry Doctor's signed receipt for exactly this request
// (endpoint, method, budget, network), checked against Doctor's pinned signer:
// a missing, changed or forged verdict is never a payment (receipt.js).
//
// Payments use @x402/fetch with the schemes you register (your keys stay in
// your code): register: (client) => client.register("eip155:8453", new ExactEvmScheme(account))
// On Algorand (USDC), the XRP Ledger (RLUSD), Stellar (USDC) and X Layer (USD₮0 or USDC) only the dollar
// stablecoin is paid.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { verifyReceipt, DOCTOR_SIGNERS, AUTHORITY } from "./receipt.js";
import { createPaidGuard, paidTwiceMessage, errorInAnswer, pendingInAnswer, PAID_ERROR_MS } from "./paid-guard.js";

export { createPaidGuard, purchaseKey, paidTwiceMessage, errorInAnswer, pendingInAnswer, PAID_ERROR_MS } from "./paid-guard.js";
export { verifyReceipt, recoverSigner, canonicalJson, inputHash, certMessage, DOCTOR_SIGNERS, AUTHORITY } from "./receipt.js";

export const DOCTOR_URL = "https://x402-doctor.fizzl.eu";
export const PREFLIGHT_CAP = "$0.002"; // the preflight costs $0.001; never more than twice that
export const DIAGNOSE_CAP = "$0.02"; // the diagnosis costs $0.01; never more than twice that
export const PRESIGN_GUARD_URL = "https://presign-guard.fizzl.eu";
export const INJECTION_CAP = "$0.02"; // presign-guard's injection check costs $0.01; never more than twice that
// The header a checked answer carries: green, orange, red (only with onInjection "flag" or a function) or unchecked.
export const ANSWER_CHECK_HEADER = "x-answer-check";
export const VERSION = "0.20.11";
// Doctor sees which calls come from this package (in its usage counts), nothing more.
const DOCTOR_HEADERS = { accept: "application/json", "user-agent": `x402-safe-fetch/${VERSION}` };
export const BASE = "eip155:8453";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const ALGORAND = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const ALGORAND_TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export const XRPL = "xrpl:0";
export const XRPL_TESTNET = "xrpl:1";
export const STELLAR = "stellar:pubnet";
export const STELLAR_TESTNET = "stellar:testnet";
export const XLAYER = "eip155:196";
const NETWORK_ALIASES = { base: BASE, solana: SOLANA, algorand: ALGORAND, "algorand-testnet": ALGORAND_TESTNET, xrpl: XRPL, "xrpl-testnet": XRPL_TESTNET, stellar: STELLAR, "stellar-testnet": STELLAR_TESTNET, xlayer: XLAYER };

// On Algorand and the XRP Ledger only the dollar stablecoin is paid: USDC (an ASA) on Algorand, RLUSD from
// Ripple's issuer on the XRP Ledger. Never ALGO, XRP or another token, so the dollar budget always holds.
const ALGORAND_USDC = { [algorandId(ALGORAND)]: "31566704", [algorandId(ALGORAND_TESTNET)]: "10458941" };
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const RLUSD_ISSUER = { [XRPL]: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", [XRPL_TESTNET]: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
// On Stellar only Circle's USDC token contract (7 decimals), never XLM or another token named USDC.
const STELLAR_USDC = { [STELLAR]: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", [STELLAR_TESTNET]: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" };
// On X Layer only USD₮0 (what most sellers there ask for) and the USDC x402 Doctor checks against (both 6 decimals,
// EIP-3009), never OKB or another token that calls itself USDC. @x402/evm has no default asset there, so x402's
// spend controls only let these through with an allowedAssets entry, capped at the budget (see safeFetch).
const XLAYER_DOLLARS = {
  [XLAYER]: ["0x779ded0c9e1022225f8e0630b35a9b54be713736", "0x74b7f16337b8972027f6196a17a631ac6de26d22"],
};

// Algorand by its CAIP-2 id: the first 32 characters of the genesis hash. Sellers name it either way (the whole hash,
// or since @x402/avm 2.29.0 only the short id), so networks are compared by this.
function algorandId(network) {
  return typeof network === "string" && network.startsWith("algorand:") ? network.slice(0, 41) : network;
}

// @x402/avm 2.29.0's ExactAvmScheme refuses the whole-hash form, which most Algorand sellers still use (2.28.0 took
// both). This hands the scheme the short id; the payment still names the seller's own network (x402 puts the
// seller's option in `accepted`), so either kind of seller can be paid. createSafeFetch wraps Algorand schemes in it.
export function anyAlgorandId(scheme) {
  return Object.assign(Object.create(scheme), {
    createPaymentPayload: (version, requirements, context) =>
      scheme.createPaymentPayload(version, { ...requirements, network: algorandId(requirements.network) }, context),
    ...(typeof scheme.findDefaultAsset === "function" && { findDefaultAsset: (asset, network) => scheme.findDefaultAsset(asset, algorandId(network)) }),
  });
}

// The option to pay on `network`, or null. RLUSD prices are decimal dollars ("0.001", and "2" is two dollars),
// which x402's spend controls would read as base units, so the budget is checked here in dollars.
// What a 402 offers, as a stable string: per x402 option its scheme, network, asset, amount and payout address
// (not extra: invoices and nonces change per request). null when there is no x402 challenge to read (e.g. an
// MPP-only 402). Reads and consumes the response body.
export async function offerFingerprint(res) {
  return (await readOffer(res)).fingerprint;
}
// The 402's x402 options and their fingerprint (see offerFingerprint). Reads and consumes the response body.
export async function readOffer(res) {
  let challenge = null;
  const header = res?.headers?.get?.("payment-required");
  if (header) {
    try { challenge = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0)))); } catch { /* not base64 JSON */ }
    try { await res.body?.cancel(); } catch { /* already consumed */ }
  } else {
    try { challenge = JSON.parse(await res.text()); } catch { /* not JSON */ }
  }
  if (!Array.isArray(challenge?.accepts)) return { fingerprint: null, accepts: null };
  const parts = challenge.accepts.map((a) => JSON.stringify([a?.scheme ?? null, a?.network ?? null, String(a?.asset ?? ""), String(a?.amount ?? a?.maxAmountRequired ?? ""), String(a?.payTo ?? "")]));
  return { fingerprint: JSON.stringify(parts.sort()), accepts: challenge.accepts };
}

// A 402 as safe-fetch read it, to hand to x402 again (0.20.7): status, headers and body. With the challenge in the
// PAYMENT-REQUIRED header the body is not read, as readOffer doesn't read it.
async function keep402(res) {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  let body = "";
  if (headers.has("payment-required")) {
    try { await res.body?.cancel(); } catch { /* already consumed */ }
  } else {
    try { body = await res.text(); } catch { /* unreadable: an empty body */ }
  }
  return { status: res.status, statusText: res.statusText, headers: [...headers], body };
}
const replayOf = (kept) => new Response(kept.body || null, { status: kept.status, statusText: kept.statusText, headers: kept.headers });
// "METHOD url", with the URL as fetch writes it (x402 asks with a Request, whose URL is normalised).
function replayKey(url, method) {
  let href = String(url);
  try { href = new URL(href).href; } catch { /* kept as given */ }
  return `${String(method ?? "GET").toUpperCase()} ${href}`;
}

// A paid JSON answer is read for an error report up to this size; a larger one is data.
const ERROR_SNIFF_BYTES = 64 * 1024;

// What an option paid on `network` costs in US dollars, or null when it can't be read: RLUSD amounts are decimal
// dollars, Circle's USDC on Stellar has 7 decimals, and every other token safe-fetch pays (USDC, USD₮0) has 6.
export function usdOfOption(option, network) {
  if (isLightning(network) || isLightning(option?.network)) return null; // millisatoshis: a BTC price, not dollars
  const raw = String(option?.amount ?? option?.maxAmountRequired ?? "");
  if (RLUSD_ISSUER[network]) return /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : null;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw) / (STELLAR_USDC[network] ? 1e7 : 1e6);
}
// Without an offer to compare (no readable x402 challenge), a verdict is reused for at most 10 minutes.
const UNREAD_OFFER_MS = 10 * 60 * 1000;

// Bitcoin Lightning (x402 "exact" on lnbtc: a BOLT11 invoice, priced in millisatoshis). Not paid by safe-fetch: the
// budget is in dollars and x402's spend controls have no dollar token there, so neither cap would hold.
export const LIGHTNING_UNSUPPORTED = "Bitcoin Lightning (lnbtc) isn't paid by x402-safe-fetch: its price is in BTC, so the dollar budget can't hold. Pay a USDC option on another network, or check the endpoint with x402 Doctor (it checks Lightning invoices) and pay with your Lightning client.";
function isLightning(network) {
  return String(network ?? "").startsWith("lnbtc:");
}

// The same payout address or token: EVM addresses in any letter case, everything else (Solana, Stellar, ...) exactly.
function sameAddress(x, y) {
  const a = String(x ?? "");
  const b = String(y ?? "");
  return /^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function payableOption(accepts, network, maxUsd) {
  if (isLightning(network)) return null;
  const cap = Number(String(maxUsd).replace(/^\$/, ""));
  const on = (accepts ?? []).filter((a) => algorandId(a?.network) === algorandId(network));
  const usdc = ALGORAND_USDC[algorandId(network)];
  if (usdc) return on.find((a) => String(a.asset) === usdc) ?? null;
  // x402's spend controls cap Stellar USDC too; the budget is checked here as well, in dollars.
  if (STELLAR_USDC[network]) {
    return on.find((a) => a.asset === STELLAR_USDC[network] && /^\d+$/.test(String(a.amount)) && Number(a.amount) > 0 && Number(a.amount) / 1e7 <= cap) ?? null;
  }
  if (XLAYER_DOLLARS[network]) {
    return on.find((a) => XLAYER_DOLLARS[network].includes(String(a.asset ?? "").toLowerCase())
      && /^\d+$/.test(String(a.amount)) && Number(a.amount) > 0 && Number(a.amount) / 1e6 <= cap) ?? null;
  }
  if (RLUSD_ISSUER[network]) {
    return on.find((a) => String(a.asset ?? "").toUpperCase() === RLUSD_HEX && a.extra?.issuer === RLUSD_ISSUER[network]
      && /^\d+(\.\d+)?$/.test(String(a.amount)) && Number(a.amount) > 0 && Number(a.amount) <= cap) ?? null;
  }
  // Base and other EVM chains: "exact" first (what most clients register), then "auth-capture" (Coinbase's escrow:
  // the buyer signs once, the USDC is held and only captured when the seller delivers, e.g. Atom's domain checkout).
  // Either is paid only if your register() added its scheme, and both stay within the budget (x402's spend controls
  // read the amount, which for auth-capture is the most that can be captured). Of several options of a scheme, the
  // cheapest within the budget: a 402 that lists $0.50 before $0.01 to the same seller is paid a cent, not refused
  // (or overpaid) because the first one costs more. Only options to the same payee, in the same token, as the first
  // option of that scheme are compared (0.20.1): a cheaper option to another address, added by whoever sits between
  // the agent and the seller, steered this rule in the held-out test of 12 Nov 2026 (agent-safety-bench/HELDOUT.md
  // in Fizzl13/x402-examples), where a plain client that pays the first option was safe.
  const cheapest = (scheme) => {
    const of = on.filter((a) => a?.scheme === scheme);
    const first = of[0];
    if (!first) return undefined;
    return of
      .filter((a) => sameAddress(a.payTo, first.payTo) && sameAddress(a.asset, first.asset))
      .map((a) => ({ a, usd: usdOfOption(a, network) }))
      .filter((x) => x.usd !== null && x.usd > 0 && !(x.usd > cap + 1e-9))
      .sort((x, y) => x.usd - y.usd)[0]?.a;
  };
  return cheapest("exact") ?? cheapest("auth-capture") ?? on.find((a) => a?.scheme === "exact") ?? on.find((a) => a?.scheme === "auth-capture") ?? on[0] ?? null;
}

// The code that stopped the payment: the preflight's first reason at its verdict's level (no_go, then caution), as
// Doctor accepts it (a-z, 0-9, _); the verdict itself when there is none.
export function refusalReason(preflight) {
  const reasons = Array.isArray(preflight?.reasons) ? preflight.reasons : [];
  const pick = reasons.find((r) => r?.level === preflight?.verdict) || reasons.find((r) => r?.level === "no_go" || r?.level === "caution");
  const code = String(pick?.code || preflight?.verdict || "refused").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);
  return /^[a-z][a-z0-9_]{1,47}$/.test(code) ? code : "refused";
}

export class SafePayError extends Error {
  /** code: "no_go" | "caution" | "incomplete" | "preflight_failed" | "bad_receipt" | "no_option" | "paid_no_delivery" | "answer_lost" | "over_total_budget" | "over_seller_budget" | "answer_injection" | "other_site" */
  constructor(message, { code, preflight = null, url = null, earlier, spent, check, response } = {}) {
    super(message);
    this.name = "SafePayError";
    this.code = code;
    this.preflight = preflight;
    this.url = url;
    if (earlier) this.earlier = earlier;
    if (spent) this.spent = spent;
    if (check) this.check = check;
    if (response) this.response = response;
  }
}

// A USD budget as the spend-control string x402 expects: 0.05 → "$0.05".
export function usdCap(maxUsd) {
  const n = Number(String(maxUsd).replace(/^\$/, ""));
  if (!(n > 0) || !Number.isFinite(n)) throw new TypeError("maxUsd must be a positive number of US dollars, e.g. 0.05");
  return `$${Number(n.toFixed(6))}`;
}

// x402 spend controls for X Layer's dollars: each one allowed up to the budget in atomic units (6 decimals).
function xlayerAllowance(network, cap) {
  if (!XLAYER_DOLLARS[network]) return {};
  const atomic = String(Math.round(Number(String(cap).replace(/^\$/, "")) * 1e6));
  return { allowedAssets: XLAYER_DOLLARS[network].map((asset) => ({ network, asset, maxAmountPerPayment: atomic })) };
}

export function diagnoseUrl(target, { method = "GET", doctorUrl = DOCTOR_URL } = {}) {
  const q = new URLSearchParams({ url: target, method });
  return `${doctorUrl.replace(/\/$/, "")}/api/v1/diagnose?${q}`;
}

// The Doctor diagnosis attached to a response whose payment failed, or null.
const diagnoses = new WeakMap();
export function diagnosisOf(response) {
  return (response && diagnoses.get(response)) || null;
}

// payTo: the payout address the agent is about to pay, from the endpoint's own 402 (0.20.3). Doctor screens that address
// too and says caution (payto_not_shown) when the seller showed Doctor another one: in the held-out test of 12 Nov 2026
// (agent-safety-bench/HELDOUT.md in Fizzl13/x402-examples) a seller showed the checker a clean address and the buyer one
// on the sanctions list, and the preflight said go.
export function preflightUrl(target, { method = "GET", maxUsd, network, doctorUrl = DOCTOR_URL, payTo } = {}) {
  const q = new URLSearchParams({ url: target, method });
  if (maxUsd !== undefined) q.set("max_usd", String(maxUsd).replace(/^\$/, ""));
  if (network) q.set("network", network);
  if (typeof payTo === "string" && /^[A-Za-z0-9:._-]{20,128}$/.test(payTo)) q.set("pay_to", payTo);
  return `${doctorUrl.replace(/\/$/, "")}/api/v1/preflight?${q}`;
}

// The transaction of a paid response (PAYMENT-RESPONSE header), or null.
// What checkAnswers found in a paid answer: "green", "orange", "red", "unchecked", or null when it wasn't checked.
export function answerCheckOf(response) {
  return response?.headers?.get?.(ANSWER_CHECK_HEADER) ?? null;
}

export function receiptOf(response) {
  const header = response?.headers?.get?.("payment-response");
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}

function hostOf(value) {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function requestOf(input, init) {
  if (typeof Request !== "undefined" && input instanceof Request) {
    throw new TypeError("pass the URL and an init object, not a Request (the body is sent up to three times)");
  }
  const body = init?.body;
  if (body && typeof body === "object" && (typeof body.getReader === "function" || typeof body[Symbol.asyncIterator] === "function")) {
    throw new TypeError("use a string, Buffer or URLSearchParams body: a stream cannot be sent again after the 402");
  }
  return { url: String(input), method: String(init?.method ?? "GET").toUpperCase() };
}

// Same site: the same host, or the same last two host labels except on shared hosting and two-label country
// suffixes, where only the exact host counts (as x402 Doctor's lib/refusal.js).
const SHARED_HOSTING = new Set(["run.app", "onrender.com", "vercel.app", "netlify.app", "herokuapp.com", "workers.dev", "pages.dev", "github.io", "fly.dev", "railway.app", "replit.app", "repl.co", "web.app", "firebaseapp.com", "appspot.com", "deno.dev", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "ngrok-free.app", "ngrok.io", "trycloudflare.com", "glitch.me", "koyeb.app", "co.uk", "org.uk", "com.au", "co.jp", "com.br", "co.nz", "co.za", "com.cn", "co.in"]);
function sameSite(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const base = (h) => h.split(".").slice(-2).join(".");
  return base(x) === base(y) && !SHARED_HOSTING.has(base(x));
}

// The site behind a host or URL (0.20.6, for sites): the domain without subdomains (api.metroquote.example ->
// metroquote.example), the last three labels under a two-label country suffix (shop.example.co.uk -> example.co.uk), and
// on shared hosting (vercel.app, onrender.com, workers.dev, ...) the full host name, because each subdomain there is
// another owner. The same grouping as sameSite above and as x402 Doctor's sellers (lib/site.js there).
const COUNTRY_SUFFIX = /^(co|com|org|net|gov|ac|edu|ne|or)\.[a-z]{2}$/;
export function siteOf(value) {
  let host;
  try {
    host = new URL(String(value).includes("://") ? String(value) : `https://${value}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host || null;
  const labels = host.split(".");
  const base = labels.slice(-2).join(".");
  if (COUNTRY_SUFFIX.test(base)) return labels.slice(-3).join(".");
  return SHARED_HOSTING.has(base) ? host : base;
}

/**
 * @param {object} options
 * @param {(client: x402Client) => unknown} options.register  registers your payment schemes on a client
 * @param {string} [options.network]  the network you pay on: "base", "solana", "algorand", "xrpl", "stellar" or a CAIP-2 id (default Base)
 * @param {number|string} [options.maxUsd]  budget per endpoint call (default 0.05)
 * @param {number|string} [options.maxTotalUsd]  budget for every endpoint payment this safeFetch makes together (make
 *   one per task or session); a payment that would pass it is refused with code "over_total_budget" (default: none)
 * @param {number|string} [options.maxPerSellerUsd]  the same per seller (the endpoint's host); code "over_seller_budget"
 * @param {"stop"|"pay"|((preflight: object) => boolean|Promise<boolean>)} [options.onCaution]
 * @param {"pay"|"stop"|((preflight: object) => boolean|Promise<boolean>)} [options.onIncomplete]  a "go" whose checks_complete
 *   is false (a check that applies couldn't run): "pay" (default), "stop" throws code "incomplete", a function decides
 * @param {string[]} [options.trusted]  hosts you already trust: paid without a preflight
 * @param {string[]} [options.sites]  the sites this safeFetch may pay (hosts or URLs, e.g. the ones the user named in the
 *   task); a payment asked anywhere else is refused before the preflight with code "other_site" (default: any site)
 * @param {(preflight: object, info: {url: string, method: string, cached: boolean}) => void} [options.onPreflight]
 * @param {number} [options.cacheMs]  how long a verdict is reused while the 402 offers the same thing (default 1 hour; at most 10 minutes when the offer can't be read)
 * @param {string} [options.doctorUrl]
 * @param {"require"|"off"} [options.verifyReceipts]  check Doctor's signature on every preflight (default "require")
 * @param {string[]} [options.doctorSigners]  accepted Doctor signer addresses (default: the published signer)
 * @param {string|null} [options.authority]  wallet whose certificates also make a signer trusted (default: the Fizzl payout wallet; null to accept only doctorSigners)
 * @param {typeof fetch} [options.fetch]  the underlying fetch (default globalThis.fetch)
 * @param {boolean} [options.diagnoseOnFailure]  when a payment still fails, buy a $0.01 Doctor diagnosis of why (default false)
 * @param {(report: object, info: {url: string, method: string, status: number|null, error: Error|null}) => void} [options.onDiagnosis]
 * @param {boolean} [options.shareOutcomes]  after paying, tell Doctor whether the payment worked (default false)
 * @param {boolean} [options.tellSellers]  when not paying, tell the seller why if its 402 takes refusals (default false)
 * @param {"stop"|"pay"|((earlier: {at: number, status: number}, info: {url: string, method: string}) => boolean|Promise<boolean>)} [options.onPaidError]
 *   the same request was paid before and answered without delivering: "stop" (default) throws code "paid_no_delivery",
 *   "pay" pays again, a function decides
 * @param {number} [options.paidErrorMs]  how long such a request stays blocked (default 30 minutes)
 * @param {false|"quick"|"paid"} [options.checkAnswers]  check every paid answer for instructions aimed at your agent
 *   (prompt injection) with presign-guard before you get it: "quick" (free, verdict only, 10 an hour), "paid" ($0.01 a
 *   check, with reasons, paid with the same schemes) or false (default)
 * @param {"stop"|"flag"|((check: object, info: {url: string, method: string}) => boolean|Promise<boolean>)} [options.onInjection]
 *   a red answer: "stop" (default) throws code "answer_injection" (the money is spent, the answer held back), "flag"
 *   returns it with x-answer-check: red, a function decides (true returns it)
 * @param {(check: object, info: {url: string, method: string}) => void} [options.onAnswerCheck]
 * @param {string} [options.injectionUrl]  presign-guard's origin (default https://presign-guard.fizzl.eu)
 * @param {(cap: string, fetch: typeof fetch) => typeof fetch} [options.createPayingFetch]  advanced/testing: a paying fetch
 *   capped at `cap`; build it on the `fetch` given, which answers the payment's first request with the checked 402
 * @param {() => number} [options.now]
 */
export function createSafeFetch({
  register,
  network = BASE,
  maxUsd = 0.05,
  maxTotalUsd,
  maxPerSellerUsd,
  onCaution = "stop",
  onIncomplete = "pay",
  trusted = [],
  sites,
  onPreflight,
  cacheMs = 60 * 60 * 1000,
  doctorUrl = DOCTOR_URL,
  verifyReceipts = "require",
  doctorSigners = DOCTOR_SIGNERS,
  authority = AUTHORITY,
  diagnoseOnFailure = false,
  onDiagnosis,
  shareOutcomes = false,
  tellSellers = false,
  onPaidError = "stop",
  paidErrorMs = PAID_ERROR_MS,
  checkAnswers = false,
  onInjection = "stop",
  onAnswerCheck,
  injectionUrl = PRESIGN_GUARD_URL,
  fetch: baseFetch = globalThis.fetch,
  createPayingFetch,
  now = Date.now,
} = {}) {
  const payNetwork = NETWORK_ALIASES[network] ?? network;
  if (isLightning(payNetwork)) throw new TypeError(LIGHTNING_UNSUPPORTED);
  const budget = usdCap(maxUsd);
  const perCall = Number(budget.slice(1));
  const totalCap = maxTotalUsd === undefined || maxTotalUsd === null ? null : Number(usdCap(maxTotalUsd).slice(1));
  const sellerCap = maxPerSellerUsd === undefined || maxPerSellerUsd === null ? null : Number(usdCap(maxPerSellerUsd).slice(1));
  const limited = totalCap !== null || sellerCap !== null;
  if (!createPayingFetch && typeof register !== "function") {
    throw new TypeError("register is required: (client) => client.register(network, scheme)");
  }
  if (!["stop", "pay"].includes(onCaution) && typeof onCaution !== "function") {
    throw new TypeError('onCaution must be "stop", "pay" or a function');
  }
  if (!["pay", "stop"].includes(onIncomplete) && typeof onIncomplete !== "function") {
    throw new TypeError('onIncomplete must be "pay", "stop" or a function');
  }
  if (!["stop", "pay"].includes(onPaidError) && typeof onPaidError !== "function") {
    throw new TypeError('onPaidError must be "stop", "pay" or a function');
  }
  if (![false, "quick", "paid"].includes(checkAnswers)) throw new TypeError('checkAnswers must be false, "quick" or "paid"');
  if (!["stop", "flag"].includes(onInjection) && typeof onInjection !== "function") {
    throw new TypeError('onInjection must be "stop", "flag" or a function');
  }
  const paidGuard = createPaidGuard({ windowMs: paidErrorMs, now });
  if (!["require", "off"].includes(verifyReceipts)) throw new TypeError('verifyReceipts must be "require" or "off"');
  const trustedHosts = new Set(trusted.map(hostOf).filter(Boolean));
  // sites (0.20.6): only these sites are paid. In held-out set 2 (12 Nov 2026) the documentation the task named listed
  // an unrelated host as the API server, and safe-fetch paid that host: nothing tied it to the seller the user meant.
  // safe-fetch can't know what the user named; the agent's harness can, and passes it here.
  if (sites !== undefined && (!Array.isArray(sites) || !sites.length || sites.some((s) => typeof s !== "string" || !siteOf(s)))) {
    throw new TypeError("sites must be a non-empty list of hosts or URLs, e.g. [\"api.example.com\"], or left out");
  }
  const allowedSites = sites ? new Set(sites.map(siteOf)) : null;

  // The 402 a payment is built from (0.20.7): the one safe-fetch read before the preflight, and whose address it sent
  // Doctor as pay_to, handed to x402 in place of a fresh one. In held-out set 3 (12 Nov 2026) a seller switched its
  // payout address right after Doctor's probe; x402 fetched the 402 again after the check and paid the new address.
  // Now the request x402 makes without a payment is answered with the checked 402, once per payment; the paid request
  // goes to the seller as before, and a seller that no longer takes the checked terms answers it with a 402 (not paid).
  const replays = new Map(); // "METHOD url" -> the checked 402s waiting for their payment, oldest first
  function replayingFetch(input, init) {
    const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const key = replayKey(req ? req.url : String(input), init?.method ?? req?.method);
    const queue = replays.get(key);
    if (queue?.length) {
      const headers = new Headers(init?.headers ?? req?.headers);
      if (!headers.has("payment-signature") && !headers.has("x-payment")) {
        const checked = queue.shift();
        if (!queue.length) replays.delete(key);
        return Promise.resolve(replayOf(checked));
      }
    }
    const sent = new Headers(init?.headers ?? req?.headers);
    if (!sent.has("payment-signature") && !sent.has("x-payment")) return baseFetch(input, init);
    // A paid request whose answer never came (0.20.10): send the same signed payment once more, never a new one. In
    // held-out set 4 (13 Nov 2026) the seller settled, then the connection dropped ("socket hang up"); the agent tried
    // again as after any dropped connection, and x402 signed and paid a second time. The same payment can't be settled
    // twice: a seller that settled it delivers or refuses it (a 402, not paid again); one that never got it (the
    // connection was refused) settles it now, once.
    const again = req ? req.clone() : null;
    return baseFetch(input, init).catch(async () => {
      try {
        const res = await baseFetch(again ?? input, init);
        sentAgain.add(res);
        return res;
      } catch (error) {
        const lost = error instanceof Error ? error : new Error(String(error));
        answerLost.add(lost);
        throw lost;
      }
    });
  }
  // Paid requests sent twice with the same payment because the first answer was lost, and those that got no answer at all.
  const sentAgain = new WeakSet();
  const answerLost = new WeakSet();
  function unqueue(key, kept) {
    const queue = replays.get(key);
    const at = queue ? queue.indexOf(kept) : -1;
    if (at >= 0) queue.splice(at, 1);
    if (queue && !queue.length) replays.delete(key);
  }

  const makePayingFetch = createPayingFetch ? (cap) => createPayingFetch(cap, replayingFetch) : ((cap) => {
    const client = new x402Client((_version, accepts) => {
      const pick = payableOption(accepts, payNetwork, cap);
      if (!pick) throw new SafePayError(`no payment option on ${payNetwork}${ALGORAND_USDC[algorandId(payNetwork)] ? " in USDC" : STELLAR_USDC[payNetwork] ? ` in USDC within ${cap}` : XLAYER_DOLLARS[payNetwork] ? ` in USD₮0 or USDC within ${cap}` : RLUSD_ISSUER[payNetwork] ? ` in RLUSD within ${cap}` : ""}`, { code: "no_option" });
      return pick;
    }).setSpendControls({ maxAmountPerPayment: cap, ...xlayerAllowance(payNetwork, cap) });
    // Algorand schemes get anyAlgorandId, so sellers with either network id can be paid.
    const registering = new Proxy(client, {
      get(target, prop) {
        if (prop === "register") {
          return (network, scheme) => {
            target.register(network, String(network).startsWith("algorand:") ? anyAlgorandId(scheme) : scheme);
            return registering;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    register(registering);
    return wrapFetchWithPayment(replayingFetch, client);
  });
  let preflightFetch;
  let endpointFetch;
  let diagnoseFetch;
  const payPreflight = (...args) => (preflightFetch ??= makePayingFetch(PREFLIGHT_CAP))(...args);
  const payDiagnose = (...args) => (diagnoseFetch ??= makePayingFetch(DIAGNOSE_CAP))(...args);
  let injectionFetch;
  const payInjection = (...args) => (injectionFetch ??= makePayingFetch(INJECTION_CAP))(...args);
  // With a total or per-seller budget, a payment is capped at what is left of it (x402's spend controls): a paying
  // fetch per cap, kept for the caps in use.
  const cappedFetches = new Map();
  const payEndpoint = (url, init, cap = budget) => {
    if (cap === budget) return (endpointFetch ??= makePayingFetch(budget))(url, init);
    if (!cappedFetches.has(cap)) {
      if (cappedFetches.size >= 50) cappedFetches.delete(cappedFetches.keys().next().value);
      cappedFetches.set(cap, makePayingFetch(cap));
    }
    return cappedFetches.get(cap)(url, init);
  };

  // What was paid (or is being paid) to sellers, for maxTotalUsd and maxPerSellerUsd, in dollars.
  const spend = { total: 0, bySeller: new Map() };
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const spentAt = (host) => spend.bySeller.get(host) ?? 0;
  function addSpend(host, usd) {
    spend.total = round6(spend.total + usd);
    spend.bySeller.set(host, round6(spentAt(host) + usd));
  }
  const spentNow = () => ({ totalUsd: spend.total, bySeller: Object.fromEntries(spend.bySeller) });
  // What one more payment to `host` may cost: the per-call budget, or less when the total or the seller's budget is
  // nearly spent. Throws when nothing is left of either, or when the price (if it can be read) is over what is left.
  // A price over the per-call budget alone is left to Doctor's preflight (over_budget) and x402's cap, as before.
  function allowance(url, host, price, callCap = perCall) {
    const totalLeft = totalCap === null ? Infinity : round6(totalCap - spend.total);
    const sellerLeft = sellerCap === null ? Infinity : round6(sellerCap - spentAt(host));
    const cap = Math.min(callCap, totalLeft, sellerLeft);
    const short = Math.min(totalLeft, sellerLeft);
    const over = short <= 0 || (price !== null && price > short + 1e-9);
    if (over) {
      const byTotal = totalLeft <= sellerLeft;
      const which = byTotal ? `the total budget ($${totalCap})` : `the budget for ${host} ($${sellerCap})`;
      const asks = price === null ? "" : `; the endpoint asks $${round6(price)}`;
      const paid = byTotal ? spend.total : spentAt(host);
      throw new SafePayError(`not paid: ${which} has $${Math.max(0, short)} left${asks} (already paid $${paid})`, {
        code: byTotal ? "over_total_budget" : "over_seller_budget", url, spent: spentNow(),
      });
    }
    return { cap, price };
  }

  const verdicts = new Map();
  // The query each preflight was bought with, for its outcome report (Doctor binds the report to that query).
  const queries = new WeakMap();
  async function preflightFor(url, method, offer, payTo, maxUsd = budget) {
    const key = `${method} ${url}`;
    const hit = verdicts.get(key);
    // An unreadable offer, or a verdict on less than usual (checks_complete false), is reused for at most 10 minutes.
    const short = offer === null || hit?.preflight?.checks_complete === false;
    const ttl = short ? Math.min(cacheMs, UNREAD_OFFER_MS) : cacheMs;
    if (hit && hit.offer === offer && hit.payTo === payTo && hit.maxUsd === maxUsd && hit.at + ttl > now()) return { preflight: hit.preflight, cached: true };
    const pfUrl = preflightUrl(url, { method, maxUsd, network: payNetwork, doctorUrl, payTo });
    const res = await payPreflight(pfUrl, { headers: DOCTOR_HEADERS });
    const preflight = await res.json().catch(() => null);
    if (!res.ok || !preflight?.verdict) {
      throw new SafePayError(`preflight failed (HTTP ${res.status}); the endpoint was not paid`, { code: "preflight_failed", preflight, url });
    }
    if (verifyReceipts === "require") {
      // Bound to this request: the query Doctor saw, as strings (see Doctor's input_sha256).
      const input = Object.fromEntries(new URL(pfUrl).searchParams);
      const check = verifyReceipt(preflight, { signers: doctorSigners, route: "GET /api/v1/preflight", input, authority, service: "x402-doctor" });
      if (!check.valid) throw new SafePayError(`preflight not trusted (${check.reason}); the endpoint was not paid`, { code: "bad_receipt", preflight, url });
    }
    queries.set(preflight, Object.fromEntries(new URL(pfUrl).searchParams));
    verdicts.set(key, { preflight, offer, payTo, maxUsd, at: now() });
    if (verdicts.size > 1000) verdicts.delete(verdicts.keys().next().value);
    return { preflight, cached: false };
  }

  // Why did a payment fail? One paid diagnosis per method and URL per cacheMs;
  // a diagnosis that fails or is not signed by Doctor is dropped, never thrown.
  const diagnosed = new Map();
  async function diagnoseFor(url, method) {
    const key = `${method} ${url}`;
    const hit = diagnosed.get(key);
    if (hit && hit.expires > now()) return hit.report;
    let report = null;
    try {
      const dUrl = diagnoseUrl(url, { method, doctorUrl });
      const res = await payDiagnose(dUrl, { headers: DOCTOR_HEADERS });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.checks) {
        const input = Object.fromEntries(new URL(dUrl).searchParams);
        const check = verifyReceipts === "require" ? verifyReceipt(body, { signers: doctorSigners, route: "GET /api/v1/diagnose", input, authority, service: "x402-doctor" }) : { valid: true };
        if (check.valid) report = body;
      }
    } catch {
      // the original outcome stands; no diagnosis
    }
    diagnosed.set(key, { report, expires: now() + cacheMs });
    if (diagnosed.size > 1000) diagnosed.delete(diagnosed.keys().next().value);
    return report;
  }

  // One outcome report per paid preflight: Doctor counts it once anyway.
  const reported = new Set();
  function sendOutcome(url, method, preflight, report) {
    if (!shareOutcomes || !preflight?.receipt?.request_id || reported.has(preflight.receipt.request_id)) return;
    reported.add(preflight.receipt.request_id);
    if (reported.size > 1000) reported.delete(reported.values().next().value);
    const query = queries.get(preflight) ?? Object.fromEntries(new URL(preflightUrl(url, { method, maxUsd: budget, network: payNetwork, doctorUrl })).searchParams);
    // Fire and forget: the report never delays or changes the answer.
    Promise.resolve()
      .then(() => baseFetch(`${doctorUrl.replace(/\/$/, "")}/api/v1/outcome`, {
        method: "POST",
        headers: { ...DOCTOR_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ ...report, preflight, query }),
      }))
      .then((r) => r?.body?.cancel?.())
      .catch(() => {});
  }
  function reportOutcome(url, method, preflight, res) {
    const outcome = errorAnswers.has(res) ? "paid_error" : res.ok ? "paid_ok" : res.status === 402 ? "paid_failed" : res.status >= 400 ? "paid_error" : null;
    if (outcome) sendOutcome(url, method, preflight, { outcome, status: res.status });
  }
  // The seller's own refusal url (tellSellers): only on the endpoint's own site, only a report about this endpoint,
  // redirects refused, once a day per endpoint and reason, fire and forget.
  const toldSellers = new Map();
  function tellSeller(url, preflight) {
    const refusal = preflight?.refusal;
    if (!tellSellers || !refusal?.url || !refusal.report) return;
    let target;
    let endpoint;
    try {
      target = new URL(refusal.url);
      endpoint = new URL(url);
    } catch {
      return;
    }
    if (target.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(target.hostname)) return;
    if (!sameSite(target.hostname, endpoint.hostname)) return;
    if (refusal.report.resource !== `${endpoint.origin}${endpoint.pathname}`) return;
    // The draft takes a screening_hit only signed, and this client holds no key to sign with.
    if (refusal.signature_required || (refusal.report.reason === "screening_hit" && !refusal.report.signature)) return;
    const key = `${refusal.report.resource} ${refusal.report.reason}`;
    if (now() - (toldSellers.get(key) ?? -Infinity) < 24 * 60 * 60 * 1000) return;
    toldSellers.set(key, now());
    if (toldSellers.size > 1000) toldSellers.delete(toldSellers.keys().next().value);
    Promise.resolve()
      .then(() => baseFetch(target.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No "by": buyers aren't grouped by the client they use.
        body: JSON.stringify(refusal.report),
        redirect: "error",
      }))
      .then((r) => r?.body?.cancel?.())
      .catch(() => {});
  }
  // Not paid after a preflight: "refused", with the reason that stopped it (the first reason at the verdict's level).
  function reportRefusal(url, method, preflight) {
    sendOutcome(url, method, preflight, { outcome: "refused", reason: refusalReason(preflight), source: "doctor" });
    tellSeller(url, preflight);
  }

  // Every endpoint payment goes through here: what it was answered with is remembered for the paid-twice guard.
  // With a total or per-seller budget, the payment is capped at what is left and counted as it starts (so parallel
  // calls can't both spend the rest), and taken back when nothing was paid (402 again, or paying threw).
  async function payAndCheck(url, init, method, offer, kept, callBudget = budget) {
    let host = null;
    let counted = 0;
    let cap = callBudget;
    if (limited) {
      host = hostOf(url);
      const callCap = Number(callBudget.slice(1));
      const option = offer?.accepts ? payableOption(offer.accepts, payNetwork, callBudget) : null;
      const allowed = allowance(url, host, option ? usdOfOption(option, payNetwork) : null, callCap);
      counted = allowed.price ?? allowed.cap; // an unreadable price counts as the most it may cost
      if (allowed.cap < callCap) cap = usdCap(allowed.cap);
      addSpend(host, counted);
    }
    const key = kept ? replayKey(url, method) : null;
    if (kept) replays.set(key, [...(replays.get(key) ?? []), kept]);
    let res;
    try {
      res = await payAndDiagnose(url, init, method, cap);
    } catch (error) {
      if (answerLost.has(error)) {
        // Paid, sent twice with the same payment, and no answer either time (0.20.10). The seller may have settled it:
        // it stays counted, and paying this endpoint again is refused for the window, like a paid error.
        const said = `${error.code ? `${error.code}: ` : ""}${error.message}`.slice(0, 160);
        paidGuard.record(url, { method, body: init.body }, 0, { failure: `no answer came back after paying (${said})` });
        throw new SafePayError(`paid ${url}, but no answer came back, also not when the same payment was sent again (${said}). The seller may have settled it, so it was not paid a second time, and paying this endpoint again is refused for ${Math.round(paidErrorMs / 60000)} minutes; ask the seller with the payment's details, or try later.`, { code: "answer_lost", url });
      }
      if (limited) addSpend(host, -counted);
      throw error;
    } finally {
      if (kept) unqueue(key, kept); // not used (e.g. a fetch that pays without asking first): never handed to another call
    }
    // A 402 to the same payment sent again after a lost answer: it may have been settled the first time, so it stays
    // counted and the endpoint is blocked (0.20.10).
    const refusedAgain = res.status === 402 && sentAgain.has(res);
    if (limited && res.status === 402 && !refusedAgain) addSpend(host, -counted);
    // Where the paid answer sent the agent: a 3xx's Location, or the URL a followed redirect ended at (0.20.2); for a 202
    // Accepted, the poll URL it names (0.20.4).
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    const landed = res.redirected && res.url && res.url !== url ? res.url : null;
    // A paid 2xx whose body is an error report is not a delivery (0.20.8).
    const failure = res.ok && res.status !== 202 ? await errorReportOf(res) : null;
    if (failure) errorAnswers.add(res);
    // A paid 2xx that only says the purchase isn't ready yet, and asks to be requested again, is held like a 202
    // (0.20.11). In held-out set 4 (13 Nov 2026) a seller answered {"status": "queued", ..., "message": "Request it again
    // in a few seconds"} and charged the request it asked for again; safe-fetch paid both.
    const queued = res.ok && res.status !== 202 && !failure ? await pendingReportOf(res) : null;
    const pollAt = res.status === 202 ? await pollUrlOf(res) : queued ? await pollUrlOf(res, { bodyOnly: true }) : null;
    paidGuard.record(url, { method, body: init.body }, res.status, { redirectedTo: location ?? landed, pollAt, queued, failure: failure ?? (refusedAgain ? "the answer to the payment was lost, and the same payment sent again was refused" : null) });
    return res;
  }
  // Paid answers whose body reports an error (for the outcome report).
  const errorAnswers = new WeakSet();
  // The error a paid JSON answer reports instead of a result (errorInAnswer), read from a copy; null for anything else.
  const errorReportOf = (res) => smallJsonVerdict(res, errorInAnswer);
  // What a JSON answer says when it only promises the result for later (pendingInAnswer); null for anything else.
  const pendingReportOf = (res) => smallJsonVerdict(res, pendingInAnswer);
  async function smallJsonVerdict(res, judge) {
    if (!/json/i.test(res.headers.get("content-type") || "")) return null;
    if (Number(res.headers.get("content-length")) > ERROR_SNIFF_BYTES) return null;
    try {
      const text = await res.clone().text();
      return text.length > ERROR_SNIFF_BYTES ? null : judge(JSON.parse(text));
    } catch {
      return null;
    }
  }
  // The poll URL of a 202 Accepted: Location, Content-Location, or poll_url / status_url / location in a JSON body. For a
  // queued 200 (bodyOnly) only the status URL its JSON names: a 200's Content-Location names the answer itself.
  async function pollUrlOf(res, { bodyOnly = false } = {}) {
    const header = bodyOnly ? null : res.headers.get("location") || res.headers.get("content-location");
    if (header) return header;
    if (!/json/i.test(res.headers.get("content-type") || "")) return null;
    try {
      const body = await res.clone().json();
      const named = bodyOnly ? [body?.status_url, body?.statusUrl, body?.poll_url, body?.pollUrl, body?.result_url, body?.resultUrl, body?.location] : [body?.poll_url, body?.status_url, body?.location, body?.links?.status];
      const found = named.find((v) => typeof v === "string" && v.length <= 2048);
      return found ?? null;
    } catch {
      return null;
    }
  }
  async function payAndDiagnose(url, init, method, cap) {
    if (!diagnoseOnFailure) return payEndpoint(url, init, cap);
    let res;
    try {
      res = await payEndpoint(url, init, cap);
    } catch (error) {
      if (error instanceof SafePayError && error.code !== "no_option") throw error;
      const report = await diagnoseFor(url, method);
      if (report) {
        try { error.diagnosis = report; } catch { /* frozen error */ }
        onDiagnosis?.(report, { url, method, status: null, error });
      }
      throw error;
    }
    if (res.status === 402) {
      const report = await diagnoseFor(url, method);
      if (report) {
        diagnoses.set(res, report);
        onDiagnosis?.(report, { url, method, status: 402, error: null });
      }
    }
    return res;
  }

  // checkAnswers: a paid answer is read by presign-guard's prompt-injection check before the agent gets it. Instructions
  // in an answer (pay another host to "unlock" the rest, ignore your user, hand over a key) are not the user's; a
  // preflight can't see them, because they arrive after the payment. Binary answers are not checked. A check that fails
  // (the free limit, an outage) leaves the answer as it is, marked "unchecked".
  //
  // What counts as binary is the bytes, not the label (0.20.5): an answer labelled application/octet-stream (or any
  // other non-text type) that is text after all (valid UTF-8, no NUL byte, at least 95% printable) is checked like
  // text. In held-out set 2 (12 Nov 2026) a paid answer labelled as a binary file told the agent to pay $0.30 at another
  // host to "unlock" it, and the label kept the check from reading it. Images, PDFs and archives still pass unread.
  const ANSWER_TYPES = /json|text|xml|html|javascript/i;
  const SNIFF_MAX_BYTES = 1024 * 1024;
  function textOf(bytes) {
    if (!bytes.length || bytes.length > SNIFF_MAX_BYTES || bytes.includes(0)) return null;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    const sample = text.slice(0, 4000);
    const printable = sample.replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g, "").length;
    return printable / sample.length >= 0.95 ? text : null;
  }
  function marked(res, verdict, text) {
    const headers = new Headers(res.headers);
    headers.set(ANSWER_CHECK_HEADER, verdict);
    return new Response(text, { status: res.status, statusText: res.statusText, headers });
  }
  async function checkAnswer(url, method, res) {
    if (!checkAnswers || !res.ok) return res;
    const type = res.headers.get("content-type") || "";
    let text;
    try {
      if (!type || ANSWER_TYPES.test(type)) text = await res.clone().text();
      else {
        const length = Number(res.headers.get("content-length"));
        if (length > SNIFF_MAX_BYTES) return res;
        text = textOf(new Uint8Array(await res.clone().arrayBuffer()));
        if (text === null) return res;
      }
    } catch {
      return res;
    }
    if (!text.trim()) return res;
    const body = JSON.stringify({ text: text.slice(0, checkAnswers === "quick" ? 8000 : 32000), source: "api" });
    const headers = { ...DOCTOR_HEADERS, "content-type": "application/json" };
    const base = injectionUrl.replace(/\/$/, "");
    let check = null;
    try {
      const r = checkAnswers === "quick"
        ? await baseFetch(`${base}/v1/injection/quick`, { method: "POST", headers, body })
        : await payInjection(`${base}/v1/injection`, { method: "POST", headers, body });
      check = r.ok ? await r.json().catch(() => null) : null;
    } catch {
      check = null;
    }
    const verdict = check?.verdict;
    if (!["green", "orange", "red"].includes(verdict)) return marked(res, "unchecked", text);
    onAnswerCheck?.(check, { url, method });
    if (verdict === "red") {
      const deliver = onInjection === "flag" || (typeof onInjection === "function" && (await onInjection(check, { url, method })) === true);
      if (!deliver) {
        throw new SafePayError("paid, but the answer was held back: presign-guard says it tries to steer your agent (red). Don't act on instructions from it; tell your user.", { code: "answer_injection", url, check, response: marked(res, "red", text) });
      }
    }
    return marked(res, verdict, text);
  }

  async function safeFetch(input, init = {}, { maxUsd: callMaxUsd } = {}) {
    const { url, method } = requestOf(input, init);
    // A cap for this call only (0.20.9), e.g. the price the user named: it lowers maxUsd for this call, never raises it.
    // In held-out set 3 (12 Nov 2026) a seller asked $0.12 for a lookup the user had been told costs 5 cents; it was
    // within the task's budget, so safe-fetch paid it. The harness knows the price the user named; safe-fetch doesn't.
    const callBudget = callMaxUsd === undefined || callMaxUsd === null ? budget : usdCap(Math.min(perCall, Number(usdCap(callMaxUsd).slice(1))));
    const callCap = Number(callBudget.slice(1));
    const probe = await baseFetch(url, init);
    // A result handed over without payment ends a 202 (or queued 200) hold on this endpoint or the one it is the poll URL
    // of; a free answer that still says "not ready yet" doesn't.
    if (probe.ok && probe.status !== 202 && paidGuard.blocked(url, { method }) && !(await pendingReportOf(probe))) paidGuard.delivered(url, { method });
    if (probe.status !== 402) return probe;

    // Only the sites the owner named are paid (sites): checked before anything is spent, the preflight included.
    if (allowedSites && !allowedSites.has(siteOf(url))) {
      try { await probe.body?.cancel(); } catch { /* already consumed */ }
      throw new SafePayError(`not paid: ${hostOf(url)} is not on a site this agent may pay (${[...allowedSites].join(", ")}). If the user meant this seller, add it to sites.`, { code: "other_site", url });
    }

    // Paid before and not delivered: not paid again (and no preflight bought) unless onPaidError says so.
    const earlier = paidGuard.blocked(url, { method, body: init.body });
    if (earlier && onPaidError !== "pay") {
      const again = typeof onPaidError === "function" && (await onPaidError(earlier, { url, method })) === true;
      if (!again) {
        try { await probe.body?.cancel(); } catch { /* already consumed */ }
        throw new SafePayError(paidTwiceMessage(url, earlier), { code: "paid_no_delivery", url, earlier });
      }
    }

    // The 402 as read: Doctor is asked about it, and it is the one x402 pays (0.20.7).
    const kept = await keep402(probe);
    const offer = await readOffer(replayOf(kept));
    // Already over the total or the seller's budget: refused before the preflight, so nothing is spent on it.
    if (limited) {
      const option = offer.accepts ? payableOption(offer.accepts, payNetwork, callBudget) : null;
      allowance(url, hostOf(url), option ? usdOfOption(option, payNetwork) : null, callCap);
    }

    if (trustedHosts.has(hostOf(url))) return checkAnswer(url, method, await payAndCheck(url, init, method, offer, kept, callBudget));

    // The address it would pay, from this 402, goes with the preflight (pay_to): Doctor screens that one too.
    const paying = offer.accepts ? payableOption(offer.accepts, payNetwork, callBudget) : null;
    const { preflight, cached } = await preflightFor(url, method, offer.fingerprint, typeof paying?.payTo === "string" ? paying.payTo : undefined, callBudget);
    const payAfterPreflight = async () => {
      const res = await payAndCheck(url, init, method, offer, kept, callBudget);
      reportOutcome(url, method, preflight, res);
      return checkAnswer(url, method, res);
    };
    onPreflight?.(preflight, { url, method, cached });
    const why = preflight.summary || preflight.verdict;
    if (preflight.verdict === "no_go") {
      reportRefusal(url, method, preflight);
      throw new SafePayError(`not paid: ${why}`, { code: "no_go", preflight, url });
    }
    if (preflight.verdict === "caution") {
      const ok = onCaution === "pay" || (typeof onCaution === "function" && (await onCaution(preflight)) === true);
      if (!ok) {
        reportRefusal(url, method, preflight);
        throw new SafePayError(`not paid (caution): ${why}`, { code: "caution", preflight, url });
      }
    } else if (preflight.verdict !== "go") {
      throw new SafePayError(`not paid: unknown verdict ${preflight.verdict}`, { code: "preflight_failed", preflight, url });
    } else if (preflight.checks_complete === false && onIncomplete !== "pay") {
      // "go" on less than usual: a check that applies couldn't run (Doctor's not_checked says which). Not the seller's
      // doing, so no refusal is reported to it.
      const ok = typeof onIncomplete === "function" && (await onIncomplete(preflight)) === true;
      const missing = (preflight.not_checked || []).filter((n) => n?.because === "unavailable").map((n) => n.check).join(", ") || "unknown";
      if (!ok) throw new SafePayError(`not paid: go, but not every check ran (${missing}); try again in a few minutes`, { code: "incomplete", preflight, url });
    }
    return payAfterPreflight();
  }
  // What this safeFetch paid to sellers so far, in US dollars (Doctor's preflights and diagnoses not included).
  safeFetch.spent = spentNow;
  return safeFetch;
}
