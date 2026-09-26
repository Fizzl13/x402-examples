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
//
// Payments use @x402/fetch with the schemes you register (your keys stay in
// your code): register: (client) => client.register("eip155:8453", new ExactEvmScheme(account))

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";

export const DOCTOR_URL = "https://x402-doctor.onrender.com";
export const PREFLIGHT_CAP = "$0.002"; // the preflight costs $0.001; never more than twice that
export const BASE = "eip155:8453";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const NETWORK_ALIASES = { base: BASE, solana: SOLANA };

export class SafePayError extends Error {
  /** code: "no_go" | "caution" | "preflight_failed" | "no_option" */
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
 * @param {string} [options.network]  the network you pay on: "base", "solana" or a CAIP-2 id (default Base)
 * @param {number|string} [options.maxUsd]  budget per endpoint call (default 0.05)
 * @param {"stop"|"pay"|((preflight: object) => boolean|Promise<boolean>)} [options.onCaution]
 * @param {string[]} [options.trusted]  hosts you already trust: paid without a preflight
 * @param {(preflight: object, info: {url: string, method: string, cached: boolean}) => void} [options.onPreflight]
 * @param {number} [options.cacheMs]  how long a verdict is reused (default 10 minutes)
 * @param {string} [options.doctorUrl]
 * @param {typeof fetch} [options.fetch]  the underlying fetch (default globalThis.fetch)
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
  const trustedHosts = new Set(trusted.map(hostOf).filter(Boolean));

  const makePayingFetch = createPayingFetch ?? ((cap) => {
    const client = new x402Client((_version, accepts) => {
      const pick = accepts.find((a) => a.network === payNetwork);
      if (!pick) throw new SafePayError(`no payment option on ${payNetwork}`, { code: "no_option" });
      return pick;
    }).setSpendControls({ maxAmountPerPayment: cap });
    register(client);
    return wrapFetchWithPayment(baseFetch, client);
  });
  let preflightFetch;
  let endpointFetch;
  const payPreflight = (...args) => (preflightFetch ??= makePayingFetch(PREFLIGHT_CAP))(...args);
  const payEndpoint = (...args) => (endpointFetch ??= makePayingFetch(budget))(...args);

  const verdicts = new Map();
  async function preflightFor(url, method) {
    const key = `${method} ${url}`;
    const hit = verdicts.get(key);
    if (hit && hit.expires > now()) return { preflight: hit.preflight, cached: true };
    const res = await payPreflight(preflightUrl(url, { method, maxUsd: budget, network: payNetwork, doctorUrl }), { headers: { accept: "application/json" } });
    const preflight = await res.json().catch(() => null);
    if (!res.ok || !preflight?.verdict) {
      throw new SafePayError(`preflight failed (HTTP ${res.status}); the endpoint was not paid`, { code: "preflight_failed", preflight, url });
    }
    verdicts.set(key, { preflight, expires: now() + cacheMs });
    if (verdicts.size > 1000) verdicts.delete(verdicts.keys().next().value);
    return { preflight, cached: false };
  }

  return async function safeFetch(input, init = {}) {
    const { url, method } = requestOf(input, init);
    const probe = await baseFetch(url, init);
    if (probe.status !== 402) return probe;
    try { await probe.body?.cancel(); } catch { /* already consumed */ }

    if (trustedHosts.has(hostOf(url))) return payEndpoint(url, init);

    const { preflight, cached } = await preflightFor(url, method);
    onPreflight?.(preflight, { url, method, cached });
    const why = preflight.summary || preflight.verdict;
    if (preflight.verdict === "no_go") throw new SafePayError(`not paid: ${why}`, { code: "no_go", preflight, url });
    if (preflight.verdict === "caution") {
      const ok = onCaution === "pay" || (typeof onCaution === "function" && (await onCaution(preflight)) === true);
      if (!ok) throw new SafePayError(`not paid (caution): ${why}`, { code: "caution", preflight, url });
    } else if (preflight.verdict !== "go") {
      throw new SafePayError(`not paid: unknown verdict ${preflight.verdict}`, { code: "preflight_failed", preflight, url });
    }
    return payEndpoint(url, init);
  };
}
