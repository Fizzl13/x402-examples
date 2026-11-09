import type { z } from "zod";

export declare const VERSION: string;
export declare const PRESIGN_URL: string;
export declare const DOCTOR_URL: string;
export declare const BUY_URL: string;
export declare const PRICES: Record<FizzlToolName, string>;

export type FizzlToolName = "check_before_signing" | "check_xrpl_transaction" | "check_solana_transaction" | "check_algorand_transaction" | "check_message" | "check_token" | "check_wallet_approvals" | "screen_wallet" | "check_endpoint_before_paying" | "buy_live_data";

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
  /** The tools to include (default: the nine checks, plus buy_live_data with `buy`). */
  only?: FizzlToolName[];
  /** Add buy_live_data: Fizzl Buy buys live data for the agent, $0.02 a purchase through `fetch`. Default false. */
  buy?: boolean;
  /** Fall back to the free quick check (verdict only, a few per hour) when a check can't be paid. Default true. */
  free?: boolean;
  presignUrl?: string;
  doctorUrl?: string;
  buyUrl?: string;
  timeoutMs?: number;
}

export declare function fizzlTools(options?: FizzlToolsOptions): Record<FizzlToolName, FizzlTool>;
