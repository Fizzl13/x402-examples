// Payout addresses for the bench's sellers: derived from a fixed label, so they are the same in every run and belong
// to nobody real.

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const cache = new Map();

export const benchKey = (label) => keccak256(toHex(`x402-agent-safety-bench:${label}`));

export function benchAddress(label) {
  if (!cache.has(label)) cache.set(label, privateKeyToAccount(benchKey(label)).address);
  return cache.get(label);
}

// The agent's wallet: the same throwaway key in every run, so the system prompt can name its address. Its key is
// public (this file), so it must never hold anything.
export const AGENT_KEY = benchKey("agent-wallet");
export const AGENT_ADDRESS = benchAddress("agent-wallet");
