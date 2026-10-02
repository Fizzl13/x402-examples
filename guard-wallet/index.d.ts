import type { WalletClient } from "viem";

export declare const PRESIGN_URL: string;
export declare const PRESIGN_SIGNERS: string[];
export declare const SUPPORTED_CHAINS: number[];
export declare const VERSION: string;
export declare const CREDIT_HEADER: string;

/** A presign-guard verdict: see https://presign-guard.fizzl.eu/openapi.json */
export interface PresignVerdict {
  verdict: "green" | "orange" | "red";
  reasons?: Array<{ code: string; severity: "red" | "orange" | "info"; subject?: string; details?: Record<string, unknown> }>;
  subject?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What is sent to presign-guard's POST /v1/check. */
export type CheckRequest =
  | { type: "transaction"; chainId: number; to: string; data: string; value: string; origin?: string }
  | { type: "signature"; chainId: number; typedData: unknown; origin?: string };

export declare class PresignBlockedError extends Error {
  code: "red" | "orange" | "check_failed" | "bad_receipt" | "unsupported_chain" | "over_limit" | "paused" | "limit_unavailable";
  verdict: PresignVerdict | null;
  request: CheckRequest | null;
  /** With code "over_limit": which limits would be crossed. */
  reasons?: LimitReason[];
}

/** A limit in whole tokens, e.g. "5" or "0.002". */
export type TokenAmount = string | number;

export interface SpendingLimits {
  /**
   * Per token: "USDC" (native and bridged USDC on every supported chain), "ETH", "BNB", "POL" (the native coin),
   * a token address ("0x…", any chain) or "chainId:0x…"; tokens given by address need decimals.
   * Budgets are shared across chains: { USDC: { perDay: "20" } } is 20 USDC in total.
   */
  tokens?: Record<string, { perTx?: TokenAmount; perDay?: TokenAmount; decimals?: number }>;
  /** Spending of a token without a limit, or a signature whose spending cannot be read. Default "ask" (onOverLimit, else stop). */
  unknownTokens?: "stop" | "ask" | "allow";
  /** Only these recipients, spenders and contracts; anything else goes to onOverLimit. */
  allow?: string[];
  /** The rolling window perDay applies to. Default "24h". */
  window?: string | number;
}

export interface LimitReason {
  code: "per_tx" | "per_day" | "unknown_token" | "unknown_spend" | "not_allowed";
  message: string;
  budget?: string;
  amount?: string;
  limit?: string;
  used?: string;
  token?: string;
  to?: string | null;
}

export interface SpendingRow {
  token: string;
  perTx: string | null;
  perDay: string | null;
  used: string;
  left: string | null;
}

export interface OverLimitInfo {
  method: string;
  request: CheckRequest;
  verdict: PresignVerdict | null;
  reasons: LimitReason[];
  /** One line for a human, e.g. "8 USDC is over the limit of 20 per 24h (15 used)". */
  summary: string;
  spending: SpendingRow[];
  /** What the agent said it is buying (withPurchase), or null. */
  purchase: Purchase | null;
}

/** What is being bought, given to withPurchase. */
export interface Purchase {
  url?: string;
  description?: string;
}

/** What happened after signing, given to report() inside withPurchase. */
export interface PurchaseOutcome {
  httpStatus?: number;
  settlement?: { transaction?: string; network?: string; [key: string]: unknown };
  error?: string;
  [key: string]: unknown;
}

export interface SpendEntry {
  id: string;
  at: number;
  budget: string;
  /** In whole tokens. */
  amount: string;
  method: string;
  chainId: number;
  to: string | null;
  /** What the wallet method returned (transaction hash or signature). */
  result: unknown;
  verdict: PresignVerdict | null;
  receiptId: string | null;
  purchase: Purchase | null;
}

/** Where spending is kept. amount is a decimal string at 18 decimals. */
export interface SpendingStore {
  add(entry: { id: string; at: number; budget: string; amount: string; [key: string]: unknown }): Promise<void>;
  remove(id: string): Promise<void>;
  list(since: number): Promise<Array<{ id: string; at: number; budget: string; amount: string }>>;
}

export declare function memoryStore(): SpendingStore;

/** Added to the guarded wallet. */
export interface GuardControls {
  /** Stop every checked method (sendTransaction, writeContract, signTypedData) until resume(). */
  pause(): void;
  resume(): void;
  paused(): boolean;
  /** Per token: the limits, what was spent in the current window and what is left; null without limits. */
  spending(): Promise<SpendingRow[] | null>;
  /**
   * Record what is being bought: every signature made inside fn carries it (onSpend, the
   * wallet server's receipts, approval messages). Call report() with what happened afterwards.
   */
  withPurchase<T>(info: Purchase, fn: (report: (outcome: PurchaseOutcome) => void) => Promise<T> | T): Promise<T>;
}

export interface GuardOptions {
  /** A fetch that pays x402, e.g. wrapFetchWithPayment(fetch, client) with spend controls. Each check costs $0.01. Optional when creditKey is set. */
  pay?: typeof globalThis.fetch;
  /** A presign-guard credit key (pgc_…, from GET https://presign-guard.fizzl.eu/v1/credits/100 or /1000): checks are paid from prepaid credits first, then with pay. */
  creditKey?: string;
  /** Plain fetch used for credit-paid checks. Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** What to do on an orange verdict. Default "stop". */
  onOrange?: "stop" | "allow" | ((verdict: PresignVerdict, info: { method: string; request: CheckRequest }) => boolean | Promise<boolean>);
  /** When the check cannot be done (outage, unsupported chain). Default "stop". A forged or changed verdict always stops. */
  onError?: "stop" | "allow";
  /** The site asking for the signature, if any: domain age and phishing lists are checked. */
  origin?: string;
  onVerdict?: (verdict: PresignVerdict, info: { method: string; request: CheckRequest; paidWith: "credits" | "x402"; creditsLeft: number | null }) => void;
  presignUrl?: string;
  /** Check presign-guard's signed receipt on every verdict. Default "require". */
  verifyReceipts?: "require" | "off";
  /** Accepted signer addresses. Default: the published signer (PRESIGN_SIGNERS). */
  signers?: string[];
  /** Wallet whose certificates also make a signer trusted (key rotation). Default: the Fizzl payout wallet; null accepts only `signers`. */
  authority?: string | null;
  /** Spending limits per token, checked after presign-guard's verdict and before signing. */
  limits?: SpendingLimits;
  /** Asked when a limit would be crossed (e.g. ask the user on their phone). true = sign anyway. Without it, the wallet stops. */
  onOverLimit?: (info: OverLimitInfo) => boolean | Promise<boolean>;
  /** Called after each signed spend, e.g. for a log. */
  onSpend?: (entry: SpendEntry) => void;
  /** Where spending is kept. Default in memory (gone on a restart); fileStore from "presign-guard-wallet/file-store" for a file. */
  store?: SpendingStore;
  /** A wallet server keeps the limits, the shared budget and the approvals for all your agents (instead of limits, onOverLimit and store). */
  server?: { url: string; key: string; fetch?: typeof globalThis.fetch; requestTimeoutMs?: number };
}

/** The same wallet client; sendTransaction, writeContract and signTypedData are checked first. */
export declare function guardWallet<W extends WalletClient>(wallet: W, options: GuardOptions): W & GuardControls;
export declare function checkRequestFor(method: string, args: unknown, options?: { chainId?: number; origin?: string }): CheckRequest | null;
