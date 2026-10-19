// presign-guard-wallet: a viem wallet for AI agents that asks presign-guard
// before it signs.
//
// Before every sendTransaction, writeContract and signTypedData (and viem's
// other ways to sign or send: signTransaction, sendTransactionSync,
// writeContractSync, sendCalls, sendCallsSync, deployContract), the wallet
// pays $0.01 (x402, USDC) for a presign-guard verdict on exactly what is about
// to be signed, and acts on it:
//   green  → signs
//   orange → onOrange: "stop" (default, throws), "allow", or your own async
//            function that decides (e.g. ask the user)
//   red    → throws PresignBlockedError; nothing is signed
// EIP-7702 authorizations (signAuthorization, and the authorizationList of a
// transaction) are checked too, and stricter: a delegation hands the contract
// the whole wallet, so an orange one is signed only when your onOrange function
// says yes ("allow" does not cover it), and a failed check always stops.
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
//
// Spending limits (limits): per token, per transaction and per rolling window,
// plus an optional allow list. Anything over a limit goes to onOverLimit (your
// function, e.g. ask the user on their phone); without it, it stops. These
// limits live in the agent's software: an agent with the raw key can go around
// them. See limits.js for what counts as spending.
//
// Tempo (chain 4217, testnet 42431) is not covered by presign-guard. There the
// wallet signs only one thing, checked here: a TIP-20 transfer or
// transferWithMemo of USDC.e (pathUSD on the testnet), with no value attached,
// which counts toward the USDC limits like any other USDC transfer. Anything
// else on Tempo is refused (code "unsupported_chain").
//
// MPP sessions on Tempo: tempoSessionAccount(account) gives a guarded viem account for mppx's
// session client. It signs one thing on chain, opening or topping up a payment channel in
// Tempo's escrow in USDC.e (the deposit counts toward the USDC limits), plus that channel's
// vouchers and close authorizations; raw hashes, messages and anything else are refused.
//
// Algorand: algorandSigner(signer) wraps an x402 AVM client signer (toClientAvmSigner from @x402/avm). It
// signs only an asset transfer of USDC from that account (no close-out, rekey or clawback), checked here
// and counted toward the USDC limits. With { any: true } it also signs other transactions and groups, each
// checked by presign-guard first (type "algorand": rekeys, closes, clawbacks, fake USDC, simulated); what
// the account's own transactions send counts toward the limits (ALGO toward ALGO, USDC toward USDC).
//
// XRP Ledger: xrplSigner(signer) wraps an XRPL signer ({ classicAddress, sign(tx) },
// e.g. createXrplWalletSigner from @x402/xrpl) the same way. It signs only
// Payment transactions, each checked by presign-guard first (type "xrpl": fake
// RLUSD, partial payments, missing destination tags, issuer risks) and counted
// toward the limits (XRP toward an XRP limit, RLUSD toward USDC). Use it with
// @x402/xrpl's ExactXrplScheme to pay x402 services in RLUSD.

import { bytesToHex, decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { verifyReceipt, AUTHORITY } from "x402-safe-fetch";
import { createLimiter, memoryStore } from "./limits.js";
import { createRemoteLimiter } from "./remote.js";
import { AsyncLocalStorage } from "node:async_hooks";

import { mandateFor } from "./mandate.js";
import { ALGORAND_USDC, readAlgorandTxn } from "./algorand.js";
import { SOLANA_USDC, readSolanaMessage, readSolanaPayment, wireTransaction } from "./solana.js";
export { ALGORAND_USDC } from "./algorand.js";
export { mandatePayer, mandateDigest, mandateBinding } from "./mandate.js";
export { memoryStore };

export const PRESIGN_URL = "https://presign-guard.fizzl.eu";
export const PRESIGN_SIGNERS = ["0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE"];
export const SUPPORTED_CHAINS = [1, 10, 56, 137, 8453, 42161];
// Tempo: the stablecoins the wallet may send there (the ones the USDC limit covers).
export const TEMPO_TOKENS = {
  4217: ["0x20c000000000000000000000b9537d11c60e8b50"],
  42431: ["0x20c0000000000000000000000000000000000000"],
};
const TEMPO_TRANSFERS = new Set(["transfer", "transferWithMemo"]);
// MPP sessions (TIP-1034): deposits into Tempo's channel escrow, and the vouchers that spend them.
export const TEMPO_ESCROW = "0x4d50500000000000000000000000000000000000";
const ESCROW_ABI = parseAbi([
  "function open(address payee, address operator, address token, uint96 deposit, bytes32 salt, address authorizedSigner)",
  "function topUp((address payer, address payee, address operator, address token, bytes32 salt, address authorizedSigner, bytes32 expiringNonceHash) descriptor, uint96 additionalDeposit)",
]);
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount)"]);
const VOUCHER_DOMAIN = "TIP20 Channel Reserve";
export const XRPL_NETWORKS = ["xrpl:0", "xrpl:1"];
export const VERSION = "0.22.0";
export const CREDIT_HEADER = "x-credit-key";
const ROUTE = "POST /v1/check";

export class PresignBlockedError extends Error {
  /** code: "red" | "orange" | "check_failed" | "bad_receipt" | "unsupported_chain" | "over_limit" | "paused" | "limit_unavailable" */
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

// The x402 payment requirements being paid right now (x402Checked), so presign-guard can check that the
// EIP-3009 signature pays exactly what the seller asked: amount, payTo, asset, network, validity.
const x402Paying = new AsyncLocalStorage();
function cleanRequirements(r) {
  if (!r || typeof r !== "object") return null;
  const out = {};
  for (const k of ["scheme", "network", "amount", "maxAmountRequired", "asset", "payTo", "maxTimeoutSeconds"]) if (r[k] !== undefined && r[k] !== null) out[k] = typeof r[k] === "bigint" ? r[k].toString() : r[k];
  if (r.extra && typeof r.extra === "object") out.extra = { ...(r.extra.name !== undefined && { name: r.extra.name }), ...(r.extra.version !== undefined && { version: r.extra.version }) };
  return out;
}

/**
 * Wrap an x402 client scheme (e.g. new ExactEvmScheme(guardedSigner)) so the payment requirements it pays go
 * along with the presign-guard check of the EIP-3009 signature: a signature that pays more, someone else, another
 * token or chain than the seller asked is red (X402_AMOUNT_ABOVE_REQUIRED, X402_RECIPIENT_MISMATCH, …).
 */
export function x402Checked(scheme) {
  return Object.assign(Object.create(scheme), {
    scheme: scheme.scheme ?? "exact",
    createPaymentPayload(x402Version, requirements, ...rest) {
      return x402Paying.run(cleanRequirements(requirements), () => scheme.createPaymentPayload(x402Version, requirements, ...rest));
    },
  });
}

// The wallet a transaction is sent from: the call's account, else the client's.
function senderOf(args, client) {
  const a = args?.account ?? client?.account;
  const address = typeof a === "string" ? a : a?.address;
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
}

// What presign-guard should check for a wallet call, or null for calls it does not cover. With `from` (the
// sending wallet) presign-guard simulates a transaction and reports what really leaves the wallet.
export function checkRequestFor(method, args, { chainId, origin, x402, from } = {}) {
  method = SAME_AS[method] ?? method;
  const base = { chainId, ...(origin ? { origin } : {}) };
  const sender = from ? { from } : {};
  if (method === "sendTransaction") {
    if (!args?.to) return null; // contract deployment: nothing to screen
    return { type: "transaction", ...base, ...sender, to: args.to, data: args.data ?? "0x", value: String(args.value ?? 0n) };
  }
  if (method === "writeContract") {
    const data = encodeFunctionData({ abi: args.abi, functionName: args.functionName, args: args.args });
    return { type: "transaction", ...base, ...sender, to: args.address, data, value: String(args.value ?? 0n) };
  }
  if (method === "signMessage") {
    // viem: a string is signed as text, { raw } as bytes (hex or a byte array).
    const m = args?.message;
    const message = typeof m === "string" ? m : typeof m?.raw === "string" ? m.raw : m?.raw instanceof Uint8Array ? bytesToHex(m.raw) : null;
    if (message === null) return null;
    return { type: "message", method: "personal_sign", message, ...(chainId ? { chainId } : {}), ...(origin ? { origin } : {}), ...sender };
  }
  if (method === "signAuthorization") {
    // EIP-7702: viem takes the contract as contractAddress (before address) and fills in the client's chain id
    // when none is given. The chain id inside the authorization may be 0: valid on every chain.
    const address = args?.contractAddress ?? args?.address;
    if (typeof address !== "string") return null;
    const signedChain = args?.chainId ?? chainId;
    const nonce = args?.nonce;
    return {
      type: "authorization", chainId: Number(signedChain) || chainId, address,
      ...(signedChain !== undefined && { authorizationChainId: Number(signedChain) }),
      ...(nonce !== undefined && nonce !== null && { nonce: String(nonce) }),
      ...(origin ? { origin } : {}), ...sender,
    };
  }
  if (method === "signTypedData") {
    const { domain, types, primaryType, message } = args;
    // A payment made by mandatePayer() (mandate.js) is checked against its mandate too.
    const under = primaryType === "TransferWithAuthorization" ? mandateFor(message?.nonce) : null;
    const paying = primaryType === "TransferWithAuthorization" && x402 ? { x402: { accepted: x402 } } : {};
    return { type: "signature", ...base, typedData: { domain, types, primaryType, message }, ...(under && { mandate: { ...under.envelope, paymentId: under.paymentId } }), ...paying };
  }
  return null;
}

// The one transaction an MPP session account signs: a single call to Tempo's escrow, open or topUp, in the
// chain's stablecoin, for this account, nothing attached. Returns what it deposits, or throws.
export function sessionDeposit(tx, chainId, address) {
  const no = (why) => { throw new PresignBlockedError(`MPP session account: ${why}; nothing was signed`, { code: "unsupported_chain" }); };
  const tokens = TEMPO_TOKENS[chainId];
  if (Number(tx?.chainId ?? chainId) !== chainId) no(`the transaction is for chain ${tx?.chainId}, not ${chainId}`);
  if (tx?.feeToken !== undefined && !tokens.includes(String(tx.feeToken).toLowerCase())) no("the fee is not paid in the session stablecoin");
  const calls = Array.isArray(tx?.calls) ? tx.calls : tx?.to ? [{ to: tx.to, data: tx.data, value: tx.value }] : [];
  if (calls.length !== 1) no(`only one escrow call is signed (got ${calls.length})`);
  const [call] = calls;
  if (String(call.to ?? "").toLowerCase() !== TEMPO_ESCROW) no("the call is not to Tempo's channel escrow");
  if (BigInt(call.value ?? 0n) > 0n) no("value is attached");
  let decoded;
  try { decoded = decodeFunctionData({ abi: ESCROW_ABI, data: call.data }); } catch { no("only opening or topping up a channel is signed"); }
  const me = String(address).toLowerCase();
  if (decoded.functionName === "open") {
    const [payee, , token, deposit, , signer] = decoded.args;
    if (!tokens.includes(token.toLowerCase())) no("the channel is not in the session stablecoin");
    if (signer.toLowerCase() !== me) no("the channel's voucher signer is not this account");
    return { token: token.toLowerCase(), payee, deposit };
  }
  const [descriptor, deposit] = decoded.args;
  if (!tokens.includes(descriptor.token.toLowerCase())) no("the channel is not in the session stablecoin");
  if (descriptor.payer.toLowerCase() !== me) no("the channel is not this account's");
  return { token: descriptor.token.toLowerCase(), payee: descriptor.payee, deposit };
}

// viem's other ways to sign or send, each checked like the call it stands for. A signed transaction is as good as
// sent (anyone can broadcast it), and a deployment is checked like a transaction without a recipient: not by
// presign-guard, but the value it sends counts.
const SAME_AS = { sendTransactionSync: "sendTransaction", signTransaction: "sendTransaction", deployContract: "sendTransaction", writeContractSync: "writeContract" };
// EIP-5792 batches: every call in them is checked.
const BATCHES = new Set(["sendCalls", "sendCallsSync"]);
const GUARDED = new Set(["sendTransaction", "writeContract", "signTypedData", "signAuthorization", ...Object.keys(SAME_AS), ...BATCHES]);

// A signed EIP-7702 authorization, by its signature.
const authorizationKey = (a) => (typeof a?.r === "string" && typeof a?.s === "string" ? `${a.r}:${a.s}`.toLowerCase() : null);

// What the agent says it is buying, for the signatures made inside withPurchase().
const purchases = new AsyncLocalStorage();
function cleanPurchase(info) {
  if (!info || typeof info !== "object") throw new TypeError("withPurchase(info, fn): info must be { url?, description? }");
  const out = {};
  if (info.url !== undefined && info.url !== null) {
    const url = String(info.url);
    if (!/^https?:\/\//.test(url)) throw new TypeError("purchase url must start with https:// or http://");
    out.url = url.slice(0, 500);
  }
  if (info.description !== undefined && info.description !== null) out.description = String(info.description).slice(0, 300);
  return out;
}

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
 * @param {object} [options.limits]  spending limits: { tokens: { USDC: { perTx, perDay }, … }, unknownTokens, allow, window }
 * @param {(info: object) => boolean|{approved: true, proof?: object}|Promise<boolean|{approved: true, proof?: object}>} [options.onOverLimit]  asked when a limit would be crossed; true (or { approved: true, proof }) = sign anyway
 * @param {(entry: object) => void} [options.onSpend]  after each signed spend
 * @param {{url: string, key: string}} [options.server]  a wallet server (fizzl wallet-server) keeps the limits, budget and approvals for all your agents
 * @param {object} [options.store]  where spending is kept (default in memory; fileStore from presign-guard-wallet/file-store)
 * @param {boolean} [options.checkMessages]  check signMessage too (default true): a sign-in message for another site is red
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
  checkMessages = true,
  fetch: plainFetch = globalThis.fetch,
  limits,
  onOverLimit,
  onSpend,
  store,
  server,
} = {}) {
  if (!wallet || typeof wallet !== "object") throw new TypeError("wallet must be a viem WalletClient");
  if (creditKey !== undefined && !/^pgc_[A-Za-z0-9_-]{43}$/.test(String(creditKey))) throw new TypeError("creditKey must be a presign-guard credit key (pgc_…)");
  if (typeof pay !== "function" && !creditKey) throw new TypeError("pay is required: a fetch that pays x402, e.g. wrapFetchWithPayment(fetch, client), or a creditKey");
  if (!["stop", "allow"].includes(onOrange) && typeof onOrange !== "function") throw new TypeError('onOrange must be "stop", "allow" or a function');
  if (!["stop", "allow"].includes(onError)) throw new TypeError('onError must be "stop" or "allow"');
  if (!["require", "off"].includes(verifyReceipts)) throw new TypeError('verifyReceipts must be "require" or "off"');
  if (typeof checkMessages !== "boolean") throw new TypeError("checkMessages must be true or false");

  if (server !== undefined && (limits !== undefined || onOverLimit || store)) throw new TypeError("with server, the limits and approvals live on the wallet server: leave out limits, onOverLimit and store");
  if (server === undefined && limits === undefined && (onOverLimit || onSpend || store)) throw new TypeError("onOverLimit, onSpend and store need limits");
  const limiter = server !== undefined ? createRemoteLimiter({ ...server, fetch: server.fetch ?? plainFetch, onSpend })
    : limits === undefined ? null : createLimiter(limits, { store, onOverLimit, onSpend });
  let paused = false;

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

  // The verdict for a request, or null when the check could not be done and onError is "allow".
  async function verdictFor(method, request, chainId) {
    // An EIP-7702 authorization is never signed unchecked: onError "allow" does not cover it.
    const mayAllow = onError === "allow" && request.type !== "authorization";
    if (request.type !== "message" && request.type !== "solana" && request.type !== "algorand" && !SUPPORTED_CHAINS.includes(chainId) && !XRPL_NETWORKS.includes(chainId)) {
      if (mayAllow) return null;
      throw new PresignBlockedError(`chain ${chainId} is not covered by presign-guard; nothing was signed`, { code: "unsupported_chain", request });
    }
    let verdict;
    try {
      verdict = await check(request);
    } catch (err) {
      if (err instanceof PresignBlockedError && err.code === "bad_receipt") throw err;
      if (mayAllow) return null;
      if (err instanceof PresignBlockedError) throw err;
      throw new PresignBlockedError(`presign check failed (${err.message}); nothing was signed`, { code: "check_failed", request });
    }
    onVerdict?.(verdict, { method, request, paidWith: verdict.paidWith, creditsLeft });
    const why = (verdict.reasons || []).filter((r) => r.severity !== "info").map((r) => r.code).join(", ") || verdict.verdict;
    if (verdict.verdict === "red") throw new PresignBlockedError(`not signed: red (${why})`, { code: "red", verdict, request });
    if (verdict.verdict === "orange") {
      // onOrange "allow" does not cover an EIP-7702 authorization: only your function's yes does.
      const authorization = request.type === "authorization";
      const ok = (onOrange === "allow" && !authorization) || (typeof onOrange === "function" && (await onOrange(verdict, { method, request })) === true);
      const hint = authorization && onOrange === "allow" ? '; an EIP-7702 authorization is signed on orange only when your onOrange function says yes' : "";
      if (!ok) throw new PresignBlockedError(`not signed: orange (${why})${hint}`, { code: "orange", verdict, request });
    } else if (verdict.verdict !== "green") {
      throw new PresignBlockedError(`not signed: unknown verdict ${verdict.verdict}`, { code: "check_failed", verdict, request });
    }
    return verdict;
  }

  // Within the limits (or approved by onOverLimit): book, sign, and give it back if signing fails.
  async function withinLimits(method, request, verdict, run) {
    const ctx = purchases.getStore();
    const purchase = ctx?.info ?? null;
    let booked;
    try {
      booked = await limiter.reserve({ method, request, verdict, purchase });
    } catch (err) {
      throw new PresignBlockedError(`spending limits could not be checked (${err.message}); nothing was signed`, { code: "limit_unavailable", verdict, request });
    }
    if (!booked.ok) {
      const err = new PresignBlockedError(`not signed: ${booked.summary}`, { code: booked.paused ? "paused" : "over_limit", verdict, request });
      err.reasons = booked.reasons;
      throw err;
    }
    if (booked.purchaseId) ctx?.purchaseIds.push(booked.purchaseId);
    let result;
    try {
      result = await run();
    } catch (err) {
      await limiter.release(booked.entries, { purchaseId: booked.purchaseId, error: err.message }).catch((e) => console.warn(`[presign-guard-wallet] could not give back spending: ${e.message}`));
      throw err;
    }
    limiter.spent(booked.entries, result, { verdict, purchase, purchaseId: booked.purchaseId, approval: booked.approval ?? null });
    return result;
  }

  // Several spends signed at once (a batch): every one booked before anything is signed, so each counts toward the
  // window (perTx applies to each call on its own); all given back when one doesn't fit or signing fails.
  async function withinLimitsAll(method, items, run) {
    const ctx = purchases.getStore();
    const purchase = ctx?.info ?? null;
    const booked = [];
    const giveBack = (error) => Promise.all(booked.map((b) => limiter.release(b.entries, { purchaseId: b.purchaseId, error }).catch((e) => console.warn(`[presign-guard-wallet] could not give back spending: ${e.message}`))));
    for (const { request, verdict } of items) {
      let b;
      try {
        b = await limiter.reserve({ method, request, verdict, purchase });
      } catch (err) {
        await giveBack(err.message);
        throw new PresignBlockedError(`spending limits could not be checked (${err.message}); nothing was signed`, { code: "limit_unavailable", verdict, request });
      }
      if (!b.ok) {
        await giveBack(b.summary);
        const err = new PresignBlockedError(`not signed: ${b.summary}`, { code: b.paused ? "paused" : "over_limit", verdict, request });
        err.reasons = b.reasons;
        throw err;
      }
      booked.push({ ...b, verdict });
      if (b.purchaseId) ctx?.purchaseIds.push(b.purchaseId);
    }
    let result;
    try {
      result = await run();
    } catch (err) {
      await giveBack(err.message);
      throw err;
    }
    for (const b of booked) limiter.spent(b.entries, result, { verdict: b.verdict, purchase, purchaseId: b.purchaseId, approval: b.approval ?? null });
    return result;
  }

  // Tempo: only a plain stablecoin transfer, checked here instead of by presign-guard.
  function tempoRequest(method, args, chainId) {
    const tokens = TEMPO_TOKENS[chainId];
    const ok = (SAME_AS[method] ?? method) === "writeContract" && tokens.includes(String(args?.address ?? "").toLowerCase())
      && TEMPO_TRANSFERS.has(args?.functionName) && !(BigInt(args?.value ?? 0n) > 0n);
    let request = null;
    try { request = ok ? checkRequestFor(method, args, { chainId, origin }) : null; } catch { request = null; }
    if (!request) throw new PresignBlockedError(`on Tempo (chain ${chainId}) this wallet only sends USDC.e transfers; nothing was signed`, { code: "unsupported_chain" });
    return request;
  }

  // EIP-7702 authorizations this wallet signed after a check, so the transaction that carries them is not
  // charged for a second check.
  const checkedAuthorizations = new Set();

  // An EIP-7702 authorization moves nothing by itself but hands the contract the whole wallet: checked (stricter
  // on orange and on errors, see verdictFor), counted toward no limit, signed for exactly the chain id checked.
  async function signAuthorizationGuarded(target, original, args, rest, chainId) {
    const request = checkRequestFor("signAuthorization", args, { chainId, origin, from: senderOf(args, target) });
    if (!request) throw new PresignBlockedError("an EIP-7702 authorization needs the contract's address; nothing was signed", { code: "check_failed" });
    await verdictFor("signAuthorization", request, request.chainId);
    // Signed exactly as checked: this contract, this chain id.
    const { contractAddress: _ignored, ...fields } = args;
    const signed = await original({ ...fields, address: request.address, chainId: request.authorizationChainId }, ...rest);
    const key = authorizationKey(signed);
    if (key) checkedAuthorizations.add(key);
    return signed;
  }

  // The signed EIP-7702 authorizations a transaction carries (authorizationList). Those this wallet signed with
  // signAuthorization were checked then; any other one signed by the sending account is checked now, the same way.
  // Authorizations signed by other accounts put nothing of this wallet at risk, and those for another chain do
  // nothing on this one.
  async function checkAuthorizationList(list, chainId, from) {
    for (const a of list) {
      const key = authorizationKey(a);
      if (key && checkedAuthorizations.has(key)) continue;
      const on = Number(a?.chainId);
      if (on !== 0 && on !== chainId) continue;
      let signer = null;
      try { signer = await recoverAuthorizationAddress({ authorization: a }); } catch { signer = null; }
      if (signer && from && signer.toLowerCase() !== from.toLowerCase()) continue;
      // viem sends a signed authorization's `address` as the contract.
      const request = checkRequestFor("signAuthorization", { address: a?.address, chainId: a?.chainId, nonce: a?.nonce }, { chainId, origin, from });
      if (!request) throw new PresignBlockedError("an EIP-7702 authorization in authorizationList has no contract address; nothing was signed", { code: "check_failed" });
      await verdictFor("signAuthorization", request, request.chainId);
    }
  }

  // EIP-5792 batches (sendCalls, sendCallsSync): every call is checked like a transaction from the same wallet and
  // counts toward the limits; one red or stopped call stops the whole batch, before anything is signed.
  async function sendCallsGuarded(target, method, original, args, rest, chainId) {
    if (TEMPO_TOKENS[chainId]) throw new PresignBlockedError(`on Tempo (chain ${chainId}) this wallet sends no batches; nothing was signed`, { code: "unsupported_chain" });
    const calls = Array.isArray(args?.calls) ? args.calls : [];
    if (!calls.length) throw new PresignBlockedError("a batch without calls; nothing was signed", { code: "check_failed" });
    const from = senderOf(args, target);
    const checked = [];
    for (const call of calls) {
      // A call is { to, data, value } or { to, abi, functionName, args, value }, as viem takes them.
      const request = call?.abi
        ? checkRequestFor("writeContract", { address: call.to, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value }, { chainId, origin, from })
        : checkRequestFor("sendTransaction", call, { chainId, origin, from });
      // A deployment in the batch: not checked, but the value it sends counts.
      if (!request) checked.push({ request: { type: "transaction", chainId, to: null, data: call?.data ?? "0x", value: String(call?.value ?? 0n) }, verdict: null });
      else checked.push({ request, verdict: await verdictFor(method, request, chainId) });
    }
    const run = () => original(args, ...rest);
    return limiter ? withinLimitsAll(method, checked, run) : run();
  }

  async function guarded(target, method, original, args, rest) {
    if (paused) throw new PresignBlockedError(`wallet is paused; nothing was signed`, { code: "paused" });
    const chainId = args?.chain?.id ?? target.chain?.id;
    const run = () => original(args, ...rest);
    if (BATCHES.has(method)) return sendCallsGuarded(target, method, original, args, rest, chainId);
    if (method === "signAuthorization") {
      if (TEMPO_TOKENS[chainId]) throw new PresignBlockedError(`on Tempo (chain ${chainId}) this wallet signs no EIP-7702 authorization; nothing was signed`, { code: "unsupported_chain" });
      return signAuthorizationGuarded(target, original, args, rest, chainId);
    }
    const authorizations = Array.isArray(args?.authorizationList) ? args.authorizationList : [];
    if (authorizations.length && TEMPO_TOKENS[chainId]) throw new PresignBlockedError(`on Tempo (chain ${chainId}) this wallet sends no EIP-7702 authorizations; nothing was signed`, { code: "unsupported_chain" });
    // A plain message moves nothing by itself, so it is checked but not counted toward the limits.
    if (method === "signMessage") {
      const request = checkRequestFor(method, args, { chainId, origin, from: senderOf(args, target) });
      if (request) await verdictFor(method, request, chainId);
      return run();
    }
    if (TEMPO_TOKENS[chainId]) {
      const request = tempoRequest(method, args, chainId);
      return limiter ? withinLimits(method, request, null, run) : run();
    }
    if (authorizations.length) await checkAuthorizationList(authorizations, chainId, senderOf(args, target));
    const request = checkRequestFor(method, args, { chainId, origin, x402: x402Paying.getStore(), from: senderOf(args, target) });
    if (!request) {
      // A contract deployment is not checked, but the value it sends still counts.
      if (limiter && (SAME_AS[method] ?? method) === "sendTransaction") {
        return withinLimits(method, { type: "transaction", chainId, to: null, data: args?.data ?? "0x", value: String(args?.value ?? 0n) }, null, run);
      }
      return run();
    }
    const verdict = await verdictFor(method, request, chainId);
    return limiter ? withinLimits(method, request, verdict, run) : run();
  }

  // XRP Ledger: sign a Payment only after presign-guard's check and within the limits.
  async function xrplSign(signer, network, tx) {
    if (paused) throw new PresignBlockedError(`wallet is paused; nothing was signed`, { code: "paused" });
    if (!tx || typeof tx !== "object" || tx.TransactionType !== "Payment") {
      throw new PresignBlockedError(`on the XRP Ledger this wallet only signs Payment transactions (got ${tx?.TransactionType ?? "nothing"}); nothing was signed`, { code: "unsupported_chain" });
    }
    if (tx.Account && signer.classicAddress && tx.Account !== signer.classicAddress) {
      throw new PresignBlockedError(`the transaction's Account ${tx.Account} is not this signer (${signer.classicAddress}); nothing was signed`, { code: "unsupported_chain" });
    }
    const request = { type: "xrpl", network, tx: JSON.parse(JSON.stringify(tx)), ...(origin ? { origin } : {}) };
    const verdict = await verdictFor("signXrplPayment", request, network);
    const run = () => signer.sign(tx);
    return limiter ? withinLimits("signXrplPayment", request, verdict, run) : run();
  }

  // Algorand: sign only a USDC transfer from this address, within the limits (checked here, no presign-guard
  // call); with any, anything else goes to presign-guard first (algorandSignAny).
  async function algorandSign(signer, network, txns, indexesToSign, any) {
    if (paused) throw new PresignBlockedError(`wallet is paused; nothing was signed`, { code: "paused" });
    const mine = (indexesToSign ?? txns.map((_, i) => i)).filter((i) => Number.isInteger(i) && i >= 0 && i < txns.length);
    if (mine.length !== 1) {
      if (any) return algorandSignAny(signer, network, txns, indexesToSign);
      throw new PresignBlockedError(`on Algorand this wallet signs one USDC transfer per payment (asked for ${mine.length}); nothing was signed`, { code: "unsupported_chain" });
    }
    let t;
    try { t = readAlgorandTxn(txns[mine[0]]); } catch (err) { throw new PresignBlockedError(`could not read the Algorand transaction (${err.message}); nothing was signed`, { code: "unsupported_chain" }); }
    const usdc = ALGORAND_USDC[network];
    const why = t.type !== "axfer" ? `it is a "${t.type}" transaction, not an asset transfer`
      : t.sender !== signer.address ? "it is not sent from this account"
      : t.assetId !== usdc ? `asset ${t.assetId} is not USDC (${usdc})`
      : t.closeTo ? "it closes the account's USDC out"
      : t.rekeyTo ? "it rekeys the account"
      : t.clawbackFrom ? "it is a clawback"
      : !t.receiver ? "it has no receiver"
      : null;
    if (why && any) return algorandSignAny(signer, network, txns, indexesToSign);
    if (why) throw new PresignBlockedError(`on Algorand this wallet only sends USDC: ${why}; nothing was signed`, { code: "unsupported_chain" });
    const request = { type: "algorand", network, txn: { type: t.type, sender: t.sender, receiver: t.receiver, amount: String(t.amount), assetId: String(t.assetId) }, ...(origin ? { origin } : {}) };
    const run = () => signer.signTransactions(txns, mine);
    return limiter ? withinLimits("signAlgorandTransfer", request, null, run) : run();
  }

  // Any other Algorand transaction or group (algorandSigner with any): the whole group goes to presign-guard (type
  // "algorand", which also simulates it); red is never signed. What this account's own transactions send, read
  // from the transactions themselves, counts toward the limits.
  async function algorandSignAny(signer, network, txns, indexesToSign) {
    let read;
    try { read = txns.map((b) => readAlgorandTxn(b)); } catch (err) {
      throw new PresignBlockedError(`could not read the Algorand transactions (${err.message}); nothing was signed`, { code: "unsupported_chain" });
    }
    const mine = indexesToSign ?? read.flatMap((t, i) => (t.sender === signer.address ? [i] : []));
    if (!mine.length || mine.some((i) => !Number.isInteger(i) || i < 0 || i >= txns.length || read[i].sender !== signer.address)) {
      throw new PresignBlockedError("on Algorand this wallet signs only transactions sent from its own account; nothing was signed", { code: "unsupported_chain" });
    }
    const request = { type: "algorand", transactions: txns.map((b) => Buffer.from(b).toString("base64")), from: signer.address, ...(origin ? { origin } : {}) };
    const verdict = await verdictFor("signAlgorandTransaction", request, network);
    if (verdict?.subject?.network && verdict.subject.network !== network) {
      throw new PresignBlockedError(`the transactions are for ${verdict.subject.network}, not ${network}; nothing was signed`, { code: "unsupported_chain", verdict, request });
    }
    const str = (v) => (v === null || v === undefined ? null : String(v));
    const group = mine.map((i) => read[i]).map((t) => ({ type: t.type, sender: t.sender, receiver: t.receiver, amount: str(t.amount), assetId: str(t.assetId), closeTo: t.closeTo, rekeyTo: t.rekeyTo, clawbackFrom: t.clawbackFrom }));
    const run = () => signer.signTransactions(txns, mine);
    return limiter ? withinLimits("signAlgorandTransaction", { type: "algorand", network, from: signer.address, group }, verdict, run) : run();
  }

  // Solana: sign only an x402 payment (one USDC TransferChecked from this account, compute-budget settings and a
  // memo), each checked by presign-guard (decoded and simulated) and counted toward the USDC limit.
  async function solanaSign(signer, network, transactions, config, any) {
    const out = [];
    for (const tx of transactions) {
      if (paused) throw new PresignBlockedError(`wallet is paused; nothing was signed`, { code: "paused" });
      let payment;
      try { payment = readSolanaPayment(tx.messageBytes, signer.address, network); } catch (err) {
        if (!any) throw new PresignBlockedError(`on Solana this wallet only signs x402 USDC payments: ${err.message}; nothing was signed`, { code: "unsupported_chain" });
        out.push(await solanaSignAny(signer, network, tx, config));
        continue;
      }
      const request = { type: "solana", transaction: wireTransaction(tx.messageBytes, payment.numSigners), from: signer.address, ...(origin ? { origin } : {}) };
      const verdict = await verdictFor("signSolanaTransfer", request, network);
      const run = async () => (await signer.signTransactions([tx], config))[0];
      const spend = { type: "solana", network, transfer: { mint: payment.mint, amount: String(payment.amount), destination: payment.destination } };
      out.push(await (limiter ? withinLimits("signSolanaTransfer", spend, verdict, run) : run()));
    }
    return out;
  }

  // Any other Solana transaction (solanaSigner with any): checked by presign-guard, which also simulates it;
  // what the signed simulation shows leaving the wallet counts toward the limits.
  async function solanaSignAny(signer, network, tx, config) {
    let numSigners;
    try { ({ numSigners } = readSolanaMessage(tx.messageBytes)); } catch (err) {
      throw new PresignBlockedError(`not a Solana transaction this wallet can read (${err.message}); nothing was signed`, { code: "unsupported_chain" });
    }
    const request = { type: "solana", transaction: wireTransaction(tx.messageBytes, numSigners), from: signer.address, ...(origin ? { origin } : {}) };
    const verdict = await verdictFor("signSolanaTransaction", request, network);
    const run = async () => (await signer.signTransactions([tx], config))[0];
    return limiter ? withinLimits("signSolanaTransaction", { type: "solana", network, simulated: true, from: signer.address }, verdict, run) : run();
  }

  const extras = {
    /**
     * The same guard on an XRP Ledger signer ({ classicAddress, sign(tx) }, e.g. createXrplWalletSigner
     * from @x402/xrpl): only Payment transactions, each checked by presign-guard and counted toward the
     * limits (RLUSD toward USDC, XRP toward an XRP limit). network: "xrpl:0" (default) or "xrpl:1".
     */
    xrplSigner: (signer, { network = "xrpl:0" } = {}) => {
      if (!signer || typeof signer.sign !== "function") throw new TypeError("xrplSigner(signer): signer needs a sign(tx) function (e.g. createXrplWalletSigner from @x402/xrpl)");
      if (!XRPL_NETWORKS.includes(network)) throw new TypeError(`xrplSigner: network must be one of ${XRPL_NETWORKS.join(", ")}`);
      return { classicAddress: signer.classicAddress, sign: (tx) => xrplSign(signer, network, tx) };
    },
    /**
     * A guarded viem account for MPP sessions on Tempo (e.g. mppx's sessionManager): it signs only
     * a transaction that opens or tops up a payment channel in Tempo's escrow, in USDC.e, for this
     * account (the deposit counts toward the USDC limits, booked to the payee, when it is signed),
     * and the channel's vouchers and close authorizations (EIP-712, escrow domain; they only move
     * money already deposited). Raw hashes, messages and anything else are refused.
     */
    tempoSessionAccount: (account, { chainId = 4217 } = {}) => {
      if (!TEMPO_TOKENS[chainId]) throw new TypeError(`tempoSessionAccount: chainId must be ${Object.keys(TEMPO_TOKENS).join(" or ")}`);
      if (!account || typeof account.signTransaction !== "function" || typeof account.signTypedData !== "function") throw new TypeError("tempoSessionAccount(account): account must be a local viem account (privateKeyToAccount)");
      const refuse = (what) => async () => { throw new PresignBlockedError(`MPP session account: ${what} is not signed; nothing was signed`, { code: "unsupported_chain" }); };
      return {
        ...account,
        sign: refuse("a raw hash"),
        signMessage: refuse("a message"),
        signAuthorization: refuse("an EIP-7702 authorization"),
        signTypedData: async (typedData) => {
          if (paused) throw new PresignBlockedError(`wallet is paused; nothing was signed`, { code: "paused" });
          const d = typedData?.domain ?? {};
          const ok = ["Voucher", "CloseAuthorization"].includes(typedData?.primaryType) && d.name === VOUCHER_DOMAIN
            && String(d.verifyingContract ?? "").toLowerCase() === TEMPO_ESCROW && Number(d.chainId) === chainId;
          if (!ok) throw new PresignBlockedError(`MPP session account: only channel vouchers on Tempo's escrow are signed (got ${typedData?.primaryType ?? "nothing"}); nothing was signed`, { code: "unsupported_chain" });
          return account.signTypedData(typedData);
        },
        signTransaction: async (tx, opts) => {
          if (paused) throw new PresignBlockedError(`wallet is paused; nothing was signed`, { code: "paused" });
          const { token, payee, deposit } = sessionDeposit(tx, chainId, account.address);
          const run = () => account.signTransaction(tx, opts);
          if (!limiter) return run();
          const request = checkRequestFor("writeContract", { address: token, abi: TRANSFER_ABI, functionName: "transfer", args: [payee, deposit] }, { chainId, origin });
          return withinLimits("writeContract", request, null, run);
        },
      };
    },
    /**
     * The same guard on an x402 AVM client signer ({ address, signTransactions(txns, indexesToSign) }, e.g.
     * toClientAvmSigner from @x402/avm): of the transactions it is asked to sign it signs only an asset transfer
     * of USDC on that network from this address (no close-out, rekey or clawback), counted toward the USDC limit.
     * The facilitator's fee-payer transaction in the same group is not this signer's and is left unsigned.
     * network: the x402 id of Algorand mainnet (default) or testnet. any: also sign other transactions and
     * groups (payments in ALGO, asset transfers, app calls), each group checked by presign-guard first; what
     * this account's transactions send counts toward the limits (ALGO toward ALGO, USDC toward USDC).
     */
    /**
     * The same guard on a Solana signer for x402's SVM client (a @solana/kit TransactionPartialSigner, e.g.
     * createKeyPairSignerFromBytes): it signs only an x402 payment (one USDC TransferChecked from this account),
     * checked by presign-guard (decoded and simulated) and counted toward the USDC limit. network: mainnet
     * (default) or devnet, as x402 CAIP-2 ids. any: also sign other transactions (transfers, swaps), each
     * checked by presign-guard; what its simulation shows leaving the wallet counts toward the limits.
     */
    solanaSigner: (signer, { network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", any = false } = {}) => {
      if (!signer || typeof signer.signTransactions !== "function" || typeof signer.address !== "string") throw new TypeError("solanaSigner(signer): signer needs address and signTransactions(transactions) (a @solana/kit TransactionPartialSigner, e.g. createKeyPairSignerFromBytes)");
      if (!SOLANA_USDC[network]) throw new TypeError(`solanaSigner: network must be one of ${Object.keys(SOLANA_USDC).join(", ")}`);
      return { address: signer.address, signTransactions: (transactions, config) => solanaSign(signer, network, transactions, config, any === true) };
    },
    algorandSigner: (signer, { network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", any = false } = {}) => {
      if (!signer || typeof signer.signTransactions !== "function" || typeof signer.address !== "string") throw new TypeError("algorandSigner(signer): signer needs address and signTransactions(txns, indexesToSign) (e.g. toClientAvmSigner from @x402/avm)");
      if (!ALGORAND_USDC[network]) throw new TypeError(`algorandSigner: network must be one of ${Object.keys(ALGORAND_USDC).join(", ")}`);
      return { address: signer.address, signTransactions: (txns, indexesToSign) => algorandSign(signer, network, txns, indexesToSign, any === true) };
    },
    /** Stop every checked method until resume(). */
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    paused: () => paused,
    /**
     * The same guard (checks, limits, pause, purchases) on another viem WalletClient, e.g. one
     * for Tempo next to the one for Base: both spend from one budget.
     */
    wrap: (other) => {
      if (!other || typeof other !== "object") throw new TypeError("wrap(wallet): wallet must be a viem WalletClient");
      return proxyFor(other);
    },
    /** Per token: the limits, what was spent in the current window and what is left (null without limits). */
    spending: async () => (limiter ? limiter.spending() : null),
    /**
     * Say what is being bought: every signature fn makes is recorded with { url, description }
     * (onSpend, the wallet server's receipts, its Telegram approval messages). fn gets a
     * report(outcome) function for what happened afterwards, e.g. { httpStatus, settlement }.
     * opts.onChecked(check, out): called before withPurchase returns when the wallet server checked the
     * reported answer ({ delivered, injection }); what it returns is returned instead of out.
     */
    withPurchase: async (info, fn, opts = {}) => {
      if (typeof fn !== "function") throw new TypeError("withPurchase(info, fn): fn must be a function");
      const ctx = { info: cleanPurchase(info), purchaseIds: [], outcome: null };
      const report = (outcome) => { ctx.outcome = outcome && typeof outcome === "object" ? outcome : null; };
      const annotate = async (extra) => {
        if (!limiter?.annotate || !ctx.purchaseIds.length || (!ctx.outcome && !extra)) return;
        return limiter.annotate(ctx.purchaseIds, { ...(ctx.outcome ?? {}), ...(extra ?? {}) }).catch((e) => console.warn(`[presign-guard-wallet] could not record the outcome: ${e.message}`));
      };
      let out;
      try {
        out = await purchases.run(ctx, () => fn(report));
      } catch (err) {
        await annotate({ error: String(err?.message ?? err).slice(0, 300) });
        throw err;
      }
      const reply = await annotate();
      if (reply?.check && typeof opts.onChecked === "function") {
        try { return await opts.onChecked(reply.check, out); } catch (e) { console.warn(`[presign-guard-wallet] onChecked threw: ${e.message}`); }
      }
      return out;
    },
  };

  const proxyFor = (w) => new Proxy(w, {
    get(target, prop, receiver) {
      if (Object.hasOwn(extras, prop) && !(prop in target)) return extras[prop];
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !(GUARDED.has(prop) || (checkMessages && prop === "signMessage")) || typeof value !== "function") return value;
      return (args, ...rest) => guarded(target, prop, value.bind(target), args, rest);
    },
  });
  return proxyFor(wallet);
}
