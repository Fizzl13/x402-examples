// A real paid call through x402-safe-fetch (not part of the npm package).
// Run: EVM_PRIVATE_KEY=... node example.mjs [url] [maxUsd]
// Use a dedicated wallet with a few cents of USDC on Base.
import { createSafeFetch, SafePayError, receiptOf } from "./index.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const url = process.argv[2] || "https://ichimoku-signal.onrender.com/signal/BTC-USDT";
const maxUsd = process.argv[3] || "0.05";
const key = String(process.env.EVM_PRIVATE_KEY || "").trim();
if (!key) {
  console.error("Set EVM_PRIVATE_KEY (a dedicated wallet with a few cents of USDC on Base).");
  process.exit(2);
}
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);

const safeFetch = createSafeFetch({
  register: (client) => client.register("eip155:8453", new ExactEvmScheme(account)),
  maxUsd,
  onPreflight: (p, { cached }) => console.log(`Preflight${cached ? " (cached)" : " (paid $0.001)"}: ${p.verdict.toUpperCase()}: ${p.summary}`),
});

try {
  const res = await safeFetch(url);
  const receipt = receiptOf(res);
  console.log(`Endpoint: HTTP ${res.status}${receipt?.transaction ? `, paid: https://basescan.org/tx/${receipt.transaction}` : ""}`);
  console.log((await res.text()).slice(0, 600));
} catch (err) {
  if (!(err instanceof SafePayError)) throw err;
  console.log(`Not paid (${err.code}): ${err.message}`);
}
