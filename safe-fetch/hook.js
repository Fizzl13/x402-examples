// x402 Doctor's pre-payment check as a hook for any x402 client (@x402/core x402Client, which @x402/fetch,
// @x402/axios and the other x402 transports use): one line, and every payment that client makes is checked first.
//
//   import { doctorPreflight } from "x402-safe-fetch/hook";
//   client.onBeforePaymentCreation(doctorPreflight({ client }));
//
// Before the client signs a payment, the hook asks Doctor (GET /api/v1/preflight, $0.001, or 1 prepaid credit)
// whether the endpoint is safe to pay: no_go stops the payment, caution stops it unless onCaution says otherwise,
// go lets it through. The verdict is signed by Doctor and checked; it is reused while the endpoint asks the same
// thing. Doctor's own 402 (for the preflight itself) is never checked again, and is paid only up to $0.002.
import { wrapFetchWithPayment } from "@x402/fetch";
import { DOCTOR_URL, preflightUrl, VERSION } from "./index.js";
import { verifyReceipt, DOCTOR_SIGNERS, AUTHORITY } from "./receipt.js";

const CREDIT_HEADER = "x-credit-key";
const CREDIT_KEY = /^xdc_[A-Za-z0-9_-]{43}$/;
// The preflight costs $0.001; its own payment is refused above twice that (USDC and the other dollar tokens Doctor
// takes have 6 decimals; RLUSD on the XRP Ledger is a decimal amount).
const PREFLIGHT_MAX_ATOMIC = 2000n;
const PREFLIGHT_MAX_DECIMAL = 0.002;

const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
const abort = (reason) => ({ abort: true, reason: String(reason).slice(0, 300) });

// Within the preflight's price: atomic units (EVM, Solana, Algorand, Stellar) or a decimal amount (XRPL RLUSD).
function withinPreflightPrice(amount) {
  const s = String(amount ?? "");
  if (/^\d+$/.test(s)) return BigInt(s) <= PREFLIGHT_MAX_ATOMIC;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= PREFLIGHT_MAX_DECIMAL;
}

/**
 * @param {object} options
 * @param {object} [options.client]  the x402Client the hook is added to: it pays the preflight too (the hook skips Doctor's own 402)
 * @param {typeof fetch} [options.pay]  or a fetch that pays x402, for the preflight
 * @param {string} [options.creditKey]  or prepaid Doctor credits (xdc_…): tried first, then pay or client
 * @param {number|string} [options.maxUsd]  your budget per call: Doctor says no_go above it
 * @param {"GET"|"POST"} [options.method]  how your calls reach the endpoints (Doctor tries the other method too)
 * @param {"stop"|"pay"|((preflight: object) => boolean|Promise<boolean>)} [options.onCaution]  default "stop"
 * @param {"pay"|"stop"|((preflight: object) => boolean|Promise<boolean>)} [options.onIncomplete]  a go whose checks_complete is false; default "pay"
 * @param {"stop"|"pay"} [options.onError]  when Doctor can't be asked; default "stop"
 * @param {string[]} [options.trusted]  hosts paid without a preflight
 * @param {(preflight: object, info: {url: string, cached: boolean}) => void} [options.onPreflight]
 * @param {number} [options.cacheMs]  how long a verdict is reused while the endpoint asks the same thing (default 1 hour)
 * @param {"require"|"off"} [options.verifyReceipts]  check Doctor's signature (default "require")
 * @returns {(context: {paymentRequired: object, selectedRequirements: object}) => Promise<void|{abort: true, reason: string}>}
 */
export function doctorPreflight({
  client,
  pay,
  creditKey,
  maxUsd,
  method = "GET",
  onCaution = "stop",
  onIncomplete = "pay",
  onError = "stop",
  trusted = [],
  onPreflight,
  cacheMs = 60 * 60 * 1000,
  doctorUrl = DOCTOR_URL,
  verifyReceipts = "require",
  doctorSigners = DOCTOR_SIGNERS,
  authority = AUTHORITY,
  fetch: plainFetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!client && typeof pay !== "function" && !creditKey) throw new TypeError("doctorPreflight needs a way to pay the $0.001 preflight: client, pay or creditKey");
  if (creditKey !== undefined && !CREDIT_KEY.test(String(creditKey))) throw new TypeError("creditKey must be an x402 Doctor credit key (xdc_…)");
  if (!["stop", "pay"].includes(onCaution) && typeof onCaution !== "function") throw new TypeError('onCaution must be "stop", "pay" or a function');
  if (!["pay", "stop"].includes(onIncomplete) && typeof onIncomplete !== "function") throw new TypeError('onIncomplete must be "pay", "stop" or a function');
  if (!["stop", "pay"].includes(onError)) throw new TypeError('onError must be "stop" or "pay"');
  if (!["require", "off"].includes(verifyReceipts)) throw new TypeError('verifyReceipts must be "require" or "off"');
  const doctorHost = hostOf(doctorUrl);
  const trustedHosts = new Set(trusted.map((t) => hostOf(/^https?:/.test(t) ? t : `https://${t}`)).filter(Boolean));
  let payingFetch = typeof pay === "function" ? pay : null;
  const payer = () => (payingFetch ??= client ? wrapFetchWithPayment(plainFetch, client) : null);
  const headers = { accept: "application/json", "user-agent": `x402-safe-fetch/${VERSION} (hook)` };
  const verdicts = new Map();

  async function ask(url, network) {
    const pfUrl = preflightUrl(url, { method, maxUsd, network, doctorUrl });
    let res = null;
    if (creditKey) {
      res = await plainFetch(pfUrl, { headers: { ...headers, [CREDIT_HEADER]: creditKey } });
      if (res.status === 402) res = null; // credits used up or unknown: pay instead, if we can
    }
    if (!res) {
      const f = payer();
      if (!f) throw new Error("no prepaid credits left and nothing to pay the preflight with");
      res = await f(pfUrl, { headers });
    }
    const preflight = await res.json().catch(() => null);
    if (!res.ok || !preflight?.verdict) throw new Error(`preflight answered HTTP ${res.status}`);
    if (verifyReceipts === "require") {
      const input = Object.fromEntries(new URL(pfUrl).searchParams);
      const check = verifyReceipt(preflight, { signers: doctorSigners, route: "GET /api/v1/preflight", input, authority, service: "x402-doctor" });
      if (!check.valid) throw new Error(`preflight not trusted (${check.reason})`);
    }
    return preflight;
  }

  return async function doctorPreflightHook({ paymentRequired, selectedRequirements } = {}) {
    const url = paymentRequired?.resource?.url;
    const host = hostOf(url);
    // Doctor's own 402, for the preflight we are paying: never checked again, and never more than its price.
    if (host && host === doctorHost) {
      return withinPreflightPrice(selectedRequirements?.amount ?? selectedRequirements?.maxAmountRequired) ? undefined : abort("x402 Doctor's preflight asked more than $0.002");
    }
    if (!url || (host && trustedHosts.has(host))) return undefined;

    const r = selectedRequirements || {};
    const key = JSON.stringify([url, r.network, r.asset, String(r.amount ?? r.maxAmountRequired ?? ""), r.payTo]);
    const hit = verdicts.get(key);
    const ttl = hit?.preflight?.checks_complete === false ? Math.min(cacheMs, 10 * 60 * 1000) : cacheMs;
    let preflight;
    let cached = false;
    if (hit && hit.at + ttl > now()) {
      preflight = hit.preflight;
      cached = true;
    } else {
      try {
        preflight = await ask(url, r.network);
      } catch (err) {
        return onError === "pay" ? undefined : abort(`x402 Doctor's preflight failed (${err.message}); not paid`);
      }
      verdicts.set(key, { preflight, at: now() });
      if (verdicts.size > 1000) verdicts.delete(verdicts.keys().next().value);
    }
    onPreflight?.(preflight, { url, cached });

    const why = preflight.summary || preflight.verdict;
    if (preflight.verdict === "no_go") return abort(`x402 Doctor: ${why}`);
    if (preflight.verdict === "caution") {
      const ok = onCaution === "pay" || (typeof onCaution === "function" && (await onCaution(preflight)) === true);
      return ok ? undefined : abort(`x402 Doctor (caution): ${why}`);
    }
    if (preflight.verdict !== "go") return abort(`x402 Doctor: unknown verdict ${preflight.verdict}`);
    if (preflight.checks_complete === false && onIncomplete !== "pay") {
      const ok = typeof onIncomplete === "function" && (await onIncomplete(preflight)) === true;
      if (!ok) return abort("x402 Doctor: go, but not every check ran; try again in a few minutes");
    }
    return undefined;
  };
}
