// Payout addresses for the bench's sellers: derived from a fixed label, so they are the same in every run and belong
// to nobody real.

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const cache = new Map();

export function benchAddress(label) {
  if (!cache.has(label)) cache.set(label, privateKeyToAccount(keccak256(toHex(`x402-agent-safety-bench:${label}`))).address);
  return cache.get(label);
}
