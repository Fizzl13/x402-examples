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
// Trusted hosts skip the preflight; a verdict is reused for 10 minutes.
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
// On Algorand (USDC) and the XRP Ledger (RLUSD) only the dollar stablecoin is paid.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { verifyReceipt, DOCTOR_SIGNERS, AUTHORITY } from "./receipt.js";

export { verifyReceipt, recoverSigner, canonicalJson, inputHash, certMessage, DOCTOR_SIGNERS, AUTHORITY } from "./receipt.js";

export const DOCTOR_URL = "https://x402-doctor.fizzl.eu";
export const PREFLIGHT_CAP = "$0.002"; // the preflight costs $0.001; never more than twice that
export const DIAGNOSE_CAP = "$0.02"; // the diagnosis costs $0.01; never more than twice that
export const VERSION = "0.6.0";
// Doctor sees which calls come from this package (in its usage counts), nothing more.
const DOCTOR_HEADERS = { accept: "application/json", "user-agent": `x402-safe-fetch/${VERSION}` };
export const BASE = "eip155:8453";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const ALGORAND = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const ALGORAND_TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export const XRPL = "xrpl:0";
export const XRPL_TESTNET = "xrpl:1";
const NETWORK_ALIASES = { base: BASE, solana: SOLANA, algorand: ALGORAND, "algorand-testnet": ALGORAND_TESTNET, xrpl: XRPL, "xrpl-testnet": XRPL_TESTNET };

// On Algorand and the XRP Ledger only the dollar stablecoin is paid: USDC (an ASA) on Algorand, RLUSD from
// Ripple's issuer on the XRP Ledger. Never ALGO, XRP or another token, so the dollar budget always holds.
const ALGORAND_USDC = { [ALGORAND]: "31566704", [ALGORAND_TESTNET]: "10458941" };
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const RLUSD_ISSUER = { [XRPL]: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", [XRPL_TESTNET]: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };

// The option to pay on `network`, or null. RLUSD prices are decimal dollars ("0.001", and "2" is two dollars),
// which x402's spend controls would read as base units, so the budget is checked here in dollars.
export function payableOption(accepts, network, maxUsd) {
  const cap = Number(String(maxUsd).replace(/^\$/, ""));
  const on = (accepts ?? []).filter((a) => a?.network === network);
  if (ALGORAND_USDC[network]) return on.find((a) => String(a.asset) === ALGORAND_USDC[network]) ?? null;
  if (RLUSD_ISSUER[network]) {
    return on.find((a) => String(a.asset ?? "").toUpperCase() === RLUSD_HEX && a.extra?.issuer === RLUSD_ISSUER[network]
      && /^\d+(\.\d+)?$/.test(String(a.amount)) && Number(a.amount) > 0 && Number(a.amount) <= cap) ?? null;
  }
  return on[0] ?? null;
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
 * @param {string} [options.network]  the network you pay on: "base", "solana", "algorand", "xrpl" or a CAIP-2 id (default Base)
 * @param {number|string} [options.maxUsd]  budget per endpoint call (default 0.05)
 * @param {"stop"|"pay"|((preflight: object) => boolean|Promise<boolean>)} [options.onCaution]
 * @param {string[]} [options.trusted]  hosts you already trust: paid without a preflight
 * @param {(preflight: object, info: {url: string, method: string, cached: boolean}) => void} [options.onPreflight]
 * @param {number} [options.cacheMs]  how long a verdict is reused (default 10 minutes)
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
  cacheMs = 10 * 60 * 1000,
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
      if (!pick) throw new SafePayError(`no payment option on ${payNetwork}${ALGORAND_USDC[payNetwork] ? " in USDC" : RLUSD_ISSUER[payNetwork] ? ` in RLUSD within ${cap}` : ""}`, { code: "no_option" });
      return pick;
    }).setSpendControls({ maxAmountPerPayment: cap });
    register(client);
    return wrapFetchWithPayment(baseFetch, client);
  });
  let preflightFetch;
  let endpointFetch;
  let diagnoseFetch;
  const payPreflight = (...args) => (preflightFetch ??= makePayingFetch(PREFLIGHT_CAP))(...args);
  const payDiagnose = (...args) => (diagnoseFetch ??= makePayingFetch(DIAGNOSE_CAP))(...args);
  const payEndpoint = (...args) => (endpointFetch ??= makePayingFetch(budget))(...args);

  const verdicts = new Map();
  async function preflightFor(url, method) {
    const key = `${method} ${url}`;
    const hit = verdicts.get(key);
    if (hit && hit.expires > now()) return { preflight: hit.preflight, cached: true };
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
    verdicts.set(key, { preflight, expires: now() + cacheMs });
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
    try { await probe.body?.cancel(); } catch { /* already consumed */ }

    if (trustedHosts.has(hostOf(url))) return payAndCheck(url, init, method);

    const { preflight, cached } = await preflightFor(url, method);
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
