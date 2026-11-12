import type { x402Client } from "@x402/fetch";

export declare const DOCTOR_URL: string;
export declare const PREFLIGHT_CAP: string;
export declare const DIAGNOSE_CAP: string;
export declare const VERSION: string;
export declare const BASE: "eip155:8453";
export declare const SOLANA: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export declare const ALGORAND: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export declare const ALGORAND_TESTNET: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export declare const XRPL: "xrpl:0";
export declare const XRPL_TESTNET: "xrpl:1";
export declare const STELLAR: "stellar:pubnet";
export declare const STELLAR_TESTNET: "stellar:testnet";
export declare const XLAYER: "eip155:196";
/** The option paid on `network`: on Algorand only USDC, on Stellar only Circle's USDC contract within maxUsd, on X Layer only USD₮0 or USDC within maxUsd, on the XRP Ledger only RLUSD from Ripple's issuer within maxUsd (in dollars); null when there is none. */
/** What a 402 offers (per x402 option: scheme, network, asset, amount, payTo) as a stable string; null without a readable x402 challenge. Consumes the body. */
export declare function offerFingerprint(res: Response): Promise<string | null>;
/** Wraps an Algorand scheme (e.g. @x402/avm's ExactAvmScheme) so it pays sellers that name Algorand by the whole genesis hash as well as by the CAIP-2 id. createSafeFetch does this for you. */
export declare function anyAlgorandId<S extends object>(scheme: S): S;
export declare function payableOption<A extends { network: string; asset?: unknown; amount?: unknown; extra?: Record<string, unknown> }>(accepts: A[], network: string, maxUsd: number | string): A | null;

/** The x402 Doctor preflight: see https://x402-doctor.fizzl.eu/openapi.json */
export interface Preflight {
  verdict: "go" | "caution" | "no_go";
  summary?: string;
  reasons?: Array<{ level: string; code?: string; message: string }>;
  signals?: Record<string, unknown>;
  checked?: Array<{ check: string; what: string }>;
  not_checked?: Array<{ check: string; because: "unavailable" | "no_data" | "not_sent" | "out_of_scope"; why: string; send?: string }>;
  /** false when a check that applies couldn't run this time */
  checks_complete?: boolean;
  [key: string]: unknown;
}

/** The x402 Doctor diagnosis of an endpoint: every check with a fix hint (GET /api/v1/diagnose). */
export interface Diagnosis {
  overall: "pass" | "warn" | "fail";
  checks: Array<{ id: string; status: "pass" | "warn" | "fail" | "info"; message: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export declare class SafePayError extends Error {
  code: "no_go" | "caution" | "incomplete" | "preflight_failed" | "bad_receipt" | "no_option" | "paid_no_delivery" | "over_total_budget" | "over_seller_budget" | "answer_injection" | "other_site";
  preflight: Preflight | null;
  url: string | null;
  /** With code "paid_no_delivery": when the same request was paid before, and what it was answered with. */
  earlier?: { at: number; status: number; redirectedFrom?: string; pollOf?: string };
  /** With code "over_total_budget" or "over_seller_budget": what this safeFetch had paid. */
  spent?: SpentUsd;
  /** Set when diagnoseOnFailure diagnosed a payment that failed. */
  diagnosis?: Diagnosis;
  /** With code "answer_injection": presign-guard's verdict, and the held-back answer (marked x-answer-check: red). */
  check?: AnswerCheck;
  response?: Response;
}

export interface SafeFetchOptions {
  /** Registers your payment schemes, e.g. (c) => c.register("eip155:8453", new ExactEvmScheme(account)). */
  register: (client: x402Client) => unknown;
  /** The network you pay on: "base", "solana", "algorand" (USDC), "xrpl" (RLUSD), "stellar" (USDC), "xlayer" (USD₮0 or USDC), their "-testnet" forms, or a CAIP-2 id. Default Base. */
  network?: string;
  /** Budget per endpoint call in USD. Default 0.05. */
  maxUsd?: number | string;
  /** Budget in USD for every payment this safeFetch makes together (make one per task or session). Past it: code "over_total_budget". Default none. */
  maxTotalUsd?: number | string;
  /** Budget in USD per seller (the endpoint's host). Past it: code "over_seller_budget". Default none. */
  maxPerSellerUsd?: number | string;
  /** What to do on a caution verdict. Default "stop". */
  onCaution?: "stop" | "pay" | ((preflight: Preflight) => boolean | Promise<boolean>);
  /** What to do on a "go" whose checks_complete is false (a check that applies couldn't run). Default "pay"; "stop" throws code "incomplete". */
  onIncomplete?: "pay" | "stop" | ((preflight: Preflight) => boolean | Promise<boolean>);
  /** Hosts you already trust: paid without a preflight. */
  trusted?: string[];
  /** The sites this safeFetch may pay (hosts or URLs, e.g. the ones the user named); elsewhere: code "other_site". Default: any site. */
  sites?: string[];
  onPreflight?: (preflight: Preflight, info: { url: string; method: string; cached: boolean }) => void;
  /** How long a verdict is reused while the endpoint's 402 offers the same thing, in ms. Default 1 hour; a changed price, payout address, token or network is checked again at once; at most 10 minutes when the offer can't be read. */
  cacheMs?: number;
  doctorUrl?: string;
  /** Check Doctor's signed receipt on every preflight (signer, and bound to this request). Default "require". */
  verifyReceipts?: "require" | "off";
  /** Accepted Doctor signer addresses. Default: the published signer (DOCTOR_SIGNERS). */
  doctorSigners?: string[];
  /** Wallet whose certificates (receipt.cert) also make a signer trusted, so a rotated Doctor key keeps working. Default: the Fizzl payout wallet; null accepts only doctorSigners. */
  authority?: string | null;
  /** When a payment still fails (402 again, or paying throws), buy a $0.01 Doctor diagnosis of why. Default false. */
  diagnoseOnFailure?: boolean;
  onDiagnosis?: (report: Diagnosis, info: { url: string; method: string; status: number | null; error: Error | null }) => void;
  /** After paying, tell Doctor whether the payment worked (with the signed preflight as proof), so later preflights learn from it; when it does not pay (no_go, or a caution it stops at), report "refused" with the reason code, so the seller learns why. Default false. */
  shareOutcomes?: boolean;
  /** When not paying, tell the seller why if its 402 names a refusal url on its own site (draft x402-foundation/x402#4087). Default false. */
  tellSellers?: boolean;
  /** The same request (method, URL, body) was paid before and answered without delivering (an error, or another 402): "stop" (default) throws code "paid_no_delivery" without paying, "pay" pays again, a function decides. */
  onPaidError?: "stop" | "pay" | ((earlier: { at: number; status: number; redirectedFrom?: string; pollOf?: string }, info: { url: string; method: string }) => boolean | Promise<boolean>);
  /** How long such a request stays blocked, in ms. Default 30 minutes. A success clears it. */
  paidErrorMs?: number;
  /** Check every paid answer for instructions aimed at your agent (prompt injection) with presign-guard before you get it: "quick" (free, verdict only, 10 an hour), "paid" ($0.01 a check, with reasons) or false (default). */
  checkAnswers?: false | "quick" | "paid";
  /** A red answer: "stop" (default) throws code "answer_injection" (paid, answer held back), "flag" returns it with x-answer-check: red, a function decides (true returns it). */
  onInjection?: "stop" | "flag" | ((check: AnswerCheck, info: { url: string; method: string }) => boolean | Promise<boolean>);
  onAnswerCheck?: (check: AnswerCheck, info: { url: string; method: string }) => void;
  /** presign-guard's origin. Default https://presign-guard.fizzl.eu. */
  injectionUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Advanced/testing: a paying fetch capped at `cap` (e.g. "$0.05"). */
  createPayingFetch?: (cap: string) => typeof globalThis.fetch;
  now?: () => number;
}

/** presign-guard's verdict on a paid answer (checkAnswers). "paid" adds reasons and a signed receipt. */
export interface AnswerCheck {
  verdict: "green" | "orange" | "red";
  reasons?: { level?: string; code?: string; message?: string }[];
  [key: string]: unknown;
}
/** What checkAnswers found in a paid answer: "green", "orange", "red", "unchecked", or null when it wasn't checked. */
export declare function answerCheckOf(response: Response): "green" | "orange" | "red" | "unchecked" | null;
export declare const PRESIGN_GUARD_URL: string;
export declare const INJECTION_CAP: string;
export declare const ANSWER_CHECK_HEADER: string;

/** What a safeFetch paid to sellers, in USD (Doctor's preflights and diagnoses not included). */
export interface SpentUsd {
  totalUsd: number;
  bySeller: Record<string, number>;
}
export interface SafeFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
  /** What this safeFetch paid to sellers so far. */
  spent(): SpentUsd;
}
export declare function createSafeFetch(options: SafeFetchOptions): SafeFetch;
/** What an option costs in USD on `network` (USDC and USD₮0: 6 decimals; Stellar USDC: 7; RLUSD: decimal dollars), or null. */
/** Why createSafeFetch refuses a Bitcoin Lightning (lnbtc) network: its price is in BTC, so the dollar budget can't hold. */
export declare const LIGHTNING_UNSUPPORTED: string;
/** What an option costs in USD on `network` (Lightning: null). */
export declare function usdOfOption(option: { amount?: unknown; maxAmountRequired?: unknown }, network: string): number | null;
export declare function usdCap(maxUsd: number | string): string;
/** payTo: the payout address the agent is about to pay (sent as pay_to; anything that isn't one address is left out). */
export declare function preflightUrl(target: string, options?: { method?: string; maxUsd?: number | string; network?: string; doctorUrl?: string; payTo?: string }): string;
export declare function diagnoseUrl(target: string, options?: { method?: string; doctorUrl?: string }): string;
/** The Doctor diagnosis attached to a response whose payment failed (diagnoseOnFailure), or null. */
export declare function diagnosisOf(response: Response): Diagnosis | null;
export declare function receiptOf(response: Response): { transaction?: string; network?: string; success?: boolean; [key: string]: unknown } | null;

export declare const DOCTOR_SIGNERS: string[];
export declare function canonicalJson(value: unknown): string;
export declare function inputHash(route: string, input: unknown): string;
export declare function recoverSigner(message: string, signature: string): string | null;
export declare const AUTHORITY: string;
export declare function certMessage(cert: { service: string; signer: string; valid_from: string }): string;
export declare function verifyReceipt(body: unknown, options?: { signers?: string[]; route?: string; input?: unknown; authority?: string | null; service?: string }): { valid: boolean; signer?: string; reason?: string };

/** The reason code reported with a refused outcome: the preflight's first reason at its verdict's level. */
export function refusalReason(preflight: { verdict?: string; reasons?: { level?: string; code?: string }[] }): string;

/** Remembers paid endpoints (method, origin and path) that took a payment without delivering, so they aren't paid again with any query or body (used by createSafeFetch; usable on its own). */
export declare function createPaidGuard(options?: { windowMs?: number; now?: () => number }): {
  blocked(url: string, init?: { method?: string; body?: unknown }): { at: number; status: number; redirectedFrom?: string; pollOf?: string } | null;
  record(url: string, init: { method?: string; body?: unknown } | undefined, status: number, options?: { redirectedTo?: string | null; pollAt?: string | null }): void;
  /** A result handed over without payment (a 2xx other than 202): ends a 202 hold on this endpoint or the one it polls for. */
  delivered(url: string, init?: { method?: string; body?: unknown }): void;
  clear(url: string, init?: { method?: string; body?: unknown }): void;
};
export declare function purchaseKey(url: string, init?: { method?: string; body?: unknown }): string;
export declare function paidTwiceMessage(url: string, earlier: { at: number; status: number; redirectedFrom?: string; pollOf?: string }): string;
export declare const PAID_ERROR_MS: number;

/** The site behind a host or URL, as x402 Doctor groups sellers: the domain without subdomains; on shared hosting the full host. */
export declare function siteOf(value: string): string | null;
