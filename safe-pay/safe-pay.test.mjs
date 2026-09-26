// Run: npm test (no network, nothing paid)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, preflightUrl, usdCap, payNetwork, evmKey, seedBytes, explorerUrl, SOLANA, BASE } from "./safe-pay.mjs";

test("the agent acts on the preflight: pay, ask or stop", () => {
  assert.equal(decide({ verdict: "go", summary: "OK to pay: $0.02 on Base." }).action, "pay");
  assert.equal(decide({ verdict: "caution" }).action, "ask");
  assert.equal(decide({ verdict: "caution" }, { acceptCaution: true }).action, "pay");
  assert.equal(decide({ verdict: "no_go", summary: "Do not pay: over budget" }).action, "stop");
  assert.equal(decide(null).action, "stop", "no verdict is never a payment");
  assert.equal(decide({}).action, "stop");
});

test("preflight URL carries the endpoint, method, budget and network", () => {
  const u = new URL(preflightUrl("https://api.example.com/paid?x=1", { method: "POST", maxUsd: "0.05", network: BASE }));
  assert.equal(u.pathname, "/api/v1/preflight");
  assert.equal(u.searchParams.get("url"), "https://api.example.com/paid?x=1");
  assert.equal(u.searchParams.get("method"), "POST");
  assert.equal(u.searchParams.get("max_usd"), "0.05");
  assert.equal(u.searchParams.get("network"), BASE);
});

test("budget becomes a spend cap; nonsense and large budgets are refused", () => {
  assert.equal(usdCap("0.05"), "$0.05");
  assert.equal(usdCap(0.001), "$0.001");
  assert.throws(() => usdCap("0"), /positive/);
  assert.throws(() => usdCap("abc"), /positive/);
  assert.throws(() => usdCap("5"), /above \$1/);
});

test("payment network and keys", () => {
  assert.equal(payNetwork({ EVM_PRIVATE_KEY: "x", SOLANA_SEED: "y" }), BASE);
  assert.equal(payNetwork({ EVM_PRIVATE_KEY: "x" }, "solana"), SOLANA);
  assert.equal(payNetwork({ SOLANA_SEED: "y" }), SOLANA);
  assert.equal(payNetwork({}), null);
  assert.throws(() => payNetwork({}, "tron"), /base or solana/);
  assert.equal(evmKey(` ${"ab".repeat(32)}\n`), `0x${"ab".repeat(32)}`);
  assert.equal(seedBytes("a long random password of at least thirty-two chars").length, 32);
  assert.throws(() => seedBytes("short"), /32 characters/);
  assert.equal(explorerUrl(SOLANA, "t"), "https://solscan.io/tx/t");
  assert.equal(explorerUrl(BASE, null), null);
});
