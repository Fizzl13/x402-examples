// Run: npm test (no network, nothing paid)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, payNetwork, solanaKeyBytes, explorerUrl, tokenUrl, SOLANA, BASE } from "./token-check.mjs";

test("the agent acts on the verdict: go, ask or stop", () => {
  assert.equal(decide({ verdict: "green" }).action, "go");
  assert.equal(decide({ verdict: "orange" }).action, "ask");
  assert.equal(decide({ verdict: "red" }).action, "stop");
  assert.equal(decide({ verdict: null }).action, "stop", "no verdict is never a go");
});

test("payment network: --pay-on wins, then Solana, then Base", () => {
  assert.equal(payNetwork({ SOLANA_PRIVATE_KEY: "x", EVM_PRIVATE_KEY: "y" }), SOLANA);
  assert.equal(payNetwork({ SOLANA_PRIVATE_KEY: "x", EVM_PRIVATE_KEY: "y" }, "base"), BASE);
  assert.equal(payNetwork({ EVM_PRIVATE_KEY: "y" }), BASE);
  assert.equal(payNetwork({}), null);
  assert.throws(() => payNetwork({}, "tron"), /solana or base/);
});

test("Solana keys: base58 (Phantom) and a JSON byte array give the same 64 bytes", async () => {
  const bytes = Array.from({ length: 64 }, (_, i) => i + 1);
  const { getBase58Decoder } = await import("@solana/kit");
  const base58 = getBase58Decoder().decode(new Uint8Array(bytes));
  assert.deepEqual([...await solanaKeyBytes(base58)], bytes);
  assert.deepEqual([...await solanaKeyBytes(JSON.stringify(bytes))], bytes);
  assert.equal((await solanaKeyBytes(`  ${base58}\n`)).length, 64, "stray whitespace from a paste is ignored");
  const address = getBase58Decoder().decode(new Uint8Array(32).fill(7));
  await assert.rejects(solanaKeyBytes(address), /looks like the wallet address/);
});

test("links", () => {
  assert.equal(explorerUrl(SOLANA, "abc"), "https://solscan.io/tx/abc");
  assert.equal(explorerUrl(BASE, "0xabc"), "https://basescan.org/tx/0xabc");
  assert.equal(explorerUrl(BASE, null), null);
  assert.equal(tokenUrl("solana", "Mint1"), "https://presign-guard.onrender.com/v1/token?chain=solana&address=Mint1");
});
