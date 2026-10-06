import type { z } from "zod";

export declare const VERSION: string;
export declare const PRESIGN_URL: string;
export declare const DOCTOR_URL: string;
export declare const PRICES: Record<FizzlToolName, string>;

export type FizzlToolName = "check_before_signing" | "check_xrpl_transaction" | "check_token" | "check_wallet_approvals" | "check_endpoint_before_paying";

/** A failed check, returned to the model instead of thrown. */
export interface FizzlToolError { error: string; message: string }

/** Shaped like an AI SDK tool (what `tool()` from "ai" returns), so it can go straight into `tools`. */
export interface FizzlTool<INPUT = any> {
  description: string;
  inputSchema: z.ZodType<INPUT>;
  execute: (input: INPUT, options?: unknown) => Promise<Record<string, unknown> | FizzlToolError>;
}

export interface FizzlToolsOptions {
  /** fetch that pays x402 (wrapFetchWithPayment from @x402/fetch); plain fetch works with credit keys. */
  fetch?: typeof fetch;
  /** Prepaid credit keys (sent as x-credit-key), per service. */
  creditKeys?: { presign?: string; doctor?: string };
  /** The tools to include (default: all four). */
  only?: FizzlToolName[];
  /** Fall back to the free quick check (verdict only, a few per hour) when a check can't be paid. Default true. */
  free?: boolean;
  presignUrl?: string;
  doctorUrl?: string;
  timeoutMs?: number;
}

export declare function fizzlTools(options?: FizzlToolsOptions): Record<FizzlToolName, FizzlTool>;
