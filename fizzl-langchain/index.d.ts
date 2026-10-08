import type { StructuredToolInterface } from "@langchain/core/tools";

export declare const VERSION: string;
export declare const PRESIGN_URL: string;
export declare const DOCTOR_URL: string;
export declare const PRICES: Record<FizzlToolName, string>;

export type FizzlToolName = "check_before_signing" | "check_xrpl_transaction" | "check_token" | "check_wallet_approvals" | "check_endpoint_before_paying";

export interface FizzlToolsOptions {
  /** fetch that pays x402 (wrapFetchWithPayment from @x402/fetch); plain fetch works with credit keys. */
  fetch?: typeof fetch;
  /** Prepaid credit keys (sent as x-credit-key), per service. */
  creditKeys?: { presign?: string; doctor?: string };
  /** The tools to include (default: all five). */
  only?: FizzlToolName[];
  /** Fall back to the free quick check (verdict only, a few per hour) when a check can't be paid. Default true. */
  free?: boolean;
  presignUrl?: string;
  doctorUrl?: string;
  timeoutMs?: number;
}

/** LangChain tools; each returns the check's answer as a JSON string (or `{ "error", "message" }`). */
export declare function fizzlTools(options?: FizzlToolsOptions): StructuredToolInterface[];
