// The Redis store against a real redis-server (skipped when it isn't installed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { redisStore } from "../src/store.js";
import { createWallet } from "../src/wallet.js";

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;
test("redis store: agents, entries, approvals and events survive a reconnect", { skip: !hasRedis && "redis-server not installed" }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  try {
    await new Promise((ok) => setTimeout(ok, 400));
    const url = `redis://127.0.0.1:${port}`;
    let store = await redisStore(url);
    let wallet = createWallet({ store, signers: [], authority: null });
    const { agent, key } = await wallet.addAgent("bot-1");
    const full = await wallet.agentForKey(key);
    const req = { type: "transaction", chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: "0", data: "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000016e360" };
    const ok = await wallet.reserve(full, { method: "sendTransaction", request: req, purchase: { description: "a test purchase" } });
    assert.equal(ok.status, "ok");
    const pending = await wallet.reserve(full, { method: "sendTransaction", request: { ...req, data: req.data.replace("16e360", "7a1200") } });
    assert.equal(pending.status, "pending");
    await store.close();

    store = await redisStore(url);
    wallet = createWallet({ store, signers: [], authority: null });
    const st = await wallet.state();
    assert.equal(st.agents[0].name, agent.name);
    assert.equal(st.spending[0].used, "1.5");
    assert.equal(st.approvals[0].status, "pending");
    const receipt = await wallet.purchase(ok.purchaseId);
    assert.equal(receipt.what.description, "a test purchase");
    assert.deepEqual(receipt.amounts, ["1.5 USDC"]);
    assert.ok(st.events.length >= 3);
    assert.equal((await wallet.decide(pending.approvalId, "approve")).status, "approved");
    assert.equal((await wallet.spending())[0].used, "9.5");
    await wallet.removeAgent(agent.id);
    assert.equal(await wallet.agentForKey(key), null);
    await store.close();
  } finally { proc.kill(); }
});

test("redis store: accounts are separate scopes; one-time codes and payments work once", { skip: !hasRedis && "redis-server not installed" }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  try {
    await new Promise((ok) => setTimeout(ok, 400));
    const store = await redisStore(`redis://127.0.0.1:${port}`);
    const alice = "0x" + "a".repeat(40), bob = "0x" + "b".repeat(40);
    const wa = createWallet({ store: store.scope(alice), signers: [], authority: null });
    const wb = createWallet({ store: store.scope(bob), signers: [], authority: null });
    const { key } = await wa.addAgent("alice-bot");
    assert.equal((await wb.state()).agents.length, 0);
    assert.equal((await createWallet({ store, signers: [], authority: null }).state()).agents.length, 0);
    const { hashKey } = await import("../src/wallet.js");
    assert.equal(await store.global.getKeyOwner(hashKey(key)), alice);
    await store.global.putOnce("tg", "code123", { account: alice }, 60);
    assert.deepEqual(await store.global.takeOnce("tg", "code123"), { account: alice });
    assert.equal(await store.global.takeOnce("tg", "code123"), null);
    assert.equal(await store.global.claimTx("0xabc"), true);
    assert.equal(await store.global.claimTx("0xabc"), false);
    await store.global.putAccount({ id: alice, paidUntil: 1 });
    assert.equal((await store.global.listAccounts()).length, 1);
    // Wiping alice removes her scope and her agent key, and nothing of bob's or the owner's.
    await wb.addAgent("bob-bot");
    await store.wipe(alice);
    assert.equal((await wa.state()).agents.length, 0);
    assert.equal(await store.global.getKeyOwner(hashKey(key)), null);
    assert.equal((await wb.state()).agents.length, 1);
    await assert.rejects(store.wipe("admin"));
    await store.close();
  } finally { proc.kill(); }
});
