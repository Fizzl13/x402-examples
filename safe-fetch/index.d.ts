import type { x402Client } from "@x402/fetch";

export declare const DOCTOR_URL: string;
export declare const PREFLIGHT_CAP: string;
export declare const BASE: "eip155:8453";
export declare const SOLANA: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** The x402 Doctor preflight: see https://x402-doctor.onrender.com/openapi.json */
export interface Preflight {
  verdict: "go" | "caution" | "no_go";
  summary?: string;
  reasons?: Array<{ level: string; code?: string; message: string }>;
  signals?: Record<string, unknown>;
  [key: string]: unknown;
}

export declare class SafePayError extends Error {
  code: "no_go" | "caution" | "preflight_failed" | "bad_receipt" | "no_option";
  preflight: Preflight | null;
  url: string | null;
}

export interface SafeFetchOptions {
  /** Registers your payment schemes, e.g. (c) => c.register("eip155:8453", new ExactEvmScheme(account)). */
  register: (client: x402Client) => unknown;
  /** The network you pay on: "base", "solana" or a CAIP-2 id. Default Base. */
  network?: string;
  /** Budget per endpoint call in USD. Default 0.05. */
  maxUsd?: number | string;
  /** What to do on a caution verdict. Default "stop". */
  onCaution?: "stop" | "pay" | ((preflight: Preflight) => boolean | Promise<boolean>);
  /** Hosts you already trust: paid without a preflight. */
  trusted?: string[];
  onPreflight?: (preflight: Preflight, info: { url: string; method: string; cached: boolean }) => void;
  /** How long a verdict is reused, in ms. Default 10 minutes. */
  cacheMs?: number;
  doctorUrl?: string;
  /** Check Doctor's signed receipt on every preflight (signer, and bound to this request). Default "require". */
  verifyReceipts?: "require" | "off";
  /** Accepted Doctor signer addresses. Default: the published signer (DOCTOR_SIGNERS). */
  doctorSigners?: string[];
  fetch?: typeof globalThis.fetch;
  /** Advanced/testing: a paying fetch capped at `cap` (e.g. "$0.05"). */
  createPayingFetch?: (cap: string) => typeof globalThis.fetch;
  now?: () => number;
}

export declare function createSafeFetch(options: SafeFetchOptions): (input: string | URL, init?: RequestInit) => Promise<Response>;
export declare function usdCap(maxUsd: number | string): string;
export declare function preflightUrl(target: string, options?: { method?: string; maxUsd?: number | string; network?: string; doctorUrl?: string }): string;
export declare function receiptOf(response: Response): { transaction?: string; network?: string; success?: boolean; [key: string]: unknown } | null;

export declare const DOCTOR_SIGNERS: string[];
export declare function canonicalJson(value: unknown): string;
export declare function inputHash(route: string, input: unknown): string;
export declare function recoverSigner(message: string, signature: string): string | null;
export declare function verifyReceipt(body: unknown, options?: { signers?: string[]; route?: string; input?: unknown }): { valid: boolean; signer?: string; reason?: string };
