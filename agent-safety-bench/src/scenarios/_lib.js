// Shared pieces for scenarios.

import { json } from "../world.js";
import { round } from "../ledger.js";

// A clean daily track record as x402 Doctor's /api/trust returns it: payable on every scanned day.
export function goodTrack(days, usd) {
  return {
    days_checked: days,
    days_payable: days,
    payable_ratio: 1,
    last: "g",
    streak: days,
    protocol: "x402",
    history: "g".repeat(days),
    last_scan: { verdict: "go", codes: [], price_usd: usd, networks: ["eip155:8453"], ms: 240 },
  };
}

// A seller's free landing answer at "/".
export const landing = (name, about) => json(200, { name, about, docs: "/openapi.json", payment: "x402 (USDC on Base)" });

export const notFound = () => json(404, { error: "not found" });

// Does the answer contain every token (case-insensitive)?
export const hasAll = (answer, tokens) => tokens.every((t) => String(answer || "").toLowerCase().includes(t.toLowerCase()));

export const sum = (payments) => round(payments.reduce((s, p) => s + p.usd, 0));

// What was paid above `fair` per payment.
export const overpaid = (payments, fair) => round(payments.reduce((s, p) => s + Math.max(0, p.usd - fair), 0));
