// presign-guard-wallet: a viem wallet for AI agents that asks presign-guard
// before it signs.
//
// Before every sendTransaction, writeContract and signTypedData, the wallet
// pays $0.01 (x402, USDC) for a presign-guard verdict on exactly what is about
// to be signed, and acts on it:
//   green  → signs
//   orange → onOrange: "stop" (default, throws), "allow", or your own async
//            function that decides (e.g. ask the user)
//   red    → throws PresignBlockedError; nothing is signed
// Every verdict must carry presign-guard's signed receipt for exactly this
// request, checked against its pinned signer (or a key certified by the Fizzl
// payout wallet): a missing, changed or forged verdict is never a signature.
// If the check itself fails (network, outage), onError decides: "stop"
// (default) or "allow".
//
// Your keys stay in your wallet client; the check is paid with the x402 fetch
// you pass in (wrapFetchWithPayment from @x402/fetch, with spend controls), or
// from prepaid presign-guard credits (creditKey, 100 checks for $0.80 at
// https://presign-guard.fizzl.eu/v1/credits/100): with a key the wallet asks
// with the key first and only pays per check when the credits are used up.

import { encodeFunctionData } from "viem";
import { verifyReceipt, AUTHORITY } from "x402-safe-fetch";

export const PRESIGN_URL = "https://presign-guard.fizzl.eu";
export const PRESIGN_SIGNERS = ["0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE"];
export const SUPPORTED_CHAINS = [1, 10, 56, 137, 8453, 42161];
export const VERSION = "0.2.0";
export const CREDIT_HEADER = "x-credit-key";
const ROUTE = "POST /v1/check";

export class PresignBlockedError extends Error {
  /** code: "red" | "orange" | "check_failed" | "bad_receipt" | "unsupported_chain" */
  constructor(message, { code, verdict = null, request = null } = {}) {
    super(message);
    this.name = "PresignBlockedError";
    this.code = code;
    this.verdict = verdict;
    this.request = request;
  }
}

// JSON with bigints as decimal strings (viem uses bigint for values and amounts).
const toJson = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// What presign-guard should check for a wallet call, or null for calls it does not cover.
export function checkRequestFor(method, args, { chainId, origin } = {}) {
  const base = { chainId, ...(origin ? { origin } : {}) };
  if (method === "sendTransaction") {
    if (!args?.to) return null; // contract deployment: nothing to screen
    return { type: "transaction", ...base, to: args.to, data: args.data ?? "0x", value: String(args.value ?? 0n) };
  }
  if (method === "writeContract") {
    const data = encodeFunctionData({ abi: args.abi, functionName: args.functionName, args: args.args });
    return { type: "transaction", ...base, to: args.address, data, value: String(args.value ?? 0n) };
  }
  if (method === "signTypedData") {
    const { domain, types, primaryType, message } = args;
    return { type: "signature", ...base, typedData: { domain, types, primaryType, message } };
  }
  return null;
}

const GUARDED = new Set(["sendTransaction", "writeContract", "signTypedData"]);

/**
 * @param {object} wallet  a viem WalletClient
 * @param {object} options
 * @param {typeof fetch} [options.pay]  a fetch that pays x402 (e.g. wrapFetchWithPayment(fetch, client)); optional with creditKey
 * @param {string} [options.creditKey]  a presign-guard credit key (pgc_…): checks are paid from prepaid credits first
 * @param {typeof fetch} [options.fetch]  plain fetch for credit-paid checks (default globalThis.fetch)
 * @param {"stop"|"allow"|((verdict: object, info: object) => boolean|Promise<boolean>)} [options.onOrange]
 * @param {"stop"|"allow"} [options.onError]  when the check cannot be done (default "stop")
 * @param {string} [options.origin]  the site asking for the signature, if any (domain age, phishing lists)
 * @param {(verdict: object, info: {method: string, request: object}) => void} [options.onVerdict]
 * @param {string} [options.presignUrl]
 * @param {"require"|"off"} [options.verifyReceipts]
 * @param {string[]} [options.signers]
 * @param {string|null} [options.authority]
 */
export function guardWallet(wallet, {
  pay,
  onOrange = "stop",
  onError = "stop",
  origin,
  onVerdict,
  presignUrl = PRESIGN_URL,
  verifyReceipts = "require",
  signers = PRESIGN_SIGNERS,
  authority = AUTHORITY,
  creditKey,
  fetch: plainFetch = globalThis.fetch,
} = {}) {
  if (!wallet || typeof wallet !== "object") throw new TypeError("wallet must be a viem WalletClient");
  if (creditKey !== undefined && !/^pgc_[A-Za-z0-9_-]{43}$/.test(String(creditKey))) throw new TypeError("creditKey must be a presign-guard credit key (pgc_…)");
  if (typeof pay !== "function" && !creditKey) throw new TypeError("pay is required: a fetch that pays x402, e.g. wrapFetchWithPayment(fetch, client), or a creditKey");
  if (!["stop", "allow"].includes(onOrange) && typeof onOrange !== "function") throw new TypeError('onOrange must be "stop", "allow" or a function');
  if (!["stop", "allow"].includes(onError)) throw new TypeError('onError must be "stop" or "allow"');
  if (!["require", "off"].includes(verifyReceipts)) throw new TypeError('verifyReceipts must be "require" or "off"');

  let creditsLeft = null;
  async function check(request) {
    const body = toJson(request);
    const url = `${presignUrl.replace(/\/$/, "")}/v1/check`;
    const headers = { "content-type": "application/json", accept: "application/json", "user-agent": `presign-guard-wallet/${VERSION}` };
    let res = null;
    let paidWith = "x402";
    // Prepaid credits first: a 402 means they are used up (or the key is unknown), then pay per check.
    if (creditKey && creditsLeft !== 0) {
      res = await plainFetch(url, { method: "POST", headers: { ...headers, [CREDIT_HEADER]: creditKey }, body });
      const left = res.headers?.get?.("x-credits-remaining");
      if (left !== null && left !== undefined && left !== "") creditsLeft = Number(left);
      if (res.status === 402) {
        if (res.headers?.get?.("x-credit-status") !== "insufficient") creditsLeft = 0; // unknown or expired key
        res = null;
      } else paidWith = "credits";
    }
    if (!res) {
      if (typeof pay !== "function") throw new PresignBlockedError("presign check failed (no credits left and no pay function); nothing was signed", { code: "check_failed", request });
      res = await pay(url, { method: "POST", headers, body });
    }
    const verdict = await res.json().catch(() => null);
    if (verdict && typeof verdict === "object") Object.defineProperty(verdict, "paidWith", { value: paidWith, enumerable: false });
    if (!res.ok || !verdict?.verdict) {
      const why = verdict?.error || `HTTP ${res.status}`;
      throw new PresignBlockedError(`presign check failed (${why}); nothing was signed`, { code: "check_failed", verdict, request });
    }
    if (verifyReceipts === "require") {
      const ok = verifyReceipt(verdict, { signers, route: ROUTE, input: JSON.parse(body), authority, service: "presign-guard" });
      if (!ok.valid) throw new PresignBlockedError(`verdict not trusted (${ok.reason}); nothing was signed`, { code: "bad_receipt", verdict, request });
    }
    return verdict;
  }

  async function guarded(method, original, args, rest) {
    const chainId = args?.chain?.id ?? wallet.chain?.id;
    const request = checkRequestFor(method, args, { chainId, origin });
    if (!request) return original(args, ...rest);
    const run = () => original(args, ...rest);
    if (!SUPPORTED_CHAINS.includes(chainId)) {
      if (onError === "allow") return run();
      throw new PresignBlockedError(`chain ${chainId} is not covered by presign-guard; nothing was signed`, { code: "unsupported_chain", request });
    }
    let verdict;
    try {
      verdict = await check(request);
    } catch (err) {
      if (err instanceof PresignBlockedError && err.code === "bad_receipt") throw err;
      if (onError === "allow") return run();
      if (err instanceof PresignBlockedError) throw err;
      throw new PresignBlockedError(`presign check failed (${err.message}); nothing was signed`, { code: "check_failed", request });
    }
    onVerdict?.(verdict, { method, request, paidWith: verdict.paidWith, creditsLeft });
    const why = (verdict.reasons || []).filter((r) => r.severity !== "info").map((r) => r.code).join(", ") || verdict.verdict;
    if (verdict.verdict === "red") throw new PresignBlockedError(`not signed: red (${why})`, { code: "red", verdict, request });
    if (verdict.verdict === "orange") {
      const ok = onOrange === "allow" || (typeof onOrange === "function" && (await onOrange(verdict, { method, request })) === true);
      if (!ok) throw new PresignBlockedError(`not signed: orange (${why})`, { code: "orange", verdict, request });
    } else if (verdict.verdict !== "green") {
      throw new PresignBlockedError(`not signed: unknown verdict ${verdict.verdict}`, { code: "check_failed", verdict, request });
    }
    return run();
  }

  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !GUARDED.has(prop) || typeof value !== "function") return value;
      return (args, ...rest) => guarded(prop, value.bind(target), args, rest);
    },
  });
}
