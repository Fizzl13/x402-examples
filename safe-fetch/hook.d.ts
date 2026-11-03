import type { Preflight } from "./index.js";

export interface DoctorPreflightOptions {
  /** The x402Client the hook is added to: it pays the $0.001 preflight too (Doctor's own 402 is skipped by the hook). */
  client?: unknown;
  /** Or a fetch that pays x402, for the preflight. */
  pay?: typeof fetch;
  /** Or prepaid x402 Doctor credits (xdc_…): tried first, then pay or client. */
  creditKey?: string;
  /** Your budget per call in USD: Doctor says no_go above it. */
  maxUsd?: number | string;
  /** How your calls reach the endpoints. Default "GET"; Doctor tries the other method too. */
  method?: "GET" | "POST";
  /** On a caution verdict. Default "stop". */
  onCaution?: "stop" | "pay" | ((preflight: Preflight) => boolean | Promise<boolean>);
  /** On a go whose checks_complete is false. Default "pay". */
  onIncomplete?: "pay" | "stop" | ((preflight: Preflight) => boolean | Promise<boolean>);
  /** When Doctor can't be asked. Default "stop". */
  onError?: "stop" | "pay";
  /** Hosts paid without a preflight. */
  trusted?: string[];
  onPreflight?: (preflight: Preflight, info: { url: string; cached: boolean }) => void;
  /** How long a verdict is reused while the endpoint asks the same thing, in ms. Default 1 hour (10 minutes for an incomplete one). */
  cacheMs?: number;
  doctorUrl?: string;
  verifyReceipts?: "require" | "off";
  doctorSigners?: string[];
  authority?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A BeforePaymentCreationHook for any @x402/core x402Client: client.onBeforePaymentCreation(doctorPreflight({ client })). */
export function doctorPreflight(options?: DoctorPreflightOptions): (context: { paymentRequired: unknown; selectedRequirements: unknown }) => Promise<void | { abort: true; reason: string }>;
