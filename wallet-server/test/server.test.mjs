// Offline: the wallet server over HTTP with an in-memory store, a fake Telegram,
// and presign-guard-wallet (with `server`) as a real agent against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet } from "presign-guard-wallet";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { createAccounts } from "../src/accounts.js";
import { memoryStore } from "../src/store.js";
import { createTelegram } from "../src/telegram.js";

const PASSWORD = "correct horse battery staple";
const PAY_TO = "0x6B0F4651eD42893ab58139938175E4a69f175F25";
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

async function boot({ approvalTtlMs, rpc = async () => null, now, operator, solana = null, catalog = null } = {}) {
  const store = memoryStore();
  const tg = fakeTelegramApi();
  const telegram = createTelegram({ token: "1:abc", publicUrl: "https://wallet.test", webhookSecret: "s3cret-hook", username: "FizzlTestBot", fetch: tg.fetchImpl });
  const rpcFetch = async (_url, init) => { const { method, params } = JSON.parse(init.body); return Response.json({ jsonrpc: "2.0", id: 1, result: await rpc(method, params) }); };
  const accounts = createAccounts({
    store, telegram, adminChatId: "4242", publicUrl: "https://wallet.test", ...(now ? { now } : {}),
    billing: { payTo: PAY_TO, priceUsdc: 5, rpcUrl: "https://rpc.test", fetch: rpcFetch, ...(solana ? { solana } : {}) },
    walletOptions: { signers: [presignKey.address], authority: null, approvalTtlMs },
  });
  const app = createApp({ accounts, auth: createAuth({ password: PASSWORD, secure: false }), telegram, operator, catalog });
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
  return { base, server, owner, agent: agentCall(key), agentCall, key, tg, accounts, store };
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

test("receipts: what was bought, verdict, approval, result and outcome, per payment", async () => {
  const { owner, key, base, server, tg, agent } = await boot();
  try {
    let fail = false;
    const stub = { chain: { id: 8453 }, account: { address: "0x2222222222222222222222222222222222222222" }, sendTransaction: async () => { if (fail) throw new Error("rpc down"); return "0xabc123"; } };
    const pay = async (_u, init) => Response.json(await signedVerdict(JSON.parse(init.body)));
    const wallet = guardWallet(stub, { pay, signers: [presignKey.address], server: { url: base, key } });
    const receiptFor = async (type) => {
      const ev = (await owner("GET", "/api/state")).body.events.find((e) => e.type === type && e.purchase);
      return (await owner("GET", `/api/purchases/${ev.purchase}`)).body.purchase;
    };

    // Within the rules, with what it is for and what happened afterwards.
    await wallet.withPurchase({ url: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", description: "BTC signal" }, async (report) => {
      await wallet.sendTransaction(transfer(2));
      report({ httpStatus: 200, settlement: { transaction: "0xsettled", network: "eip155:8453" }, content: { contentType: "application/json", body: '{"pair":"BTC-USDT","signal":"bullish"}' } });
    });
    await new Promise((ok) => setTimeout(ok, 50)); // spent is reported in the background
    const r = await receiptFor("signed");
    assert.deepEqual(r.what, { url: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", description: "BTC signal" });
    assert.deepEqual(r.amounts, ["2 USDC"]);
    assert.equal(r.to, SHOP.toLowerCase());
    assert.equal(r.chainId, 8453);
    assert.equal(r.verdict.verdict, "green");
    assert.equal(r.verdict.receiptId, "p1");
    assert.equal(r.verdict.signer, presignKey.address);
    assert.equal(r.status, "signed");
    assert.equal(r.result, "0xabc123");
    assert.deepEqual(r.outcome, { httpStatus: 200, settlement: { transaction: "0xsettled", network: "eip155:8453" }, content: { contentType: "application/json", body: '{"pair":"BTC-USDT","signal":"bullish"}' } });
    assert.equal(r.approval, null);

    // Over the limit: Telegram says what it is for; the receipt shows who approved.
    const sending = wallet.withPurchase({ description: "full market report" }, () => wallet.sendTransaction(transfer(8)));
    let pending;
    for (let i = 0; i < 100 && !pending; i++) { await new Promise((ok) => setTimeout(ok, 20)); pending = (await owner("GET", "/api/state")).body.approvals.find((a) => a.status === "pending"); }
    assert.match(tg.calls.find((c) => c.method === "sendMessage").body.text, /for: full market report/);
    await owner("POST", `/api/approvals/${pending.id}`, { decision: "approve" });
    await sending;
    await new Promise((ok) => setTimeout(ok, 50));
    const a = await receiptFor("approved");
    assert.equal(a.what.description, "full market report");
    assert.equal(a.approval.by, "dashboard");
    assert.match(a.approval.summary, /8 USDC/);
    assert.equal(a.status, "signed");

    // Signing failed: the receipt says so and the spending is given back.
    fail = true;
    await assert.rejects(wallet.withPurchase({ description: "doomed" }, () => wallet.sendTransaction(transfer(1))), /rpc down/);
    const f = await receiptFor("released");
    assert.equal(f.status, "failed");
    assert.match(f.outcome.error, /rpc down/);

    // Another agent can't touch these receipts; unknown ids are a 404; owners only.
    const other = (await owner("POST", "/api/agents", { name: "other" })).body.key;
    const r2 = await fetch(`${base}/v1/purchases/annotate`, { method: "POST", headers: { authorization: `Bearer ${other}`, "content-type": "application/json" }, body: JSON.stringify({ ids: [r.id], outcome: { error: "forged" } }) });
    assert.deepEqual(await r2.json(), { updated: 0 });
    // A long answer is kept to 16,000 characters; anything that isn't a text body is dropped.
    const long = await fetch(`${base}/v1/purchases/annotate`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ids: [f.id], outcome: { content: { contentType: "text/plain", body: "x".repeat(20_000) } } }) });
    assert.deepEqual(await long.json(), { updated: 1 });
    const fl = (await owner("GET", `/api/purchases/${f.id}`)).body.purchase;
    assert.equal(fl.outcome.content.body.length, 16_000 + "\n… (cut)".length);
    assert.match(fl.outcome.error, /rpc down/);
    await fetch(`${base}/v1/purchases/annotate`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ids: [r.id], outcome: { content: { body: { html: "<b>" } } } }) });
    assert.equal((await owner("GET", `/api/purchases/${r.id}`)).body.purchase.outcome.content.body, '{"pair":"BTC-USDT","signal":"bullish"}');
    assert.equal((await owner("GET", "/api/purchases/pu_nope")).status, 404);
    assert.equal((await agent("GET", `/api/purchases/${r.id}`)).status, 401);

    // The Purchases screen: newest first, what each was for, filtered per agent, owners only.
    const list = (await owner("GET", "/api/purchases")).body.purchases;
    assert.deepEqual(list.map((p) => p.what?.description), ["doomed", "full market report", "BTC signal"]);
    assert.deepEqual(list.map((p) => p.status), ["failed", "signed", "signed"]);
    assert.equal(list[1].approvedBy, "dashboard");
    assert.equal(list[2].verdict, "green");
    assert.equal(list[0].error.includes("rpc down"), true);
    assert.equal("result" in list[0] || "entries" in list[0], false);
    assert.equal((await owner("GET", `/api/purchases?agent=${list[0].agent}`)).body.purchases.length, 3);
    assert.equal((await owner("GET", "/api/purchases?agent=ag_nobody")).body.purchases.length, 0);
    assert.equal((await owner("GET", "/api/purchases?limit=1")).body.purchases.length, 1);
    assert.equal((await agent("GET", "/api/purchases")).status, 401);
  } finally { server.close(); }
});

// ---------- hosted accounts: wallet sign-in, isolation, Telegram links, Pro ----------

async function signInAs(base, account) {
  const m = await (await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account.address }) })).json();
  const r = await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: m.nonce, signature: await account.signMessage({ message: m.message }) }) });
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { status: r.status, message: m.message, nonce: m.nonce, call };
}
const customer = () => privateKeyToAccount(generatePrivateKey());
const pad = (a) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// A fake Base RPC: transactions by hash.
function chain(nowSec = () => Math.floor(Date.now() / 1000)) {
  const txs = new Map();
  const rpc = async (method, params) => {
    if (method === "eth_getTransactionReceipt") return txs.get(params[0]) ?? null;
    if (method === "eth_getBlockByNumber") return { timestamp: `0x${(txs.get(`block:${params[0]}`) ?? nowSec()).toString(16)}` };
    return null;
  };
  const pay = (from, usdc, { to = PAY_TO, status = "0x1", ageDays = 0, token = USDC } = {}) => {
    const hash = `0x${randomBytes(32).toString("hex")}`, block = `0x${randomBytes(3).toString("hex")}`;
    txs.set(hash, { status, blockNumber: block, logs: [{ address: token, topics: [TRANSFER, pad(from), pad(to)], data: `0x${BigInt(Math.round(usdc * 1e6)).toString(16).padStart(64, "0")}` }] });
    txs.set(`block:${block}`, nowSec() - ageDays * 86400);
    return hash;
  };
  return { rpc, pay };
}

test("sign in with a wallet: a free signature over a message this server made, once", async () => {
  const { base, server } = await boot();
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    assert.equal(a.status, 200);
    // The domain is the one the browser is on (here 127.0.0.1:<port>), not PUBLIC_URL, so wallets don't warn.
    const host = new URL(base).host;
    assert.ok(a.message.startsWith(`${host} wants you to sign in with your Ethereum account:\n0x`), a.message);
    assert.ok(a.message.includes(`URI: ${base}\n`));
    assert.match(a.message, /Chain ID: 8453/);
    assert.match(a.message, /not a transaction/);
    const me = (await a.call("GET", "/api/me")).body;
    assert.equal(me.address, alice.address);
    assert.equal(me.plan, "free");
    assert.equal(me.limits.maxAgents, 1);
    assert.equal(me.billing.payTo, PAY_TO);
    assert.equal(me.billing.priceUsdc, 5);

    // Someone else's signature, a reused nonce, a made-up nonce: all refused.
    const m = await (await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: alice.address }) })).json();
    const bad = await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: m.nonce, signature: await customer().signMessage({ message: m.message }) }) });
    assert.equal(bad.status, 401);
    const replay = await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: a.nonce, signature: await alice.signMessage({ message: a.message }) }) });
    assert.equal(replay.status, 401);
    assert.equal((await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "nope" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/config`).then((r) => r.json())).wallet, true);
    // Behind a proxy with another name (wallet.fizzl.eu in front of onrender.com), that name is used.
    const viaProxy = await (await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": "wallet.fizzl.eu", "x-forwarded-proto": "https" }, body: JSON.stringify({ address: alice.address }) })).json();
    assert.ok(viaProxy.message.startsWith("wallet.fizzl.eu wants you to sign in"), viaProxy.message);
    assert.ok(viaProxy.message.includes("URI: https://wallet.fizzl.eu\n"));
  } finally { server.close(); }
});

test("every account sees and changes only its own agents, approvals, receipts and rules", async () => {
  const { base, server, owner, agentCall } = await boot();
  try {
    const a = await signInAs(base, customer()), b = await signInAs(base, customer());
    const { body: { key: aKey } } = await a.call("POST", "/api/agents", { name: "alice-bot" });
    const aAgent = agentCall(aKey);
    const r = await aAgent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(9) });
    assert.equal(r.body.status, "pending");

    assert.deepEqual((await b.call("GET", "/api/state")).body.agents, []);
    assert.deepEqual((await b.call("GET", "/api/state")).body.approvals, []);
    assert.equal((await b.call("POST", `/api/approvals/${r.body.approvalId}`, { decision: "approve" })).status, 404);
    assert.ok(!(await owner("GET", "/api/state")).body.agents.some((x) => x.name === "alice-bot"));
    assert.equal((await owner("POST", `/api/approvals/${r.body.approvalId}`, { decision: "approve" })).status, 404);
    assert.equal((await a.call("GET", "/api/state")).body.approvals[0].status, "pending");

    // b's rules don't change a's, and only the owner gets the payments export.
    await b.call("PUT", "/api/policy", { policy: { tokens: { USDC: { perTx: "100", perDay: "200" } } } });
    assert.equal((await aAgent("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(9) })).body.status, "pending");
    assert.equal((await a.call("GET", "/api/admin/payments.csv")).status, 403);
    assert.equal((await fetch(`${base}/api/admin/payments.csv`, { headers: { cookie: "aw_session=forged.admin.x.y" } })).status, 401);
  } finally { server.close(); }
});

test("free plan: one agent; a second is refused, and paused if it already exists", async () => {
  const c = chain();
  const { base, server, agentCall } = await boot({ rpc: c.rpc });
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    assert.equal((await a.call("POST", "/api/agents", { name: "one" })).status, 200);
    const second = await a.call("POST", "/api/agents", { name: "two" });
    assert.equal(second.status, 403);
    assert.match(second.body.message, /free plan has 1 agent/);
    // Pro: more agents.
    await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 5) });
    const { body: { key: twoKey } } = await a.call("POST", "/api/agents", { name: "two" });
    assert.equal((await agentCall(twoKey)("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(1) })).body.status, "ok");
  } finally { server.close(); }
});

test("Pro: also paid in USDC on Ethereum, Arbitrum, Optimism or Polygon, each checked against that network's USDC", async () => {
  const c = chain();
  const { base, server, accounts } = await boot({ rpc: c.rpc });
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    const claim = (txHash, chainId) => a.call("POST", "/api/billing/claim", { txHash, chainId });
    const { PAY_CHAINS } = await import("../src/accounts.js");
    const me = (await a.call("GET", "/api/me")).body;
    assert.deepEqual(me.billing.chains.map((x) => x.name), ["Base", "Arbitrum", "Optimism", "Polygon", "Ethereum"]);

    // USDC on Arbitrum, claimed as Arbitrum: Pro. The same hash claimed as Base (wrong token) is refused.
    const arb = c.pay(alice.address, 5, { token: PAY_CHAINS[42161].usdc });
    assert.match((await claim(arb, 8453)).body.message, /no payment of 5 USDC on Base/);
    const paid = (await claim(arb, 42161)).body;
    assert.equal(paid.plan, "pro");
    assert.equal(paid.payments[0].chainId, 42161);
    assert.equal((await claim(arb, 42161)).body.payments.length, 1); // once
    // Polygon's USDC claimed as Optimism is refused; a network we don't take is refused.
    assert.equal((await claim(c.pay(alice.address, 5, { token: PAY_CHAINS[137].usdc }), 10)).status, 400);
    assert.match((await claim(c.pay(alice.address, 5), 56)).body.message, /can be paid on/);
    // Ethereum: 12 months.
    const eth = (await claim(c.pay(alice.address, 60, { token: PAY_CHAINS[1].usdc }), 1)).body;
    assert.equal(eth.payments[0].months, 12);
    assert.equal(eth.payments[0].chainId, 1);
    const rows = await accounts.allPayments();
    assert.deepEqual(rows.map((r) => r.chainId), [42161, 1]);
  } finally { server.close(); }
});

test("Pro: paid in USDC on Base from the customer's own wallet to the owner, checked on-chain", async () => {
  const c = chain();
  const { base, server, owner } = await boot({ rpc: c.rpc });
  try {
    const alice = customer(), bob = customer();
    const a = await signInAs(base, alice), b = await signInAs(base, bob);
    const claim = (who, txHash) => who.call("POST", "/api/billing/claim", { txHash });

    assert.equal((await claim(a, `0x${"ab".repeat(32)}`)).status, 409); // not mined yet
    assert.match((await claim(a, c.pay(alice.address, 4))).body.message, /no payment of 5 USDC/);
    assert.equal((await claim(a, c.pay(alice.address, 5, { to: bob.address }))).status, 400);
    assert.equal((await claim(a, c.pay(alice.address, 5, { token: "0x0000000000000000000000000000000000000001" }))).status, 400);
    assert.match((await claim(a, c.pay(alice.address, 5, { status: "0x0" }))).body.message, /failed/);
    assert.match((await claim(a, c.pay(alice.address, 5, { ageDays: 9 }))).body.message, /older than 7 days/);

    const tx = c.pay(alice.address, 5);
    assert.equal((await claim(b, tx)).status, 400); // bob can't use alice's payment
    const ok = await claim(a, tx);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.plan, "pro");
    const until = ok.body.paidUntil;
    assert.ok(Math.abs(until - (Date.now() + 30 * 86_400_000)) < 60_000);
    assert.equal((await claim(a, tx)).body.paidUntil, until); // the same payment twice: counted once

    // 10 USDC is two months, added on top.
    const two = await claim(a, c.pay(alice.address, 10));
    assert.ok(Math.abs(two.body.paidUntil - (until + 60 * 86_400_000)) < 60_000);
    assert.equal(two.body.payments.length, 2);
    assert.equal(two.body.limits.receiptDays, 90);

    const csv = await (await fetch(`${base}/api/admin/payments.csv`, { headers: { cookie: (await (await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).headers.get("set-cookie")).split(";")[0] } })).text();
    assert.match(csv, /^date,account,network,amount_usdc,months,transaction,paid_until,automatic\n/);
    assert.match(csv, /,Base,5,1,/);
    assert.equal(csv.trim().split("\n").length, 3);
    assert.ok(csv.includes(alice.address));
    assert.equal((await owner("GET", "/api/me")).body.plan, "owner");
  } finally { server.close(); }
});

test("Telegram: one bot, a one-time link per account; approvals go to that chat and only its user can tap", async () => {
  const { base, server, tg, agentCall } = await boot();
  try {
    const a = await signInAs(base, customer());
    const { body: link } = await a.call("POST", "/api/telegram/link", {});
    const code = /^https:\/\/t\.me\/FizzlTestBot\?start=([A-Za-z0-9]+)$/.exec(link.url)?.[1];
    assert.ok(code, link.url);
    const hook = (update, secret = "s3cret-hook") => fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) });
    const start = (text, chatId = 555, type = "private") => hook({ message: { text, chat: { id: chatId, type }, from: { id: chatId, username: "alice" } } });

    assert.equal((await hook({ message: { text: `/start ${code}`, chat: { id: 555, type: "private" }, from: { id: 555 } } }, "wrong")).status, 401);
    await start("/start nonsensecode123");
    assert.match(tg.calls.at(-1).body.text, /expired/);
    await start(`/start ${code}`, 777, "group");
    assert.match(tg.calls.at(-1).body.text, /private chat/);
    const again = (await a.call("POST", "/api/telegram/link", {})).body.url.split("start=")[1];
    await start(`/start ${again}`);
    assert.match(tg.calls.at(-1).body.text, /^Connected ✓/);
    assert.equal(tg.calls.at(-1).body.chat_id, 555);
    assert.equal((await a.call("GET", "/api/me")).body.telegram.linked, true);
    await start(`/start ${again}`); // a link works once
    assert.match(tg.calls.at(-1).body.text, /expired/);

    const { body: { key } } = await a.call("POST", "/api/agents", { name: "alice-bot" });
    const r = await agentCall(key)("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(9) });
    await new Promise((ok) => setTimeout(ok, 30));
    const asked = tg.calls.filter((c) => c.method === "sendMessage").at(-1);
    assert.equal(asked.body.chat_id, "555");
    assert.match(asked.body.text, /alice-bot wants to sign/);

    const tap = (fromId) => hook({ callback_query: { id: "cb", data: `aw:${r.body.approvalId}:y`, from: { id: fromId, username: "x" } } });
    await tap(4242); // the server owner is not this account's user
    assert.equal((await a.call("GET", "/api/state")).body.approvals[0].status, "pending");
    await tap(555);
    assert.equal((await a.call("GET", "/api/state")).body.approvals[0].status, "approved");

    await a.call("POST", "/api/telegram/unlink", {});
    assert.equal((await a.call("GET", "/api/me")).body.telegram.linked, false);
  } finally { server.close(); }
});

test("reminders: before Pro ends, when it ends, and back on free; each once", async () => {
  let t = Date.now();
  const c = chain(() => Math.floor(t / 1000));
  const { base, server, tg, accounts } = await boot({ rpc: c.rpc, now: () => t });
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    const code = (await a.call("POST", "/api/telegram/link", {})).body.url.split("start=")[1];
    await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret-hook" }, body: JSON.stringify({ message: { text: `/start ${code}`, chat: { id: 555, type: "private" }, from: { id: 555 } } }) });
    await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 5) });
    const texts = () => tg.calls.filter((x) => x.method === "sendMessage" && x.body.chat_id === "555").map((x) => x.body.text);

    assert.equal(await accounts.remind(), 0);
    t += 28 * 86_400_000;
    assert.equal(await accounts.remind(), 1);
    assert.match(texts().at(-1), /Pro ends on/);
    assert.equal(await accounts.remind(), 0);
    t += 3 * 86_400_000;
    assert.equal(await accounts.remind(), 1);
    assert.match(texts().at(-1), /has ended/);
    assert.equal((await a.call("GET", "/api/me")).body.plan, "pro"); // grace
    t += 3 * 86_400_000;
    assert.equal(await accounts.remind(), 1);
    assert.match(texts().at(-1), /free plan/);
    assert.equal((await a.call("GET", "/api/me")).body.plan, "free");
  } finally { server.close(); }
});

test("delete my account: everything goes except payment records; the agent key stops working", async () => {
  const c = chain();
  const { base, server, agentCall, accounts } = await boot({ rpc: c.rpc });
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 5) });
    const { body: { key } } = await a.call("POST", "/api/agents", { name: "alice-bot" });
    await agentCall(key)("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(1) });
    assert.equal((await a.call("POST", "/api/account/delete", {})).status, 400); // needs the confirmation
    const del = await a.call("POST", "/api/account/delete", { confirm: "delete" });
    assert.equal(del.status, 200);
    assert.equal((await agentCall(key)("GET", "/v1/spending")).status, 401);
    assert.equal((await accounts.allPayments()).length, 1); // kept for bookkeeping
    // Signing in again: a fresh, empty free account.
    const again = await signInAs(base, alice);
    assert.deepEqual((await again.call("GET", "/api/state")).body.agents, []);
    assert.equal((await again.call("GET", "/api/me")).body.plan, "free");
    assert.equal((await again.call("POST", "/api/account/delete", { confirm: "delete" })).status, 200);
  } finally { server.close(); }
});

test("privacy statement, served with the operator from the environment; fonts from this server", async () => {
  const off = await boot();
  try {
    const page = await (await fetch(`${off.base}/privacy`)).text();
    assert.match(page, /\[OPERATOR_NAME: set in Render\]/);
    assert.match(page, /Autoriteit Persoonsgegevens/);
  } finally { off.server.close(); }
  const on = await boot({ operator: { name: "Frits <Test>", email: "privacy@example.com" } });
  try {
    const res = await fetch(`${on.base}/privacy`);
    const page = await res.text();
    assert.ok(page.includes("Frits &lt;Test&gt;"));
    assert.ok(page.includes('href="mailto:privacy@example.com"'));
    assert.doesNotMatch(page, /set in Render/);
    assert.match(res.headers.get("content-security-policy"), /font-src 'self'/);
    const terms = await (await fetch(`${on.base}/terms`)).text();
    assert.ok(terms.includes("Frits &lt;Test&gt;"));
    assert.match(terms, /right of withdrawal/);
    assert.match(terms, /\$5 per 30 days/);
    assert.doesNotMatch(terms, /\{\{/);
    const dash = await (await fetch(`${on.base}/`)).text();
    assert.match(dash, /href="\/terms"/);
    assert.doesNotMatch(dash, /googleapis|gstatic/);
    const font = await fetch(`${on.base}/fonts/dm-sans-latin-400-normal.woff2`);
    assert.equal(font.status, 200);
    assert.ok((await font.arrayBuffer()).byteLength > 5000);
    assert.equal((await fetch(`${on.base}/fonts/../server.js`)).status, 404);
  } finally { on.server.close(); }
});

// ---------- Solana: sign in with Phantom, pay Pro in USDC on Solana ----------

test("Solana: sign in with a Solana wallet, pay Pro in USDC on Solana, checked on-chain", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519");
  const sol = await import("../src/solana.js");
  const key = () => { const priv = ed25519.utils.randomPrivateKey(); return { priv, address: sol.b58encode(ed25519.getPublicKey(priv)) }; };
  const SOL_PAY_TO = key().address, alice = key(), mallory = key();
  const sign = (k, message) => sol.b58encode(ed25519.sign(new TextEncoder().encode(message), k.priv));
  const blockhash = key().address;
  const txs = new Map();
  // A parsed Solana transaction in which `from` sends `usdc` to `to` (token balances before and after).
  const solPay = (from, usdc, { to = SOL_PAY_TO, err = null, ageDays = 0, mint = sol.USDC_MINT } = {}) => {
    const sig = sol.b58encode(randomBytes(64));
    const units = String(Math.round(usdc * 1e6));
    txs.set(sig, {
      blockTime: Math.floor(Date.now() / 1000) - ageDays * 86400,
      meta: { err, preTokenBalances: [{ mint, owner: from.address, uiTokenAmount: { amount: "100000000" } }, { mint, owner: to, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ mint, owner: from.address, uiTokenAmount: { amount: String(100000000 - Number(units)) } }, { mint, owner: to, uiTokenAmount: { amount: units } }] },
      transaction: { message: { accountKeys: [{ pubkey: from.address, signer: true }, { pubkey: to, signer: false }] } },
    });
    return sig;
  };
  const rpc = async (method, params) => {
    if (method === "getLatestBlockhash") return { value: { blockhash, lastValidBlockHeight: 1 } };
    if (method === "getTransaction") return txs.get(params[0]) ?? null;
    return null;
  };
  const { base, server } = await boot({ rpc, solana: { payTo: SOL_PAY_TO, rpcUrl: "https://sol.test" } });
  const post = (path, body, cookie) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).solana, true);
    assert.equal((await post("/api/signin/message", { address: "0x1234", chain: "solana" })).status, 400);
    const m = await (await post("/api/signin/message", { address: alice.address, chain: "solana" })).json();
    assert.match(m.message, /^127\.0\.0\.1:\d+ wants you to sign in with your Solana account:\n/);
    assert.ok(m.message.includes(alice.address));
    // Someone else's signature, or a signature over another text, doesn't sign in.
    assert.equal((await post("/api/signin", { nonce: m.nonce, signature: sign(mallory, m.message) })).status, 401);
    const m2 = await (await post("/api/signin/message", { address: alice.address, chain: "solana" })).json();
    const r = await post("/api/signin", { nonce: m2.nonce, signature: sign(alice, m2.message) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie").split(";")[0];
    const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => null) }; };

    const me = (await call("GET", "/api/me")).body;
    assert.equal(me.id, `sol:${alice.address}`);
    assert.equal(me.chain, "solana");
    assert.equal(me.plan, "free");
    assert.equal(me.auto, null);
    assert.deepEqual({ chain: me.billing.chain, payTo: me.billing.payTo, mint: me.billing.mint, priceUsdc: me.billing.priceUsdc }, { chain: "solana", payTo: SOL_PAY_TO, mint: sol.USDC_MINT, priceUsdc: 5 });

    // The transaction to sign: USDC from alice to the owner, the right amount, the latest blockhash.
    const { body: tx } = await call("POST", "/api/billing/solana", { months: 12 });
    assert.equal(tx.amountUsdc, 60);
    assert.equal(tx.message, sol.usdcTransferMessage({ from: alice.address, to: SOL_PAY_TO, amount: 60_000_000n, blockhash }));

    // Claims: not a signature, not confirmed, failed, too little, someone else's payment, wrong token, too old.
    assert.equal((await call("POST", "/api/billing/claim", { txHash: "0xabc" })).status, 400);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: sol.b58encode(randomBytes(64)) })).status, 409);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: solPay(alice, 5, { err: { InstructionError: [1, "x"] } }) })).status, 400);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: solPay(alice, 4) })).status, 400);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: solPay(mallory, 5) })).status, 400);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: solPay(alice, 5, { mint: key().address }) })).status, 400);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: solPay(alice, 5, { to: key().address }) })).status, 400);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: solPay(alice, 5, { ageDays: 8 }) })).status, 400);
    assert.equal((await call("GET", "/api/me")).body.plan, "free");

    // A real payment: Pro for a month, once.
    const good = solPay(alice, 5);
    const paid = (await call("POST", "/api/billing/claim", { txHash: good })).body;
    assert.equal(paid.plan, "pro");
    assert.equal(paid.payments[0].chain, "solana");
    assert.equal(paid.payments[0].months, 1);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: good })).body.payments.length, 1); // the same claim again changes nothing

    // An Ethereum account can't use the Solana payment route.
    const eth = await signInAs(base, customer());
    assert.equal((await eth.call("POST", "/api/billing/solana", { months: 1 })).status, 400);
    assert.equal((await eth.call("GET", "/api/me")).body.billing.chain, "base");
  } finally { server.close(); }
});

test("Solana: off unless SOLANA_PAY_TO is set", async () => {
  const { base, server } = await boot();
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).solana, false);
  } finally { server.close(); }
});

test("search bar: paid APIs from the x402 catalog, USDC on the networks we know, best match first, signed-in only", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  let calls = 0;
  const usdc = (network, asset, amount) => ({ scheme: "exact", network, asset, amount, payTo: PAY_TO });
  const items = [
    { resource: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", description: "Ichimoku cloud trend signal for a crypto pair", accepts: [usdc("eip155:8453", USDC, "20000"), usdc("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "20000")], extensions: { bazaar: { info: { input: { method: "GET" } } } } },
    { resource: "https://ichimoku-signal.fizzl.eu/signal/ETH-USDT", description: "Ichimoku cloud trend signal for a crypto pair", accepts: [usdc("eip155:8453", USDC, "20000")] },
    { resource: "https://cheap.example/trend", description: "Crypto trend in one word", accepts: [usdc("eip155:42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "5000")] },
    { resource: "https://pricey.example/signal", description: "Premium crypto trend signal", accepts: [usdc("eip155:8453", USDC, "5000000")] },
    { resource: "https://fake-usdc.example/signal", description: "Crypto trend signal paid in a token that only looks like USDC", accepts: [usdc("eip155:8453", "0x0000000000000000000000000000000000000001", "1000")] },
    { resource: "http://plain-http.example/signal", description: "Crypto trend signal over plain http", accepts: [usdc("eip155:8453", USDC, "1000")] },
    { resource: "https://weather.example/today", description: "Weather forecast <script>alert(1)</script>", accepts: [usdc("eip155:8453", USDC, "1000")] },
  ];
  const catalog = createCatalog({ url: "https://catalog.test/discovery", fetch: async () => { calls++; return Response.json({ items }); } });
  const { base, server, owner } = await boot({ catalog });
  try {
    assert.equal((await fetch(`${base}/api/services/search?q=crypto`)).status, 401); // signed in only
    const r = (await owner("GET", "/api/services/search?q=crypto%20trend%20signal&max=1")).body;
    // Matches with USDC prices up to $1; the fake token, plain http, the $5 one and the weather are left out; one result per URL.
    assert.deepEqual(r.results.map((x) => x.url), ["https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", "https://ichimoku-signal.fizzl.eu/signal/ETH-USDT", "https://cheap.example/trend"]);
    assert.deepEqual(r.results[0].prices, [{ network: "Base", usd: 0.02 }, { network: "Solana", usd: 0.02 }]);
    assert.equal(r.results[0].method, "GET");
    assert.equal(r.results[2].prices[0].network, "Arbitrum");
    assert.equal((await owner("GET", "/api/services/search?q=crypto%20trend&max=0.01")).body.results.map((x) => x.host).join(), "cheap.example");
    assert.equal((await owner("GET", "/api/services/search?q=weather")).body.results[0].description, "Weather forecast <script>alert(1)</script>"); // data, escaped by the page
    assert.equal((await owner("GET", "/api/services/search?q=a")).body.results.length, 0);
    assert.equal(calls, 1); // the catalog is fetched once and kept
  } finally { server.close(); }
});

test("search bar: a catalog that can't be reached is a clear 502", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const { server, owner } = await boot({ catalog: createCatalog({ url: "https://catalog.test/x", fetch: async () => new Response("down", { status: 503 }) }) });
  try {
    const r = await owner("GET", "/api/services/search?q=crypto");
    assert.equal(r.status, 502);
    assert.match(r.body.message, /can't be reached/);
  } finally { server.close(); }
});


test("new providers: the first catalog is the baseline; sellers that appear later are marked NEW and listed, and it survives a restart", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const store = memoryStore();
  let t = Date.parse("2026-10-01T00:00:00Z");
  const usdc = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: PAY_TO });
  let items = [{ resource: "https://old.example/signal", description: "Crypto trend signal", accepts: [usdc("10000")] }];
  const make = () => createCatalog({ url: "https://catalog.test/d", now: () => t, seen: store.global, fetch: async () => Response.json({ items }) });
  let catalog = make();
  assert.equal((await catalog.search("crypto signal")).results[0].isNew, false); // baseline: not new
  assert.equal((await catalog.newProviders()).providers.length, 0);

  // Two hours later the catalog is fetched again with a new seller.
  t += 2 * 3_600_000;
  items = [...items, { resource: "https://fresh.example/signal", description: "Fresh crypto trend signal", accepts: [usdc("20000")] }, { resource: "https://fresh.example/levels", description: "Support and resistance", accepts: [usdc("50000")] }];
  const hits = (await catalog.search("crypto signal")).results;
  assert.deepEqual(hits.map((h) => [h.host, h.isNew]), [["old.example", false], ["fresh.example", true]]); // same match: cheapest first
  const fresh = (await catalog.newProviders()).providers;
  assert.deepEqual(fresh.map((p) => [p.host, p.listings, p.cheapest]), [["fresh.example", 2, 0.02]]);
  assert.equal(fresh[0].firstSeen, t);

  // A restart (new catalog object, same store) keeps when each seller was first seen; after 8 days it isn't new anymore.
  catalog = make();
  assert.equal((await catalog.newProviders()).providers[0].host, "fresh.example");
  t += 8 * 86_400_000;
  catalog = make();
  assert.equal((await catalog.newProviders()).providers.length, 0);
  assert.equal((await catalog.newProviders({ days: 30 })).providers.length, 1);
});

test("categories: listings sorted by what they say they do, with counts; search within a category", async () => {
  const { createCatalog, categorize } = await import("../src/catalog.js");
  assert.equal(categorize("Ichimoku cloud trend signal for a crypto pair"), "crypto");
  assert.equal(categorize("Is this token a honeypot or a scam? Safety verdict"), "security");
  assert.equal(categorize("Weather forecast API for a city"), "weather"); // a tie with dev tools goes to the specific one
  assert.equal(categorize("Something nobody can place"), "other");
  const usdc = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: PAY_TO });
  const items = [
    { resource: "https://a.example/signal", description: "Crypto trend signal for bitcoin", accepts: [usdc("20000")] },
    { resource: "https://b.example/price", description: "Live crypto token price", accepts: [usdc("5000")] },
    { resource: "https://c.example/token", description: "Token scam and honeypot safety check", accepts: [usdc("10000")] },
    { resource: "https://d.example/forecast", description: "Weather forecast for a city", accepts: [usdc("1000")] },
    { resource: "https://e.example/pricey", description: "Premium crypto market signal", accepts: [usdc("9000000")] },
  ];
  const catalog = createCatalog({ url: "https://catalog.test/d", fetch: async () => Response.json({ items }) });
  const { server, owner } = await boot({ catalog });
  try {
    const cats = Object.fromEntries((await owner("GET", "/api/services/categories?max=1")).body.categories.map((c) => [c.id, c.count]));
    assert.deepEqual(cats, { crypto: 2, security: 1, weather: 1 }); // the $9 one is above the cap; empty categories are left out
    // A category without words: everything in it, cheapest first.
    const all = (await owner("GET", "/api/services/search?cat=crypto&max=1")).body;
    assert.deepEqual(all.results.map((r) => r.host), ["b.example", "a.example"]);
    assert.ok(all.results.every((r) => r.category === "crypto"));
    // Words within a category; a bad category name is ignored.
    assert.deepEqual((await owner("GET", "/api/services/search?q=bitcoin&cat=crypto")).body.results.map((r) => r.host), ["a.example"]);
    assert.equal((await owner("GET", "/api/services/search?q=bitcoin&cat=security")).body.results.length, 0);
    assert.equal((await owner("GET", "/api/services/search?q=weather&cat=../../x")).body.results[0].host, "d.example");
  } finally { server.close(); }
});

test("search bar in the demo: the same catalog without signing in, rate-limited, read-only", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const usdc = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: PAY_TO });
  const catalog = createCatalog({ url: "https://catalog.test/d", fetch: async () => Response.json({ items: [{ resource: "https://a.example/signal", description: "Crypto trend signal", accepts: [usdc("20000")] }] }) });
  const { base, server } = await boot({ catalog });
  try {
    const r = await fetch(`${base}/api/public/services/search?q=crypto%20signal`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).results[0].host, "a.example");
    assert.equal((await fetch(`${base}/api/public/services/categories`)).status, 200);
    assert.equal((await fetch(`${base}/api/public/services/new`)).status, 200);
    // Only reads: nothing else is reachable under /api/public.
    assert.equal((await fetch(`${base}/api/public/services/search`, { method: "POST" })).status, 401); // falls through to the signed-in API
    assert.equal((await fetch(`${base}/api/public/state`)).status, 401);
    // At most 60 a minute per address.
    let last;
    for (let i = 0; i < 60; i++) last = await fetch(`${base}/api/public/services/search?q=crypto`);
    assert.equal(last.status, 429);
  } finally { server.close(); }
});

test("skill.md: instructions an agent can follow, with this server's address", async () => {
  const { base, server } = await boot();
  try {
    const r = await fetch(`${base}/skill.md`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/markdown/);
    const md = await r.text();
    assert.match(md, /^---\nname: fizzl-agent-wallet\n/);
    assert.ok(!md.includes("{{ORIGIN}}"));
    assert.ok(md.includes(`"WALLET_SERVER_URL": "${base}"`)); // this server, here a local one
    assert.match(md, /Never ask your owner to paste a private key/);
    for (const tool of ["wallet_status", "find_services", "pay_x402", "send_usdc", "pause_spending"]) assert.ok(md.includes(`\`${tool}\``), tool);
    // Behind a proxy on a real domain the address is https.
    const viaProxy = await (await fetch(`${base}/skill.md`, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "wallet.example" } })).text();
    assert.ok(viaProxy.includes('"WALLET_SERVER_URL": "https://wallet.example"'));
  } finally { server.close(); }
});

test("skill.md check: only public https sellers, no redirects, small markdown; cached; shown in search results", async () => {
  const { createCatalog, createSkillChecker, isPrivateAddress } = await import("../src/catalog.js");
  for (const a of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.5", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) assert.ok(isPrivateAddress(a), a);
  for (const a of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isPrivateAddress(a), a);
  const fetched = [];
  const answers = {
    "https://good.example/skill.md": () => new Response("---\nname: good\n---\n# Good", { headers: { "content-type": "text/markdown" } }),
    "https://html.example/skill.md": () => new Response("<html>not found page</html>", { headers: { "content-type": "text/html" } }),
    "https://text-html.example/skill.md": () => new Response("<!doctype html>", { headers: { "content-type": "text/plain" } }),
    "https://redirect.example/skill.md": () => new Response("", { status: 301, headers: { location: "http://169.254.169.254/" } }),
    "https://missing.example/skill.md": () => new Response("nope", { status: 404 }),
  };
  const fetchImpl = async (url, init) => { fetched.push(url); assert.equal(init.redirect, "manual"); return (answers[url] ?? (() => new Response("", { status: 404 })))(); };
  const lookup = async (host) => (host === "internal.example" ? [{ address: "10.1.2.3" }] : [{ address: "93.184.216.34" }]);
  const checker = createSkillChecker({ fetch: fetchImpl, lookup });
  const origins = ["https://good.example", "https://html.example", "https://text-html.example", "https://redirect.example", "https://missing.example", "https://internal.example", "https://93.184.216.34", "https://port.example:8443", "http://plain.example"];
  await checker.check(origins);
  assert.deepEqual(origins.map((o) => checker.known(o)), [true, false, false, false, false, false, false, false, false]);
  assert.ok(!fetched.some((u) => /internal|93\.184|8443|plain/.test(u))); // never asked
  const before = fetched.length;
  await checker.check(["https://good.example"]);
  assert.equal(fetched.length, before); // cached

  // In search results.
  const usdc = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: PAY_TO });
  const catalog = createCatalog({ url: "https://catalog.test/d", skills: checker, fetch: async () => Response.json({ items: [
    { resource: "https://good.example/signal", description: "Crypto trend signal", accepts: [usdc("10000")] },
    { resource: "https://missing.example/signal", description: "Crypto trend signal too", accepts: [usdc("20000")] },
  ] }) });
  const r = await catalog.search("crypto signal");
  assert.deepEqual(r.results.map((x) => [x.host, x.skill]), [["good.example", "https://good.example/skill.md"], ["missing.example", null]]);
});

test("test my setup: key, contact, rules, balance and Telegram, checked without paying anything", async () => {
  const AGENT = privateKeyToAccount(generatePrivateKey()).address;
  let balance = 0n;
  const { server, owner, agent, tg } = await boot({ rpc: async (method, params) => (method === "eth_call" && params[0].to === USDC ? `0x${balance.toString(16).padStart(64, "0")}` : null) });
  try {
    const check = async (body = {}) => { const r = await owner("POST", "/api/setup/check", body); assert.equal(r.status, 200); return { ...r.body, by: Object.fromEntries(r.body.checks.map((c) => [c.id, c])) }; };
    let r = await check();
    assert.equal(r.by.agent.status, "ok");
    assert.equal(r.by.contact.status, "fail"); // never reached the wallet
    assert.match(r.by.contact.fix, /WALLET_SERVER_URL/);
    assert.equal(r.by.rules.status, "ok");
    assert.equal(r.by.balance.status, "warn"); // address unknown
    assert.equal(r.by.telegram.status, "ok");
    assert.equal(r.ready, false);

    // Any agent call counts as contact.
    assert.equal((await agent("GET", "/v1/spending")).status, 200);
    await new Promise((ok) => setTimeout(ok, 20));
    r = await check();
    assert.equal(r.by.contact.status, "ok");
    assert.match(r.by.contact.detail, /just now/);

    // The agent's address: pasted by the owner (validated), then its USDC on Base is read.
    assert.equal((await owner("PUT", `/api/agents/${r.agent.id}/address`, { address: "not-an-address" })).status, 400);
    assert.equal((await owner("PUT", `/api/agents/${r.agent.id}/address`, { address: AGENT })).body.address, AGENT);
    r = await check();
    assert.equal(r.by.balance.status, "fail");
    assert.match(r.by.balance.fix, /USDC on Base/);
    balance = 2_500_000n;
    r = await check();
    assert.equal(r.by.balance.status, "ok");
    assert.match(r.by.balance.detail, /2\.50 USDC/);
    assert.equal(r.ready, true);

    // Telegram: a test message on request, at most once a minute.
    const before = tg.calls.filter((c) => c.method === "sendMessage").length;
    r = await check({ telegram: true });
    assert.match(r.by.telegram.detail, /test message/);
    await check({ telegram: true });
    const sent = tg.calls.filter((c) => c.method === "sendMessage");
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1).body.chat_id, "4242");
    assert.match(sent.at(-1).body.text, /Nothing was paid/);

    // A paused agent can't spend.
    await owner("POST", `/api/agents/${r.agent.id}/pause`, { paused: true });
    r = await check();
    assert.equal(r.by.rules.status, "fail");
    assert.equal(r.ready, false);
  } finally { server.close(); }
});

test("test my setup: the agent's address is learned from the payment it signs", async () => {
  const { server, owner, agent } = await boot();
  try {
    const from = privateKeyToAccount(generatePrivateKey()).address;
    const request = { type: "signature", chainId: 8453, typedData: { domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC }, primaryType: "TransferWithAuthorization", types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, message: { from, to: SHOP, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"1".repeat(64)}` } } };
    await agent("POST", "/v1/reserve", { method: "signTypedData", request });
    assert.equal((await owner("GET", "/api/state")).body.agents[0].address, from);
  } finally { server.close(); }
});

test("new providers on Telegram: per followed category, once per new seller, never for the baseline", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const { server, owner, accounts, tg } = await boot();
  try {
    assert.equal((await owner("PUT", "/api/follow", { categories: ["crypto", "nope"] })).status, 400);
    assert.deepEqual((await owner("PUT", "/api/follow", { categories: ["crypto", "security"] })).body.follow, ["crypto", "security"]);
    assert.deepEqual((await owner("GET", "/api/me")).body.follow, ["crypto", "security"]);

    let t = Date.parse("2026-10-01T00:00:00Z");
    const usdc = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: PAY_TO });
    let items = [{ resource: "https://old.example/signal", description: "Crypto trend signal", accepts: [usdc("10000")] }];
    const alerts = [];
    const catalog = createCatalog({ url: "https://catalog.test/d", now: () => t, seen: memoryStore().global, fetch: async () => Response.json({ items }),
      onNew: async (p) => { alerts.push(p); await accounts.alertNewProviders(p); } });
    await catalog.refresh();
    assert.equal(alerts.length, 0); // the first catalog is the baseline

    const sentBefore = tg.calls.filter((c) => c.method === "sendMessage").length;
    t += 2 * 3_600_000;
    items = [...items,
      { resource: "https://btc.example/signal", description: "Bitcoin trading signal", accepts: [usdc("20000")] },
      { resource: "https://btc.example/levels", description: "Crypto support levels", accepts: [usdc("50000")] },
      { resource: "https://rain.example/forecast", description: "Weather forecast for a city", accepts: [usdc("5000")] }];
    await catalog.refresh();
    await new Promise((ok) => setTimeout(ok, 30));
    assert.deepEqual(alerts[0].map((p) => [p.host, p.category, p.listings, p.cheapest]).sort(), [["btc.example", "crypto", 2, 0.02], ["rain.example", "weather", 1, 0.005]]);
    const sent = tg.calls.filter((c) => c.method === "sendMessage").slice(sentBefore);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.chat_id, "4242");
    assert.match(sent[0].body.text, /A new provider in the x402 catalog/);
    assert.match(sent[0].body.text, /btc\.example/);
    assert.doesNotMatch(sent[0].body.text, /rain\.example/); // weather isn't followed
    assert.match(sent[0].body.text, /not recommendations/);

    // Following nothing: no message. "all": everything.
    await owner("PUT", "/api/follow", { categories: [] });
    assert.equal(await accounts.alertNewProviders(alerts[0]), 0);
    await owner("PUT", "/api/follow", { categories: ["all"] });
    assert.equal(await accounts.alertNewProviders(alerts[0]), 1);
    assert.match(tg.calls.at(-1).body.text, /2 new providers/);
  } finally { server.close(); }
});

test("search bar: more than 20 results come in pages, like a search engine", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const items = Array.from({ length: 45 }, (_, i) => ({ resource: `https://seller${i}.example/signal`, description: "Crypto trend signal", accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: String(1000 + i), payTo: PAY_TO }] }));
  const catalog = createCatalog({ url: "https://catalog.test/discovery", fetch: async () => Response.json({ items }) });
  const { server, owner } = await boot({ catalog });
  try {
    const page = async (n) => (await owner("GET", `/api/services/search?q=crypto%20signal${n ? `&page=${n}` : ""}`)).body;
    const p1 = await page();
    assert.deepEqual([p1.results.length, p1.total, p1.page, p1.pages], [20, 45, 1, 3]);
    assert.equal(p1.results[0].host, "seller0.example"); // same match: cheapest first
    const p3 = await page(3);
    assert.deepEqual([p3.results.length, p3.page], [5, 3]);
    assert.equal(p3.results.at(-1).host, "seller44.example");
    const seen = new Set([...p1.results, ...(await page(2)).results, ...p3.results].map((r) => r.url));
    assert.equal(seen.size, 45); // every result exactly once
    assert.equal((await page(99)).page, 3); // past the end: the last page
    assert.equal((await page("x")).page, 1);
  } finally { server.close(); }
});

test("browsing a category: one card per provider; providers with a skill.md first, then new ones, then the cheapest", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const usdc = (amount, network = "eip155:8453", asset = USDC) => ({ scheme: "exact", network, asset, amount, payTo: PAY_TO });
  const items = [
    ...Array.from({ length: 50 }, (_, i) => ({ resource: `https://flood.example/coin/${i}`, description: "Crypto token price", accepts: [usdc(String(1000 + i))] })),
    { resource: "https://ichimoku.example/signal", description: "Ichimoku crypto trend signal", accepts: [usdc("20000"), usdc("20000", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")] },
    { resource: "https://ichimoku.example/setups", description: "Ranked crypto trade setups", accepts: [usdc("500000")] },
    { resource: "https://mid.example/price", description: "Crypto price feed", accepts: [usdc("3000")] },
  ];
  const withSkill = new Set(["https://ichimoku.example"]);
  const skills = { known: (o) => withSkill.has(o), check: async () => {} };
  const catalog = createCatalog({ url: "https://catalog.test/d", fetch: async () => Response.json({ items }), skills });
  const { server, owner } = await boot({ catalog });
  try {
    const r = (await owner("GET", "/api/services/search?cat=crypto")).body;
    assert.deepEqual(r.results.map((x) => [x.host, x.endpoints]), [["ichimoku.example", 2], ["flood.example", 50], ["mid.example", 1]]);
    assert.equal(r.total, 3);
    const ichi = r.results[0];
    assert.equal(ichi.skill, "https://ichimoku.example/skill.md");
    assert.equal(ichi.url, "https://ichimoku.example/signal"); // its cheapest endpoint
    assert.deepEqual(ichi.prices.map((p) => p.network).sort(), ["Base", "Solana"]);
    assert.equal(r.results[1].cheapest, 0.001);
    const cats = (await owner("GET", "/api/services/categories")).body.categories.find((c) => c.id === "crypto");
    assert.deepEqual([cats.count, cats.providers], [53, 3]);
    // Words still search every endpoint.
    assert.equal((await owner("GET", "/api/services/search?q=token%20price&cat=crypto")).body.total, 51); // 50 flood endpoints + the price feed, one by one
  } finally { server.close(); }
});

test("x402 Doctor's track records: summed up per seller; proven sellers first within the skill.md group, labelled on the cards", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const { createTrustIndex, summarizeIndex } = await import("../src/trust.js");
  const index = { days: [], resources: {
    "https://steady.example/a": { h: "----gggggggggg" },          // 10 of 10
    "https://steady.example/b/:id": { h: "ggggggggcg" },          // caution still pays out
    "https://flaky.example/a": { h: "gnnxnngnnx" },               // 2 of 10
    "https://young.example/a": { h: "--------gg" },               // too short to be proven
    "not a url": { h: "ggg" },
  } };
  const s = summarizeIndex(index);
  assert.deepEqual(s.get("https://steady.example"), { days: 10, payableDays: 10, ratio: 1 });
  assert.deepEqual(s.get("https://flaky.example"), { days: 10, payableDays: 2, ratio: 0.2 });
  let fetched = 0;
  const trust = createTrustIndex({ url: "https://trust.test/index.json", fetch: async () => { fetched++; return Response.json(index); } });
  await trust.ready();
  assert.deepEqual([trust.tier("https://steady.example"), trust.tier("https://young.example"), trust.tier("https://unknown.example"), trust.tier("https://flaky.example")], [2, 1, 1, 0]);

  const usdc = (amount) => [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: PAY_TO }];
  const items = [
    { resource: "https://flaky.example/a", description: "Crypto price", accepts: usdc("1000") },
    { resource: "https://unknown.example/a", description: "Crypto price", accepts: usdc("1000") },
    { resource: "https://steady.example/a", description: "Crypto trend signal", accepts: usdc("20000") },
    { resource: "https://young.example/a", description: "Crypto price", accepts: usdc("2000") },
    { resource: "https://noskill.example/a", description: "Crypto price", accepts: usdc("500") },
  ];
  const skills = { known: (o) => o !== "https://noskill.example", check: async () => {} };
  const catalog = createCatalog({ url: "https://catalog.test/d", fetch: async () => Response.json({ items }), skills, trust });
  const { server, owner } = await boot({ catalog });
  try {
    const r = (await owner("GET", "/api/services/search?cat=crypto")).body;
    // skill.md group: proven first, then unknown/young (cheapest first), then the often failing one; no skill.md last.
    assert.deepEqual(r.results.map((x) => x.host), ["steady.example", "unknown.example", "young.example", "flaky.example", "noskill.example"]);
    assert.deepEqual(r.results[0].record, { days: 10, payableDays: 10, ratio: 1 });
    assert.equal(r.results[1].record, null);
    assert.equal(fetched, 1); // loaded once, kept 6 hours
  } finally { server.close(); }
});

test("search filters: network, new, skill.md, reliable, and sorting", async () => {
  const { createCatalog } = await import("../src/catalog.js");
  const { createTrustIndex } = await import("../src/trust.js");
  const SOL = ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];
  const pay = (amount, [network, asset] = ["eip155:8453", USDC]) => ({ scheme: "exact", network, asset, amount, payTo: PAY_TO });
  const items = [
    { resource: "https://both.example/signal", description: "Crypto signal", accepts: [pay("20000"), pay("10000", SOL)] },
    { resource: "https://base.example/signal", description: "Crypto signal", accepts: [pay("5000")] },
    { resource: "https://sol.example/signal", description: "Crypto signal", accepts: [pay("30000", SOL)] },
  ];
  const trust = createTrustIndex({ url: "https://trust.test/i", fetch: async () => Response.json({ resources: { "https://both.example/signal": { h: "gggggggggg" }, "https://base.example/signal": { h: "gnnnnnnnnn" } } }) });
  const skills = { known: (o) => o !== "https://base.example", check: async () => {} };
  let t = Date.parse("2026-10-01T00:00:00Z");
  const store = memoryStore();
  let list = items.slice(0, 2);
  const catalog = createCatalog({ url: "https://catalog.test/d", now: () => t, seen: store.global, fetch: async () => Response.json({ items: list }), skills, trust });
  await catalog.refresh(); // both.example and base.example are the baseline
  t += 2 * 3_600_000; list = items; await catalog.refresh(); // sol.example is new
  const { server, owner } = await boot({ catalog });
  try {
    const hosts = async (qs) => (await owner("GET", `/api/services/search?q=crypto%20signal&${qs}`)).body.results.map((r) => r.host);
    assert.deepEqual(await hosts(""), ["base.example", "both.example", "sol.example"]); // same match: cheapest first
    assert.deepEqual(await hosts("net=Solana"), ["both.example", "sol.example"]);
    const solOnly = (await owner("GET", "/api/services/search?q=crypto%20signal&net=Solana")).body.results[0];
    assert.deepEqual([solOnly.prices.map((p) => p.network), solOnly.cheapest], [["Solana"], 0.01]); // prices for the chosen network
    assert.deepEqual(await hosts("net=Base,Nope"), ["base.example", "both.example"]);
    assert.deepEqual(await hosts("new=1"), ["sol.example"]);
    assert.deepEqual(await hosts("skill=1"), ["both.example", "sol.example"]);
    assert.deepEqual(await hosts("reliable=1"), ["both.example"]);
    assert.deepEqual(await hosts("sort=record"), ["both.example", "sol.example", "base.example"]); // proven, unknown, failing
    assert.deepEqual(await hosts("sort=cheap&net=Solana"), ["both.example", "sol.example"]);
    // Filters alone (no words, no category): every provider that passes, one card each.
    const onlyReliable = (await owner("GET", "/api/services/search?reliable=1")).body;
    assert.deepEqual(onlyReliable.results.map((r) => [r.host, r.endpoints]), [["both.example", 1]]);
    assert.equal((await owner("GET", "/api/services/search?net=Base")).body.total, 0); // a network alone isn't a search
  } finally { server.close(); }
});
