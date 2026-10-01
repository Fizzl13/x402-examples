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
  code: "red" | "orange" | "check_failed" | "bad_receipt" | "unsupported_chain";
  verdict: PresignVerdict | null;
  request: CheckRequest | null;
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
}

/** The same wallet client; sendTransaction, writeContract and signTypedData are checked first. */
export declare function guardWallet<W extends WalletClient>(wallet: W, options: GuardOptions): W;
export declare function checkRequestFor(method: string, args: unknown, options?: { chainId?: number; origin?: string }): CheckRequest | null;
