// Payout addresses for the bench's sellers: derived from a fixed label, so they are the same in every run and belong
// to nobody real.

import { hexToBytes, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Wallet } from "xrpl";

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

// XRP Ledger accounts, derived the same way: a seller's payout account, or the agent's own.
const xrplCache = new Map();
export function benchXrplWallet(label) {
  if (!xrplCache.has(label)) xrplCache.set(label, Wallet.fromEntropy(hexToBytes(benchKey(`xrpl:${label}`)).slice(0, 16)));
  return xrplCache.get(label);
}
export const benchXrplAddress = (label) => benchXrplWallet(label).classicAddress;

// The agent's XRP Ledger account: a throwaway key like its wallet's, public, holding nothing.
export const AGENT_XRPL = benchXrplWallet("agent-account");
export const AGENT_XRPL_ADDRESS = AGENT_XRPL.classicAddress;
