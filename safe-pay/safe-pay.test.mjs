// Run: npm test (no network, nothing paid)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, preflightUrl, usdCap, payNetwork, evmKey, seedBytes, explorerUrl, algorandKey, algorandHdAccounts, algorandSigner, avmSigner, SOLANA, BASE, ALGORAND } from "./safe-pay.mjs";

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
  assert.throws(() => payNetwork({}, "tron"), /base, solana or algorand/);
  assert.equal(payNetwork({ ALGORAND_MNEMONIC: "w" }), ALGORAND);
  assert.equal(payNetwork({ EVM_PRIVATE_KEY: "x" }, "algorand"), ALGORAND);
  assert.equal(evmKey(` ${"ab".repeat(32)}\n`), `0x${"ab".repeat(32)}`);
  assert.equal(seedBytes("a long random password of at least thirty-two chars").length, 32);
  assert.throws(() => seedBytes("short"), /32 characters/);
  assert.equal(explorerUrl(SOLANA, "t"), "https://solscan.io/tx/t");
  assert.equal(explorerUrl(BASE, null), null);
});

test("algorand: the @x402/avm key from a 25-word mnemonic signs as that account", async () => {
  const { mnemonicFromSeed } = await import("@algorandfoundation/algokit-utils/algo25");
  const { toClientAvmSigner } = await import("@x402/avm");
  const seed = new Uint8Array(32).map((_, i) => i + 1);
  const key = await algorandKey(mnemonicFromSeed(seed));
  const bytes = Buffer.from(key, "base64");
  assert.equal(bytes.length, 64);
  assert.deepEqual([...bytes.subarray(0, 32)], [...seed]);
  assert.match(toClientAvmSigner(key).address, /^[A-Z2-7]{58}$/);
  assert.equal(explorerUrl(ALGORAND, "TX1"), "https://allo.info/tx/TX1");
});

test("algorand: the mnemonic may be numbered, comma-separated or capitalised; errors never show a word", async () => {
  const { mnemonicFromSeed } = await import("@algorandfoundation/algokit-utils/algo25");
  const words = mnemonicFromSeed(new Uint8Array(32).map((_, i) => i + 7)).split(" ");
  const plain = await algorandKey(words.join(" "));
  assert.equal(await algorandKey(words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join("\n")), plain);
  assert.equal(await algorandKey(` ${words.join(", ")} `), plain);
  const noWord = (re) => (e) => re.test(e.message) && !words.some((w) => e.message.toLowerCase().includes(` ${w} `));
  await assert.rejects(algorandKey(words.slice(0, 24).join(" ")), noWord(/has 24 words/));
  await assert.rejects(algorandKey(["zzzz", ...words.slice(1)].join(" ")), noWord(/not in the Algorand word list/));
  await assert.rejects(algorandKey([words[1], words[0], ...words.slice(2)].join(" ")), noWord(/don't add up/));
});

const VECTOR = "salon zoo engage submit smile frost later decide wing sight chaos renew lizard rely canal coral scene hobby scare step bus leaf tobacco slice";

test("algorand HD: a 24-word recovery phrase gives ARC-52 accounts in both modes, and their signatures verify", async () => {
  const { createPublicKey, verify } = await import("node:crypto");
  const { peikertXHdWalletGenerator } = await import("@algorandfoundation/algokit-utils/crypto");
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const accounts = await algorandHdAccounts(VECTOR.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n"), [[0, 0], [1, 0]]);
  assert.deepEqual(accounts.map((a) => `${a.mode} ${a.account}/${a.index}`), ["Peikert 0/0", "Peikert 1/0", "Khovratovich 0/0", "Khovratovich 1/0"]);
  // Peikert is what AlgoKit's own HD generator derives.
  const algokit = await (await peikertXHdWalletGenerator(mnemonicToSeedSync(VECTOR))).accountGenerator(1, 0);
  assert.deepEqual([...accounts[1].ed25519Pubkey], [...algokit.ed25519Pubkey]);
  assert.equal(new Set(accounts.map((a) => Buffer.from(a.ed25519Pubkey).toString("hex"))).size, 4);
  const msg = Buffer.from("TX-some transaction bytes");
  for (const a of accounts) {
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(a.ed25519Pubkey)]), format: "der", type: "spki" });
    assert.ok(verify(null, msg, pub, Buffer.from(await a.rawEd25519Signer(msg))), `${a.mode} ${a.account}`);
  }
  assert.match((await avmSigner(accounts[0])).address, /^[A-Z2-7]{58}$/);
  await assert.rejects(algorandHdAccounts([...VECTOR.split(" ").slice(1), "salon"].join(" ")), /not a valid recovery phrase/);
});

test("algorand HD: pays from ALGORAND_ADDRESS or the first account holding USDC, never from an unknown address", async () => {
  const accounts = await algorandHdAccounts(VECTOR);
  const want = (await avmSigner(accounts.find((a) => a.mode === "Khovratovich" && a.account === 1))).address;
  const checked = [];
  const picked = await algorandSigner(VECTOR, { holds: async (addr) => (checked.push(addr), addr === want) });
  assert.equal(picked.address, want);
  assert.ok(checked.length > 1 && checked.at(-1) === want);
  assert.equal((await algorandSigner(VECTOR, { address: want, holds: () => assert.fail("not needed") })).address, want);
  await assert.rejects(algorandSigner(VECTOR, { address: "NOTMINE" }), /not one of the first accounts/);
  await assert.rejects(algorandSigner(VECTOR, { holds: async () => false }), /none of the first accounts of this wallet holds USDC/);
});
