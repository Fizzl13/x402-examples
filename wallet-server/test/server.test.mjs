// Offline: the wallet server over HTTP with an in-memory store, a fake Telegram,
// and presign-guard-wallet (with `server`) as a real agent against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeFunctionData, erc20Abi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet } from "presign-guard-wallet";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { createWallet } from "../src/wallet.js";
import { memoryStore } from "../src/store.js";
import { createTelegram } from "../src/telegram.js";

const PASSWORD = "correct horse battery staple";
const presignKey = privateKeyToAccount(generatePrivateKey());
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const transfer = (usdc) => ({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, BigInt(Math.round(usdc * 1e6))] }) });
const txRequest = (usdc) => ({ type: "transaction", chainId: 8453, value: "0", ...transfer(usdc) });

async function signedVerdict(input, verdict = "green") {
  const route = "POST /v1/check";
  const body = { version: "2", verdict, reasons: [] };
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-10-02T10:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

function fakeTelegramApi() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    calls.push({ method, body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: 7 } : true });
  };
  return { calls, fetchImpl };
}

async function boot({ approvalTtlMs } = {}) {
  const store = memoryStore();
  const tg = fakeTelegramApi();
  const telegram = createTelegram({ token: "1:abc", chatId: "4242", publicUrl: "https://wallet.test", webhookSecret: "s3cret-hook", fetch: tg.fetchImpl });
  const wallet = createWallet({ store, signers: [presignKey.address], authority: null, approvalTtlMs, notify: (a, s) => telegram.notify(a, s), onSettled: (a) => telegram.decided(a) });
  const app = createApp({ wallet, auth: createAuth({ password: PASSWORD, secure: false }), telegram });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const loginRes = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = loginRes.headers.get("set-cookie").split(";")[0];
  const owner = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const agentCall = (key) => async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const { body: { key } } = await owner("POST", "/api/agents", { name: "research-agent" });
  return { base, server, owner, agent: agentCall(key), key, tg, wallet, store };
}

test("login: wrong password refused and slowed down; the dashboard needs the cookie", async () => {
  const { base, server } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"nope"}' })).status, 401);
    const slowed = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(slowed.status, 429);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const demo = await fetch(`${base}/demo`);
    assert.equal(demo.status, 200);
    assert.match(await demo.text(), /LIVE DEMO/);
    assert.throws(() => createAuth({ password: "short" }), /12 characters/);
  } finally { server.close(); }
});

test("agents need their key; a key works only as a hash and stops working when removed", async () => {
  const { owner, agent, base, server, store } = await boot();
  try {
    assert.equal((await fetch(`${base}/v1/spending`)).status, 401);
    assert.equal((await agent("GET", "/v1/spending")).status, 200);
    const stored = JSON.stringify(await store.listAgents());
    assert.doesNotMatch(stored, /awk_/);
    const { body: st } = await owner("GET", "/api/state");
    await owner("DELETE", `/api/agents/${st.agents[0].id}`);
    assert.equal((await agent("GET", "/v1/spending")).status, 401);
  } finally { server.close(); }
});

test("within the rules: booked at once; spending and the dashboard show it", async () => {
  const { owner, agent, server } = await boot();
  try {
    const req = txRequest(4);
    const r = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: req, verdict: await signedVerdict(req) });
    assert.equal(r.body.status, "ok");
    assert.equal(r.body.entries.length, 1);
    const { body: s } = await agent("GET", "/v1/spending");
    assert.deepEqual(s.spending, [{ token: "USDC", perTx: "5", perDay: "20", used: "4", left: "16" }]);
    const { body: st } = await owner("GET", "/api/state");
    assert.equal(st.agents[0].spent.USDC, "4");
    assert.equal(st.events[0].type, "signed");
    assert.equal(st.events[0].verdict, "green");
  } finally { server.close(); }
});

test("over the limit: Telegram is asked, the dashboard approves, the waiting agent gets the go", async () => {
  const { owner, agent, server, tg } = await boot();
  try {
    const req = txRequest(8);
    const r = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: req, verdict: await signedVerdict(req) });
    assert.equal(r.body.status, "pending");
    assert.match(r.body.summary, /8 USDC is over the limit of 5 per transaction/);
    await new Promise((ok) => setTimeout(ok, 20));
    const msg = tg.calls.find((c) => c.method === "sendMessage");
    assert.match(msg.body.text, /research-agent wants to sign something over your limit/);
    const waiting = agent("GET", `/v1/approvals/${r.body.approvalId}?wait=5`);
    await new Promise((ok) => setTimeout(ok, 30));
    const d = await owner("POST", `/api/approvals/${r.body.approvalId}`, { decision: "approve" });
    assert.equal(d.body.status, "approved");
    const w = await waiting;
    assert.equal(w.body.status, "approved");
    assert.equal(w.body.entries.length, 1);
    assert.equal((await agent("GET", "/v1/spending")).body.spending[0].used, "8");
    await new Promise((ok) => setTimeout(ok, 20));
    assert.match(tg.calls.find((c) => c.method === "editMessageText").body.text, /Approved \(dashboard\)/);
  } finally { server.close(); }
});

test("deny, and no answer in time, both mean not signed", async () => {
  const { owner, agent, server } = await boot({ approvalTtlMs: 80 });
  try {
    const r1 = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(9) });
    await owner("POST", `/api/approvals/${r1.body.approvalId}`, { decision: "deny" });
    assert.equal((await agent("GET", `/v1/approvals/${r1.body.approvalId}`)).body.status, "denied");
    const r2 = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(9) });
    assert.equal((await agent("GET", `/v1/approvals/${r2.body.approvalId}?wait=2`)).body.status, "expired");
    assert.equal((await owner("POST", `/api/approvals/${r2.body.approvalId}`, { decision: "approve" })).body.status, "expired");
    assert.equal((await agent("GET", "/v1/spending")).body.spending[0].used, "0");
  } finally { server.close(); }
});

test("Telegram webhook: only with the secret header, only the owner can tap", async () => {
  const { agent, base, server, tg } = await boot();
  try {
    const r = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(8) });
    const tap = (fromId, secret) => fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify({ callback_query: { id: "cb1", data: `aw:${r.body.approvalId}:y`, from: { id: fromId, username: "x" } } }) });
    assert.equal((await tap(4242, "wrong")).status, 401);
    assert.equal((await tap(999, "s3cret-hook")).status, 200);
    assert.equal((await agent("GET", `/v1/approvals/${r.body.approvalId}`)).body.status, "pending");
    assert.ok(tg.calls.some((c) => c.method === "answerCallbackQuery" && /not allowed/.test(c.body.text)));
    assert.equal((await tap(4242, "s3cret-hook")).status, 200);
    assert.equal((await agent("GET", `/v1/approvals/${r.body.approvalId}`)).body.status, "approved");
  } finally { server.close(); }
});

test("pause all, pause one agent; rules are validated; a forged verdict is not trusted", async () => {
  const { owner, agent, server } = await boot();
  try {
    await owner("POST", "/api/pause", { paused: true });
    assert.equal((await agent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(1) })).body.status, "paused");
    await owner("POST", "/api/pause", { paused: false });
    const bad = await owner("PUT", "/api/policy", { policy: { tokens: { DOGE: { perTx: 1 } } } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /not a known token/);
    assert.equal((await owner("PUT", "/api/policy", { policy: { tokens: { USDC: { perTx: "50", perDay: "100" } } } })).status, 200);
    // A signature whose verdict is forged: its spending can't be read, so it asks.
    const sig = { type: "signature", chainId: 8453, typedData: { domain: { verifyingContract: USDC }, types: {}, primaryType: "TransferWithAuthorization", message: {} } };
    const forged = { verdict: "green", reasons: [], subject: { kind: "transfer_authorization", grants: [] }, receipt: { signature: "0xdead" } };
    assert.equal((await agent("POST", "/v1/reserve", { method: "signTypedData", request: sig, verdict: forged })).body.status, "pending");
    const { body: st } = await owner("GET", "/api/state");
    await owner("POST", `/api/agents/${st.agents[0].id}/pause`, { paused: true });
    assert.equal((await agent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(1) })).body.status, "paused");
  } finally { server.close(); }
});

test("release gives spending back, but only an agent's own", async () => {
  const { owner, agent, server } = await boot();
  try {
    const r = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(3) });
    const { body: { key: otherKey } } = await owner("POST", "/api/agents", { name: "other" });
    const otherRelease = await fetch(new URL("/v1/release", `http://127.0.0.1:${server.address().port}`), { method: "POST", headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" }, body: JSON.stringify({ entries: r.body.entries }) });
    assert.equal((await otherRelease.json()).released, 0);
    assert.equal((await agent("POST", "/v1/release", { entries: r.body.entries })).body.released, 1);
    assert.equal((await agent("GET", "/v1/spending")).body.spending[0].used, "0");
  } finally { server.close(); }
});

test("end to end: presign-guard-wallet with `server` signs, asks, waits, stops", async () => {
  const { owner, key, base, server } = await boot();
  try {
    const signed = [];
    const stub = { chain: { id: 8453 }, account: { address: "0x2222222222222222222222222222222222222222" }, sendTransaction: async (a) => { signed.push(a); return "0xtx"; } };
    const pay = async (_u, init) => Response.json(await signedVerdict(JSON.parse(init.body)));
    const wallet = guardWallet(stub, { pay, signers: [presignKey.address], server: { url: base, key } });

    assert.equal(await wallet.sendTransaction(transfer(4)), "0xtx");
    assert.equal((await wallet.spending())[0].used, "4");

    // Over the limit: the owner approves on the dashboard while the agent waits.
    const sending = wallet.sendTransaction(transfer(8));
    let pending;
    for (let i = 0; i < 100 && !pending; i++) { await new Promise((ok) => setTimeout(ok, 20)); pending = (await owner("GET", "/api/state")).body.approvals.find((a) => a.status === "pending"); }
    await owner("POST", `/api/approvals/${pending.id}`, { decision: "approve" });
    assert.equal(await sending, "0xtx");
    assert.equal((await wallet.spending())[0].used, "12");

    // Denied: not signed.
    const denied = wallet.sendTransaction(transfer(7)).then(() => null, (e) => e);
    pending = null;
    for (let i = 0; i < 100 && !pending; i++) { await new Promise((ok) => setTimeout(ok, 20)); pending = (await owner("GET", "/api/state")).body.approvals.find((a) => a.status === "pending"); }
    await owner("POST", `/api/approvals/${pending.id}`, { decision: "deny" });
    const err = await denied;
    assert.equal(err?.code, "over_limit");
    assert.match(err.message, /denied by the owner/);

    // Paused on the server: the wallet says paused.
    await owner("POST", "/api/pause", { paused: true });
    await assert.rejects(wallet.sendTransaction(transfer(1)), { code: "paused" });
    assert.equal(signed.length, 2);

    // Server gone: the wallet stops instead of signing.
    await owner("POST", "/api/pause", { paused: false });
    server.close();
    await assert.rejects(wallet.sendTransaction(transfer(1)), { code: "limit_unavailable" });
    assert.equal(signed.length, 2);
    assert.throws(() => guardWallet(stub, { pay, server: { url: base, key }, limits: {} }), /leave out limits/);
  } finally { server.close(); }
});
