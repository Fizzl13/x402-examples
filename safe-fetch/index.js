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
// preflights for that endpoint learn from what agents ran into. Off by
// default; no keys, amounts or response content are sent.
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

export { verifyReceipt, recoverSigner, canonicalJson, inputHash, certMessage, DOCTOR_SIGNERS, AUTHORITY } from "./receipt.js";

export const DOCTOR_URL = "https://x402-doctor.fizzl.eu";
export const PREFLIGHT_CAP = "$0.002"; // the preflight costs $0.001; never more than twice that
export const DIAGNOSE_CAP = "$0.02"; // the diagnosis costs $0.01; never more than twice that
export const VERSION = "0.9.0";
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
  let challenge = null;
  const header = res?.headers?.get?.("payment-required");
  if (header) {
    try { challenge = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0)))); } catch { /* not base64 JSON */ }
    try { await res.body?.cancel(); } catch { /* already consumed */ }
  } else {
    try { challenge = JSON.parse(await res.text()); } catch { /* not JSON */ }
  }
  if (!Array.isArray(challenge?.accepts)) return null;
  const parts = challenge.accepts.map((a) => JSON.stringify([a?.scheme ?? null, a?.network ?? null, String(a?.asset ?? ""), String(a?.amount ?? a?.maxAmountRequired ?? ""), String(a?.payTo ?? "")]));
  return JSON.stringify(parts.sort());
}
// Without an offer to compare (no readable x402 challenge), a verdict is reused for at most 10 minutes.
const UNREAD_OFFER_MS = 10 * 60 * 1000;

export function payableOption(accepts, network, maxUsd) {
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
  // read the amount, which for auth-capture is the most that can be captured).
  return on.find((a) => a?.scheme === "exact") ?? on.find((a) => a?.scheme === "auth-capture") ?? on[0] ?? null;
}

export class SafePayError extends Error {
  /** code: "no_go" | "caution" | "preflight_failed" | "bad_receipt" | "no_option" */
  constructor(message, { code, preflight = null, url = null } = {}) {
    super(message);
    this.name = "SafePayError";
    this.code = code;
    this.preflight = preflight;
    this.url = url;
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

export function preflightUrl(target, { method = "GET", maxUsd, network, doctorUrl = DOCTOR_URL } = {}) {
  const q = new URLSearchParams({ url: target, method });
  if (maxUsd !== undefined) q.set("max_usd", String(maxUsd).replace(/^\$/, ""));
  if (network) q.set("network", network);
  return `${doctorUrl.replace(/\/$/, "")}/api/v1/preflight?${q}`;
}

// The transaction of a paid response (PAYMENT-RESPONSE header), or null.
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

/**
 * @param {object} options
 * @param {(client: x402Client) => unknown} options.register  registers your payment schemes on a client
 * @param {string} [options.network]  the network you pay on: "base", "solana", "algorand", "xrpl", "stellar" or a CAIP-2 id (default Base)
 * @param {number|string} [options.maxUsd]  budget per endpoint call (default 0.05)
 * @param {"stop"|"pay"|((preflight: object) => boolean|Promise<boolean>)} [options.onCaution]
 * @param {string[]} [options.trusted]  hosts you already trust: paid without a preflight
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
 * @param {(cap: string) => typeof fetch} [options.createPayingFetch]  advanced/testing: a paying fetch capped at `cap`
 * @param {() => number} [options.now]
 */
export function createSafeFetch({
  register,
  network = BASE,
  maxUsd = 0.05,
  onCaution = "stop",
  trusted = [],
  onPreflight,
  cacheMs = 60 * 60 * 1000,
  doctorUrl = DOCTOR_URL,
  verifyReceipts = "require",
  doctorSigners = DOCTOR_SIGNERS,
  authority = AUTHORITY,
  diagnoseOnFailure = false,
  onDiagnosis,
  shareOutcomes = false,
  fetch: baseFetch = globalThis.fetch,
  createPayingFetch,
  now = Date.now,
} = {}) {
  const payNetwork = NETWORK_ALIASES[network] ?? network;
  const budget = usdCap(maxUsd);
  if (!createPayingFetch && typeof register !== "function") {
    throw new TypeError("register is required: (client) => client.register(network, scheme)");
  }
  if (!["stop", "pay"].includes(onCaution) && typeof onCaution !== "function") {
    throw new TypeError('onCaution must be "stop", "pay" or a function');
  }
  if (!["require", "off"].includes(verifyReceipts)) throw new TypeError('verifyReceipts must be "require" or "off"');
  const trustedHosts = new Set(trusted.map(hostOf).filter(Boolean));

  const makePayingFetch = createPayingFetch ?? ((cap) => {
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
    return wrapFetchWithPayment(baseFetch, client);
  });
  let preflightFetch;
  let endpointFetch;
  let diagnoseFetch;
  const payPreflight = (...args) => (preflightFetch ??= makePayingFetch(PREFLIGHT_CAP))(...args);
  const payDiagnose = (...args) => (diagnoseFetch ??= makePayingFetch(DIAGNOSE_CAP))(...args);
  const payEndpoint = (...args) => (endpointFetch ??= makePayingFetch(budget))(...args);

  const verdicts = new Map();
  async function preflightFor(url, method, offer) {
    const key = `${method} ${url}`;
    const hit = verdicts.get(key);
    const ttl = offer === null ? Math.min(cacheMs, UNREAD_OFFER_MS) : cacheMs;
    if (hit && hit.offer === offer && hit.at + ttl > now()) return { preflight: hit.preflight, cached: true };
    const pfUrl = preflightUrl(url, { method, maxUsd: budget, network: payNetwork, doctorUrl });
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
    verdicts.set(key, { preflight, offer, at: now() });
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
  function reportOutcome(url, method, preflight, res) {
    if (!shareOutcomes || !preflight?.receipt?.request_id || reported.has(preflight.receipt.request_id)) return;
    const outcome = res.ok ? "paid_ok" : res.status === 402 ? "paid_failed" : res.status >= 400 ? "paid_error" : null;
    if (!outcome) return;
    reported.add(preflight.receipt.request_id);
    if (reported.size > 1000) reported.delete(reported.values().next().value);
    const query = Object.fromEntries(new URL(preflightUrl(url, { method, maxUsd: budget, network: payNetwork, doctorUrl })).searchParams);
    // Fire and forget: the report never delays or changes the answer.
    Promise.resolve()
      .then(() => baseFetch(`${doctorUrl.replace(/\/$/, "")}/api/v1/outcome`, {
        method: "POST",
        headers: { ...DOCTOR_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ outcome, status: res.status, preflight, query }),
      }))
      .then((r) => r?.body?.cancel?.())
      .catch(() => {});
  }

  async function payAndCheck(url, init, method) {
    if (!diagnoseOnFailure) return payEndpoint(url, init);
    let res;
    try {
      res = await payEndpoint(url, init);
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

  return async function safeFetch(input, init = {}) {
    const { url, method } = requestOf(input, init);
    const probe = await baseFetch(url, init);
    if (probe.status !== 402) return probe;

    if (trustedHosts.has(hostOf(url))) {
      try { await probe.body?.cancel(); } catch { /* already consumed */ }
      return payAndCheck(url, init, method);
    }

    const { preflight, cached } = await preflightFor(url, method, await offerFingerprint(probe));
    const payAfterPreflight = async () => {
      const res = await payAndCheck(url, init, method);
      reportOutcome(url, method, preflight, res);
      return res;
    };
    onPreflight?.(preflight, { url, method, cached });
    const why = preflight.summary || preflight.verdict;
    if (preflight.verdict === "no_go") throw new SafePayError(`not paid: ${why}`, { code: "no_go", preflight, url });
    if (preflight.verdict === "caution") {
      const ok = onCaution === "pay" || (typeof onCaution === "function" && (await onCaution(preflight)) === true);
      if (!ok) throw new SafePayError(`not paid (caution): ${why}`, { code: "caution", preflight, url });
    } else if (preflight.verdict !== "go") {
      throw new SafePayError(`not paid: unknown verdict ${preflight.verdict}`, { code: "preflight_failed", preflight, url });
    }
    return payAfterPreflight();
  };
}
