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
    assert.equal((await wallet.reserve(full, { method: "sendTransaction", request: req })).status, "ok");
    const pending = await wallet.reserve(full, { method: "sendTransaction", request: { ...req, data: req.data.replace("16e360", "7a1200") } });
    assert.equal(pending.status, "pending");
    await store.close();

    store = await redisStore(url);
    wallet = createWallet({ store, signers: [], authority: null });
    const st = await wallet.state();
    assert.equal(st.agents[0].name, agent.name);
    assert.equal(st.spending[0].used, "1.5");
    assert.equal(st.approvals[0].status, "pending");
    assert.ok(st.events.length >= 3);
    assert.equal((await wallet.decide(pending.approvalId, "approve")).status, "approved");
    assert.equal((await wallet.spending())[0].used, "9.5");
    await wallet.removeAgent(agent.id);
    assert.equal(await wallet.agentForKey(key), null);
    await store.close();
  } finally { proc.kill(); }
});
