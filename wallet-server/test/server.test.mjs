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
import { createPush, encrypt, cleanSubscription } from "../src/push.js";
import { createECDH, createPublicKey, verify } from "node:crypto";

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

async function boot({ approvalTtlMs, rpc = async () => null, now, operator, solana = null, xrpl = null, algorand = null, indexer = null, xaman = null, catalog = null, usage = undefined, stats = undefined, endpointMonitor = undefined, alertHook = undefined, push = undefined, mailer = undefined } = {}) {
  const store = memoryStore();
  const tg = fakeTelegramApi();
  const telegram = createTelegram({ token: "1:abc", publicUrl: "https://wallet.test", webhookSecret: "s3cret-hook", username: "FizzlTestBot", fetch: tg.fetchImpl });
  const rpcFetch = async (url, init) => {
    // The Algorand indexer (GET, REST): indexer(url) gives the JSON, or null for a 404.
    if (indexer && String(url).startsWith("https://idx.test")) { const j = await indexer(String(url)); return j === null ? new Response("{}", { status: 404 }) : Response.json(j); }
    // An Algorand node (algod) for Defly sign-ins: the current round and the network.
    if (String(url).startsWith("https://algod.test/v2/transactions/params")) return Response.json({ "last-round": 50_000_000, "genesis-hash": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "genesis-id": "mainnet-v1.0", fee: 0, "min-fee": 1000 });
    const { method, params } = JSON.parse(init.body); return Response.json({ jsonrpc: "2.0", id: 1, result: await rpc(method, params) });
  };
  const accounts = createAccounts({
    store, telegram, adminChatId: "4242", publicUrl: "https://wallet.test", ...(now ? { now } : {}),
    billing: { payTo: PAY_TO, priceUsdc: 5, rpcUrl: "https://rpc.test", fetch: rpcFetch, ...(solana ? { solana } : {}), ...(xrpl ? { xrpl } : {}), ...(algorand ? { algorand } : {}) },
    walletOptions: { signers: [presignKey.address], authority: null, approvalTtlMs },
    ...(usage ? { usage } : {}),
    ...(endpointMonitor ? { endpointMonitor } : {}),
    ...(alertHook ? { alertHook } : {}),
    ...(push ? { push } : {}),
    ...(mailer ? { mailer } : {}),
    ...(xaman ? { xaman } : {}),
  });
  const app = createApp({ accounts, auth: createAuth({ password: PASSWORD, secure: false }), telegram, operator, catalog, ...(usage ? { usage } : {}), ...(stats ? { stats } : {}) });
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

test("over the limit with a webhook set: it also says what's waiting and links to the dashboard (no buttons)", async () => {
  const hooked = [];
  const alertHook = { send: async (url, text, event) => { hooked.push({ url, text, event }); } };
  const { owner, agent, server } = await boot({ alertHook });
  try {
    assert.deepEqual((await owner("PUT", "/api/monitors/alert-hook", { url: "https://hooks.slack.com/services/T/B/x" })).body.hook, { kind: "slack", host: "hooks.slack.com" });
    const req = txRequest(8);
    const r = await agent("POST", "/v1/reserve", { method: "sendTransaction", request: req, verdict: await signedVerdict(req) });
    assert.equal(r.body.status, "pending");
    await new Promise((ok) => setTimeout(ok, 20));
    const h = hooked.find((x) => x.event.type === "approval");
    assert.match(h.text, /research-agent wants to sign something over your limit: 8 USDC is over the limit/);
    assert.match(h.text, /Approve or deny on https:\/\/wallet\.test\/#\/overview/);
    assert.equal(h.event.dashboard, "https://wallet.test/#/overview");
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

async function signInAs(base, account, { ref } = {}) {
  const m = await (await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account.address }) })).json();
  const r = await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: m.nonce, signature: await account.signMessage({ message: m.message }), ref }) });
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

    // A wallet on another network (Phantom starts on Ethereum) gets a message naming that chain,
    // since some wallets refuse to sign one that names another; signing in works the same.
    const eth = await (await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: alice.address, chainId: 1 }) })).json();
    assert.match(eth.message, /Chain ID: 1\n/);
    const ok = await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: eth.nonce, signature: await alice.signMessage({ message: eth.message }) }) });
    assert.equal(ok.status, 200);
    const junk = await (await fetch(`${base}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: alice.address, chainId: "abc" }) })).json();
    assert.match(junk.message, /Chain ID: 8453/);

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

test("an agent's site: https only, shown on the agent, cleared with an empty value", async () => {
  const { server, owner } = await boot();
  try {
    const { body: { agent } } = await owner("POST", "/api/agents", { name: "site-bot" });
    assert.equal((await owner("PUT", `/api/agents/${agent.id}/site`, { site: "http://example.com" })).status, 400);
    assert.equal((await owner("PUT", `/api/agents/${agent.id}/site`, { site: "javascript:alert(1)" })).status, 400);
    assert.equal((await owner("PUT", `/api/agents/${agent.id}/site`, { site: "https://ichimoku-signal.fizzl.eu" })).body.site, "https://ichimoku-signal.fizzl.eu/");
    assert.equal((await owner("GET", "/api/state")).body.agents.find((a) => a.id === agent.id).site, "https://ichimoku-signal.fizzl.eu/");
    assert.equal((await owner("PUT", `/api/agents/${agent.id}/site`, { site: "" })).body.site, null);
    assert.equal((await owner("PUT", "/api/agents/nope/site", { site: "https://a.example" })).status, 404);
    // Given when adding (a guess by the page): kept when https, dropped (not refused) otherwise.
    assert.equal((await owner("POST", "/api/agents", { name: "with-site", site: "https://shop.example/" })).body.agent.site, "https://shop.example/");
    const bad = await owner("POST", "/api/agents", { name: "bad-site", site: "http://shop.example/" });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.agent.site, null);
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

test("Pro 20 ($9, 20 endpoints) and Pro Unlimited ($20); a pasted $9 hash counts as Pro 20; Pro alone stays at 10", async () => {
  const c = chain();
  const endpointMonitor = { check: async () => ({ state: "ok", status: 402, ms: 10, note: "ok" }) };
  const { base, server, accounts } = await boot({ rpc: c.rpc, endpointMonitor });
  try {
    const alice = customer(), bob = customer();
    const a = await signInAs(base, alice), b = await signInAs(base, bob);
    // $5 asked as Pro 20: refused, nothing claimed.
    const short = await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 5), tier: "pro20" });
    assert.equal(short.status, 400);
    assert.match(short.body.message, /no payment of 9 USDC/);
    const me = (await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 9), tier: "pro20" })).body;
    assert.equal(me.plan, "pro");
    assert.equal(me.tier, "pro20");
    assert.equal(me.limits.maxMonitors, 20);
    assert.equal(me.billing.price20Usdc, 9);
    assert.equal(me.payments.at(-1).tier, "pro20");
    for (let i = 0; i < 20; i++) assert.equal((await a.call("POST", "/api/monitors", { url: `https://shop${i}.example/paid` })).status, 200);
    assert.equal((await a.call("POST", "/api/monitors", { url: "https://shop99.example/paid" })).status, 403);
    // Pasted without a tier: $9 is a whole number of Pro 20 months, not of Pro months.
    assert.equal((await b.call("POST", "/api/billing/claim", { txHash: c.pay(bob.address, 9) })).body.tier, "pro20");
    // Plain Pro: 10.
    const carol = customer(), cc = await signInAs(base, carol);
    const pro = (await cc.call("POST", "/api/billing/claim", { txHash: c.pay(carol.address, 5) })).body;
    assert.equal(pro.tier, null);
    assert.equal(pro.limits.maxMonitors, 10);
    for (let i = 0; i < 10; i++) await cc.call("POST", "/api/monitors", { url: `https://c${i}.example/paid` });
    assert.match((await cc.call("POST", "/api/monitors", { url: "https://c99.example/paid" })).body.message, /Pro 20 watches 20/);
    // Withdrawal within 14 days: pro rata at $9 per 30 days.
    assert.ok(me.withdrawal.refundUsdc <= 9 && me.withdrawal.refundUsdc > 8.9);
    // Pro Unlimited: $20, asked for (a pasted $20 without a plan is 4 months of Pro); 250 as fair use.
    const dave = customer(), d = await signInAs(base, dave);
    const unl = (await d.call("POST", "/api/billing/claim", { txHash: c.pay(dave.address, 20), tier: "unlimited" })).body;
    assert.equal(unl.tier, "unlimited");
    assert.equal(unl.limits.maxMonitors, 250);
    assert.equal(unl.billing.priceUnlimitedUsdc, 20);
    const erin = customer(), e = await signInAs(base, erin);
    const four = (await e.call("POST", "/api/billing/claim", { txHash: c.pay(erin.address, 20) })).body;
    assert.equal(four.tier, null);
    assert.equal(four.payments.at(-1).months, 4);
    void accounts;
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

test("right of withdrawal: within 14 days, one click plus a confirmation; Pro ends, the owner is told what to refund", async () => {
  let t = Date.now();
  const c = chain(() => Math.floor(t / 1000));
  const { base, server, tg, owner, accounts } = await boot({ rpc: c.rpc, now: () => t });
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    assert.equal((await a.call("GET", "/api/me")).body.withdrawal, null); // nothing paid, nothing to withdraw
    await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 5) });
    t += 6 * 86_400_000;
    const me = (await a.call("GET", "/api/me")).body;
    assert.equal(me.plan, "pro");
    assert.equal(me.withdrawal.done, false);
    assert.equal(me.withdrawal.refundUsdc, 4); // 6 of 30 days used: $1
    assert.equal((await a.call("POST", "/api/billing/withdraw", {})).status, 400); // needs the confirmation
    const done = await a.call("POST", "/api/billing/withdraw", { confirm: "withdraw" });
    assert.equal(done.status, 200);
    assert.equal(done.body.plan, "free"); // right away, no grace days
    assert.equal(done.body.withdrawal.done, true);
    const told = tg.calls.filter((x) => x.method === "sendMessage" && x.body.chat_id === "4242").at(-1);
    assert.match(told.body.text, /refund 4 USDC on Base to 0x/i);
    assert.equal((await a.call("POST", "/api/billing/withdraw", { confirm: "withdraw" })).body.withdrawal.done, true); // twice is once
    assert.equal(await accounts.remind(), 0); // no "Pro has ended" reminders after a withdrawal
    // Not refunded yet: the owner is reminded on day 10 and day 13, each once.
    const ownerTexts = () => tg.calls.filter((x) => x.method === "sendMessage" && x.body.chat_id === "4242").map((x) => x.body.text);
    assert.equal(await accounts.remindRefunds(), 0);
    t += 10 * 86_400_000;
    assert.equal(await accounts.remindRefunds(), 1);
    assert.match(ownerTexts().at(-1), /Refund still to send: 4 USDC on Base to 0x.*4 days left/);
    assert.equal(await accounts.remindRefunds(), 0);
    t += 3 * 86_400_000;
    assert.equal(await accounts.remindRefunds(), 1);
    assert.match(ownerTexts().at(-1), /1 day left/);
    assert.equal(await accounts.remindRefunds(), 0);
    // The owner sees it and marks it refunded; customers can't.
    assert.equal((await a.call("GET", "/api/admin/withdrawals")).status, 403);
    const list = (await owner("GET", "/api/admin/withdrawals")).body.withdrawals;
    assert.equal(list.length, 1);
    assert.equal(list[0].refundUsdc, 4);
    assert.equal((await owner("POST", `/api/admin/withdrawals/${list[0].id}/refunded`, { tx: "0xabc" })).status, 200);
    assert.equal((await a.call("GET", "/api/me")).body.withdrawal.refunded, true);
    t += 4 * 86_400_000;
    assert.equal(await accounts.remindRefunds(), 0); // refunded: no more reminders
    // Paying again later is a normal new Pro period.
    await a.call("POST", "/api/billing/claim", { txHash: c.pay(alice.address, 5) });
    assert.equal((await a.call("GET", "/api/me")).body.plan, "pro");
    // After 14 days the button is gone.
    const bob = customer();
    const b = await signInAs(base, bob);
    await b.call("POST", "/api/billing/claim", { txHash: c.pay(bob.address, 5) });
    t += 15 * 86_400_000;
    assert.equal((await b.call("GET", "/api/me")).body.withdrawal, null);
    assert.equal((await b.call("POST", "/api/billing/withdraw", { confirm: "withdraw" })).status, 409);
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
    assert.match(terms, /Model withdrawal form/);
    assert.match(terms, /id="withdraw"/); // the withdrawal button lives on the terms page
    assert.doesNotMatch(terms, /Address:/); // no OPERATOR_ADDRESS set: no address line
    assert.match(terms, /\$5 per 30 days/);
    assert.doesNotMatch(terms, /\{\{/);
    const dash = await (await fetch(`${on.base}/`)).text();
    assert.match(dash, /href="\/terms"/);
    assert.doesNotMatch(dash, /googleapis|gstatic/);
    const qr = await fetch(`${on.base}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg /); // "Other wallets": opens this page on a phone
    assert.match(dash, /id="moreWallets"/);
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

test("RLUSD on the XRP Ledger: any account pays with its own destination tag, checked on-ledger, once", async () => {
  const { destinationTag, RLUSD_CURRENCY, RLUSD_ISSUER } = await import("../src/xrpl-pay.js");
  const XRPL_PAY_TO = "r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw";
  const txs = new Map();
  const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
  const xpay = (value, { tag, to = XRPL_PAY_TO, result = "tesSUCCESS", validated = true, issuer = RLUSD_ISSUER, ageDays = 0, type = "Payment", drops = false } = {}) => {
    const hash = randomBytes(32).toString("hex").toUpperCase();
    txs.set(hash, { validated, hash, date: rippleNow() - ageDays * 86400, Account: "rG589ewXmZfo9hQt6ntNaciUTpRurYF8gS", TransactionType: type, Destination: to, DestinationTag: tag,
      meta: { TransactionResult: result, delivered_amount: drops ? String(value * 1e6) : { currency: RLUSD_CURRENCY, issuer, value: String(value) } } });
    return hash;
  };
  const rpc = async (method, params) => (method === "tx" ? txs.get(params[0].transaction) ?? { error: "txnNotFound", status: "error" } : null);
  const { base, server } = await boot({ rpc, xrpl: { payTo: XRPL_PAY_TO, rpcUrl: "https://xrpl.test" } });
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).xrpl, true);
    const c = await signInAs(base, customer());
    const me = (await c.call("GET", "/api/me")).body;
    const tag = destinationTag(me.id);
    assert.deepEqual({ payTo: me.xrplPay.payTo, tag: me.xrplPay.destinationTag, price: me.xrplPay.priceUsdc, token: me.xrplPay.token }, { payTo: XRPL_PAY_TO, tag, price: 5, token: "RLUSD" });
    const claim = (txHash, tier) => c.call("POST", "/api/billing/claim", { txHash, chainId: "xrpl", ...(tier ? { tier } : {}) });

    // Refused: not a hash, not found, not validated, failed, another tag, another account, fake RLUSD, XRP, too little, too old, not a Payment.
    assert.equal((await claim("0xabc")).status, 400);
    assert.equal((await claim(randomBytes(32).toString("hex"))).status, 409);
    assert.equal((await claim(xpay(5, { tag, validated: false }))).status, 409);
    assert.equal((await claim(xpay(5, { tag, result: "tecPATH_DRY" }))).status, 400);
    assert.match((await claim(xpay(5, { tag: tag + 1 }))).body.message, new RegExp(`yours is ${tag}`));
    assert.equal((await claim(xpay(5, { tag, to: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" }))).status, 400);
    assert.equal((await claim(xpay(5, { tag, issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" }))).status, 400);
    assert.equal((await claim(xpay(5, { tag, drops: true }))).status, 400);
    assert.equal((await claim(xpay(4.99, { tag }))).status, 400);
    assert.equal((await claim(xpay(5, { tag, ageDays: 8 }))).status, 400);
    assert.equal((await claim(xpay(5, { tag, type: "CheckCreate" }))).status, 400);
    assert.equal((await c.call("GET", "/api/me")).body.plan, "free");

    // A real payment: Pro for a month, recorded as RLUSD on the XRP Ledger with the payer; once.
    const good = xpay(5, { tag });
    const paid = (await claim(good.toLowerCase())).body;
    assert.equal(paid.plan, "pro");
    assert.deepEqual({ chain: paid.payments[0].chain, tx: paid.payments[0].tx, months: paid.payments[0].months, from: paid.payments[0].from }, { chain: "xrpl", tx: good, months: 1, from: "rG589ewXmZfo9hQt6ntNaciUTpRurYF8gS" });
    assert.equal((await claim(good)).body.payments.length, 1);
    // The same payment can't be claimed by another account (its tag is different anyway, and the hash is used).
    const other = await signInAs(base, customer());
    assert.equal((await other.call("POST", "/api/billing/claim", { txHash: good, chainId: "xrpl" })).status, 400);
    // Pro 20 in RLUSD.
    const t20 = (await claim(xpay(9, { tag }), "pro20")).body;
    assert.equal(t20.tier, "pro20");
  } finally { server.close(); }
});

test("Xaman: sign in with OAuth2 + PKCE, the XRPL account is the identity; Pro in RLUSD, no Base billing", async () => {
  const { createHash } = await import("node:crypto");
  const XRPL_PAY_TO = "r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw", ALICE = "rG589ewXmZfo9hQt6ntNaciUTpRurYF8gS";
  const codes = new Map(); // code -> { challenge, sub }
  const xfetch = async (url, init = {}) => {
    if (url === "https://oauth2.xumm.app/token") {
      const f = new URLSearchParams(init.body);
      const c = codes.get(f.get("code"));
      const ok = c && f.get("client_id") === "app-key" && f.get("redirect_uri") === "https://wallet.test/api/signin/xaman/callback" && createHash("sha256").update(f.get("code_verifier")).digest("base64url") === c.challenge;
      return ok ? Response.json({ access_token: `jwt-${f.get("code")}`, token_type: "bearer" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url === "https://oauth2.xumm.app/userinfo") return Response.json({ sub: codes.get(init.headers.authorization.replace("Bearer jwt-", "")).sub, networkType: "MAINNET" });
    throw new Error(`unexpected ${url}`);
  };
  const { base, server } = await boot({ rpc: async (m) => (m === "tx" ? { error: "txnNotFound", status: "error" } : null), xaman: { apiKey: "app-key", fetch: xfetch }, xrpl: { payTo: XRPL_PAY_TO, rpcUrl: "https://xrpl.test" } });
  // Starts at Xaman with our key, our redirect and a PKCE challenge; returns with a code.
  const signIn = async (sub, { tamper = false } = {}) => {
    const start = await fetch(`${base}/api/signin/xaman?ref=fizzl.eu`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const u = new URL(start.headers.get("location"));
    assert.equal(u.origin + u.pathname, "https://oauth2.xumm.app/auth");
    assert.deepEqual([u.searchParams.get("client_id"), u.searchParams.get("redirect_uri"), u.searchParams.get("code_challenge_method"), u.searchParams.get("response_type")], ["app-key", "https://wallet.test/api/signin/xaman/callback", "S256", "code"]);
    const code = `c${codes.size}`;
    codes.set(code, { challenge: u.searchParams.get("code_challenge"), sub });
    return fetch(`${base}/api/signin/xaman/callback?code=${code}&state=${tamper ? "nope" : u.searchParams.get("state")}`, { redirect: "manual" });
  };
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).xaman, true);
    const back = await signIn(ALICE);
    assert.equal(back.status, 200);
    assert.match(await back.text(), /location\.replace\("\/"\)/);
    const cookie = back.headers.get("set-cookie").split(";")[0];
    const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const me = (await call("GET", "/api/me")).body;
    assert.deepEqual([me.id, me.address, me.chain, me.signedInWith, me.billing, me.auto], [`xrpl:${ALICE}`, ALICE, "xrpl", "xaman", null, null]);
    assert.equal(me.xrplPay.payTo, XRPL_PAY_TO);
    // A hash pasted without chainId goes to the XRPL check (here: not found yet).
    assert.equal((await call("POST", "/api/billing/claim", { txHash: "A".repeat(64) })).status, 409);
    // A state that wasn't issued here, or one used twice, doesn't sign in: back to the page with the reason.
    const bad = await signIn(ALICE, { tamper: true });
    assert.match(bad.headers.get("location"), /^\/\?signin_error=sign-in%20expired/);
    assert.equal(bad.headers.get("set-cookie"), null);
    // Xaman answering without an XRPL account: refused.
    assert.match((await signIn("not-an-address")).headers.get("location"), /signin_error=Xaman%20did%20not%20say/);
    // The user cancelled in Xaman.
    assert.match((await fetch(`${base}/api/signin/xaman/callback?error=access_denied`, { redirect: "manual" })).headers.get("location"), /signin_error=access_denied/);
  } finally { server.close(); }
});

test("Xaman: off without an API key", async () => {
  const { base, server } = await boot();
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).xaman, false);
    assert.equal((await fetch(`${base}/api/signin/xaman`, { redirect: "manual" })).status, 404);
  } finally { server.close(); }
});

test("RLUSD: off unless billing.xrpl is set", async () => {
  const { base, server } = await boot();
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).xrpl, false);
    const c = await signInAs(base, customer());
    assert.equal((await c.call("GET", "/api/me")).body.xrplPay, null);
    assert.equal((await c.call("POST", "/api/billing/claim", { txHash: "A".repeat(64), chainId: "xrpl" })).status, 503);
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
    assert.equal((await owner("GET", `/api/services/search?q=${encodeURIComponent("Wat is het weer de komende dagen?")}`)).body.results[0].host, "weather.example"); // plain Dutch works too
    assert.equal((await owner("GET", "/api/services/search?q=a")).body.results.length, 0);
    assert.equal(calls, 1); // the catalog is fetched once and kept
  } finally { server.close(); }
});

test("catalog: Fizzl's old onrender.com addresses are left out once the fizzl.eu address is listed", async () => {
  const { withoutMovedHosts } = await import("../src/catalog.js");
  const r = (u) => ({ resource: u });
  const out = withoutMovedHosts([
    r("https://x402-doctor.onrender.com/api/v1/preflight"), r("https://x402-doctor.fizzl.eu/api/v1/preflight"),
    r("https://presign-guard.onrender.com/v1/token"), // its fizzl.eu address isn't listed: kept
    r("https://smartcontractexplainer.onrender.com/api/explain"), r("https://plaintext.fizzl.eu/api/check-wallet"),
    r("https://other.onrender.com/x"), r("not a url"),
  ]).map((i) => i.resource);
  assert.deepEqual(out, ["https://x402-doctor.fizzl.eu/api/v1/preflight", "https://presign-guard.onrender.com/v1/token", "https://plaintext.fizzl.eu/api/check-wallet", "https://other.onrender.com/x", "not a url"]);
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
    assert.equal(r.by.balance.status, "warn"); // no USDC yet: a tip, it can still check its wallet and find services
    assert.match(r.by.balance.detail, /for free/);
    assert.match(r.by.balance.fix, /USDC on Base/);
    assert.equal(r.ready, true);
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

test("usage statistics: anonymous events in the usage-log repo; no addresses, keys, Telegram ids or what was bought", async () => {
  const { createUsage } = await import("../src/usage.js");
  const files = new Map(); // path -> text, a fake GitHub contents API
  const gh = async (url, init = {}) => {
    const path = new URL(url).pathname.split("/contents/")[1];
    if ((init.method ?? "GET") === "GET") return files.has(path) ? Response.json({ sha: "s", content: Buffer.from(files.get(path)).toString("base64") }) : new Response("", { status: 404 });
    files.set(path, Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8"));
    return Response.json({}, { status: 201 });
  };
  const alice = customer();
  const usage = createUsage({ token: "ghp_test", salt: "s3cret", fetch: gh, batchMs: 0, ownWallets: [alice.address] });
  const { createCatalog } = await import("../src/catalog.js");
  const catalog = createCatalog({ url: "https://catalog.test/d", fetch: async () => Response.json({ items: [{ resource: "https://shop.example/signal", description: "Crypto trend signal", accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000", payTo: PAY_TO }] }] }) });
  const { base, server, agentCall } = await boot({ usage, catalog });
  try {
    const bob = customer();
    const b = await signInAs(base, bob);
    await signInAs(base, bob); // a second sign-in
    const { body: { key } } = await b.call("POST", "/api/agents", { name: "bob-research" });
    await agentCall(key)("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(1), purchase: { url: "https://shop.example/signal?pair=SECRET", description: "Bob's private research note" } });
    await agentCall(key)("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(9) }); // over the limit: asked
    await b.call("GET", "/api/services/search?q=Crypto%20Signal&net=Base");
    await fetch(`${base}/api/public/services/search?q=weather`, { headers: { "user-agent": "python-requests/2.32" } });
    await fetch(`${base}/api/public/usage/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "connect", host: "shop.example", from: "search", demo: true }) });
    await fetch(`${base}/api/public/usage/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "anything", host: "<script>" }) });
    await b.call("POST", "/api/setup/check", {});
    await signInAs(base, alice);
    await fetch(`${base}/demo`);
    await usage.flush();

    const day = new Date().toISOString().slice(0, 10);
    const text = files.get(`events/wallet/${day}.jsonl`);
    const events = text.trim().split("\n").map((l) => JSON.parse(l));
    const by = (route) => events.filter((e) => e.route === route);
    assert.equal(by("signup").length, 2);
    assert.equal(by("signin").length, 1);
    assert.equal(by("agent_added")[0].result.agents, 1);
    const [ok, asked] = by("purchase");
    assert.deepEqual([ok.input.host, ok.usd, ok.result.outcome], ["shop.example", 1, "ok"]);
    assert.deepEqual([asked.input.host, asked.usd, asked.result.outcome], ["transfer", 9, "asked"]);
    const [mine, pub] = by("search");
    assert.deepEqual([mine.via, mine.input.q, mine.input.net, mine.result.total, mine.result.top], ["dashboard", "crypto signal", "Base", 1, "shop.example"]);
    assert.deepEqual([pub.via, pub.agent, pub.result.total], ["public", "python-requests/2.32", 0]);
    assert.deepEqual(by("click").map((e) => [e.via, e.input.kind, e.input.host]), [["demo", "connect", "shop.example"]]); // unknown kinds are not logged
    assert.deepEqual([by("setup_check")[0].result.fail, by("setup_check")[0].result.warn], ["none", "balance,telegram"]); // the agent reached the wallet; no address or Telegram yet
    assert.equal(by("page")[0].via, "demo");
    // The same account always has the same code; your own wallets are marked; nothing personal is in the log.
    assert.equal(new Set(by("purchase").map((e) => e.acct)).size, 1);
    assert.equal(by("purchase")[0].acct, by("signup")[0].acct);
    assert.match(by("signup")[0].acct, /^[0-9a-f]{12}$/);
    assert.equal(by("signup")[1].own, true);
    for (const secret of [bob.address.toLowerCase(), bob.address, alice.address.toLowerCase(), key, "bob-research", "SECRET", "private research"]) assert.ok(!text.includes(secret), `the log must not contain ${secret}`);
  } finally { server.close(); }
});

// A fake GitHub contents API over a Map of path -> text (directory listings with a sha per file).
function fakeGithub(files) {
  const reads = [];
  const sha = (t) => `sha${t.length}_${t.split("\n").length}`;
  const fetchImpl = async (url, init = {}) => {
    const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1]);
    if ((init.method ?? "GET") === "PUT") { files.set(path, Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8")); return Response.json({}, { status: 201 }); }
    reads.push(path);
    if (files.has(path)) return (init.headers?.accept ?? "").includes("raw") ? new Response(files.get(path)) : Response.json({ sha: sha(files.get(path)), content: Buffer.from(files.get(path)).toString("base64") });
    const dir = [...files.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => ({ name: k.slice(path.length + 1), sha: sha(files.get(k)) }));
    return dir.length ? Response.json(dir) : new Response("", { status: 404 });
  };
  return { fetchImpl, reads };
}

test("website counter, sign-up source and the owner's Stats tab: from website visits to Pro", async () => {
  const { createUsage } = await import("../src/usage.js");
  const { createStats } = await import("../src/stats.js");
  const files = new Map([["scripts/known.json", JSON.stringify({ own_wallets: ["0x6B0F4651eD42893ab58139938175E4a69f175F25"], monitor_agents: "bot|monitor", probe_pairs: [] })]]);
  const gh = fakeGithub(files);
  const usage = createUsage({ token: "t", salt: "s", fetch: gh.fetchImpl, batchMs: 0 });
  const stats = createStats({ token: "t", fetch: gh.fetchImpl, cacheMs: 0 });
  const { base, server, owner, agentCall } = await boot({ usage, stats });
  try {
    const site = (body, origin = "https://fizzl.eu", ua = "Mozilla/5.0 Chrome/120 Safari/537") => fetch(`${base}/api/public/usage/site`, { method: "POST", headers: { origin, "content-type": "text/plain", "user-agent": ua }, body: JSON.stringify(body) });
    const ok = await site({ kind: "view", path: "/" });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://fizzl.eu");
    await site({ kind: "view", path: "/tools" }, "https://ai.fizzl.eu");
    await site({ kind: "out", path: "/", to: "wallet.fizzl.eu" });
    await site({ kind: "view", path: "/" }, "https://evil.example"); // not a Fizzl site: not counted
    await site({ kind: "view", path: "/" }, "https://fizzl.eu", "Googlebot/2.1"); // a bot: logged, but left out of the stats
    const pre = await fetch(`${base}/api/public/usage/site`, { method: "OPTIONS", headers: { origin: "https://lab.fizzl.eu" } });
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://lab.fizzl.eu");
    assert.match(await (await fetch(`${base}/s.js`)).text(), /doNotTrack/);

    // A visitor comes from fizzl.eu, signs up, adds an agent and buys; another signs up directly.
    await fetch(`${base}/?ref=fizzl.eu`, { headers: { "user-agent": "Mozilla/5.0 Chrome/120 Safari/537" } });
    const a = await signInAs(base, customer(), { ref: "fizzl.eu" });
    const { body: { key } } = await a.call("POST", "/api/agents", { name: "a-bot" });
    await agentCall(key)("POST", "/v1/reserve", { method: "sendTransaction", request: txRequest(1), purchase: { url: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT" } });
    await signInAs(base, customer(), { ref: "https://phishing.example" }); // not a Fizzl site: no source
    await new Promise((r) => setTimeout(r, 30));
    await usage.flush();
    const day = new Date().toISOString().slice(0, 10);
    files.set(`events/presign/${day}.jsonl`, [
      { t: new Date().toISOString(), service: "presign", route: "check", paid: true, usd: 0.01, payer: "0xabc", visitor: "v1" },
      { t: new Date().toISOString(), service: "presign", route: "check", paid: true, usd: 0.01, payer: "0x6B0F4651eD42893ab58139938175E4a69f175F25" }, // your own wallet
      { t: new Date().toISOString(), service: "presign", route: "check", quote: true, visitor: "v2" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const walletLog = files.get(`events/wallet/${day}.jsonl`);
    assert.match(walletLog, /"route":"signup"[^\n]*"ref":"fizzl.eu"/);
    assert.match(walletLog, /"route":"agent_added"[^\n]*"ref":"fizzl.eu"/);
    assert.doesNotMatch(walletLog, /phishing/);
    assert.match(files.get(`events/site/${day}.jsonl`), /"site":"ai.fizzl.eu"/);
    assert.doesNotMatch(files.get(`events/site/${day}.jsonl`), /evil/);

    // Only the owner sees the stats.
    const c = await signInAs(base, customer());
    assert.equal((await c.call("GET", "/api/admin/stats")).status, 403);
    const s = (await owner("GET", "/api/admin/stats?days=7")).body;
    assert.equal(s.days, 7);
    assert.equal(s.dayKeys.at(-1), day);
    assert.deepEqual([s.kpi.siteViews, s.kpi.clicksToWallet, s.kpi.signups, s.kpi.agentsAdded, s.kpi.purchases, s.kpi.paidCalls, s.kpi.serviceUsd], [2, 1, 3, 1, 1, 1, 0.01]);
    assert.deepEqual(s.funnel.map(([, v]) => v), [2, 1, 1, 1, 1, 1, 0]);
    assert.equal(s.series.siteViews.at(-1), 2);
    assert.deepEqual(s.services.find((x) => x.id === "presign"), { id: "presign", name: "presign-guard", paid: 1, usd: 0.01, quotes: 1, payers: 1, visitors: 2 });
    assert.deepEqual(s.tables.hosts, [["ichimoku-signal.fizzl.eu", 1]]);
    assert.deepEqual(s.tables.sites, [["fizzl.eu", 1], ["ai.fizzl.eu", 1]]);
    // Unchanged days are not downloaded again.
    const before = gh.reads.filter((r) => r.endsWith(".jsonl")).length;
    await owner("GET", "/api/admin/stats?days=7");
    assert.equal(gh.reads.filter((r) => r.endsWith(".jsonl")).length, before);
  } finally { server.close(); }
});

test("weekly summary on Telegram: Monday from 9:00 Amsterdam time, once a week; on demand from the Stats tab", async () => {
  const { weekOf, formatDigest } = await import("../src/digest.js");
  // 5 Oct 2026 is a Monday; 08:30 in Amsterdam (UTC+2) is too early, 09:30 is due.
  assert.deepEqual(weekOf(Date.parse("2026-10-05T06:30:00Z")), { monday: "2026-10-05", due: false });
  assert.deepEqual(weekOf(Date.parse("2026-10-05T07:30:00Z")), { monday: "2026-10-05", due: true });
  assert.deepEqual(weekOf(Date.parse("2026-10-11T21:00:00Z")), { monday: "2026-10-05", due: true }); // Sunday evening: same week
  assert.equal(weekOf(Date.parse("2026-10-11T22:30:00Z")).monday, "2026-10-12"); // past midnight in Amsterdam

  const summary = { from: "2026-09-28", to: "2026-10-04",
    kpi: { siteViews: 120, clicksToWallet: 9, signups: 3, agentsAdded: 2, purchases: 4, spentUsd: 0.12, paidCalls: 7, serviceUsd: 0.31, pro: 1, proUsd: 5, withdrawals: 0, refundUsd: 0 },
    prev: { siteViews: 100, signups: 1, serviceUsd: 0.2, proUsd: 0, refundUsd: 0 },
    services: [{ name: "x402 Doctor", paid: 5, usd: 0.05, quotes: 40, payers: 2 }, { name: "Ichimoku Signal", paid: 2, usd: 0.26, quotes: 10, payers: 1 }],
    tables: { noResults: [["weather", 3]] } };
  const text = formatDigest({ summary, refunds: [{ refundUsdc: 4 }], dashboardUrl: "https://wallet.test" });
  assert.match(text, /Revenue: \$5\.31 \(\+5\.11 vs 0\.2\)/);
  assert.match(text, /Website visits: 120 \(\+20 vs 100\)/);
  assert.match(text, /3 sign-ups \(\+2 vs 1\)/);
  assert.match(text, /Ichimoku Signal 2 paid \/ 1 payer · x402 Doctor 5 paid/);
  assert.match(text, /"weather" \(3\)/);
  assert.match(text, /Refunds still to send: 1 \(\$4\.00\)/);
  assert.match(text, /https:\/\/wallet\.test\/#\/stats/);

  let t = Date.parse("2026-10-05T07:30:00Z");
  const stats = { enabled: true, summary: async () => summary };
  const { server, tg, accounts, owner } = await boot({ now: () => t, stats });
  try {
    const sent = () => tg.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === "4242" && /weekly summary/.test(c.body.text));
    assert.equal((await accounts.weeklyDigest({ summary })).sent, true);
    assert.equal((await accounts.weeklyDigest({ summary })).sent, false); // once a week
    t += 3 * 86_400_000;
    assert.equal((await accounts.weeklyDigest({ summary })).sent, false);
    t += 5 * 86_400_000; // the next Monday
    assert.equal((await accounts.weeklyDigest({ summary })).sent, true);
    assert.equal(sent().length, 2);
    // On demand (Stats tab): owner only, always sends.
    assert.equal((await owner("POST", "/api/admin/digest", {})).status, 200);
    assert.equal(sent().length, 3);
  } finally { server.close(); }
});

test("agent wallet made in the browser (public/agentkey.js): matches viem's address for random keys, served as JS", async () => {
  const { newAgentKey, addressOf, keccak256 } = await import("../public/agentkey.js");
  const { privateKeyToAddress } = await import("viem/accounts");
  const { keccak256: viemKeccak, toHex } = await import("viem");
  assert.equal(addressOf("0x" + "1".padStart(64, "0")), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  for (let i = 0; i < 12; i++) {
    const k = newAgentKey();
    assert.match(k.privateKey, /^0x[0-9a-f]{64}$/);
    assert.equal(k.address, privateKeyToAddress(k.privateKey));
  }
  for (const n of [0, 135, 136, 137, 500]) { const b = new Uint8Array(n).map((_, i) => i * 7); assert.equal(toHex(keccak256(b)), viemKeccak(b)); }
  assert.throws(() => addressOf("0x0"), /not a valid/);
  const { base, server } = await boot();
  try {
    const r = await fetch(`${base}/agentkey.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /javascript/);
    assert.match(await r.text(), /export function newAgentKey/);
  } finally { server.close(); }
});

test("endpoint monitor: an x402 endpoint must answer 402 with payment options; public https only", async () => {
  const { createEndpointMonitor, urlProblem } = await import("../src/monitor.js");
  assert.equal(urlProblem("http://api.example.com/x"), "Use an https:// address.");
  assert.match(urlProblem("https://127.0.0.1/x"), /public/);
  assert.match(urlProblem("https://api.example.com:8443/x"), /public/);
  assert.match(urlProblem("https://router.local/x"), /public/);
  assert.equal(urlProblem("https://api.example.com/paid"), null);
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ network: "eip155:8453" }, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] })).toString("base64");
  const answers = {
    "https://good.example/paid": () => new Response("{}", { status: 402, headers: { "payment-required": challenge } }),
    "https://body.example/paid": () => new Response(JSON.stringify({ x402Version: 1, accepts: [{ network: "base" }] }), { status: 402 }),
    "https://free.example/paid": () => new Response("hi", { status: 200 }),
    "https://empty.example/paid": () => new Response("{}", { status: 402 }),
    "https://broken.example/paid": () => new Response("oops", { status: 502 }),
    "https://post.example/paid": (init) => (init.method === "POST" ? new Response("{}", { status: 402, headers: { "payment-required": challenge } }) : new Response("use POST", { status: 405 })),
  };
  const lookup = async (h) => (h === "private.example" ? [{ address: "10.0.0.5" }] : h === "nowhere.example" ? [] : [{ address: "93.184.216.34" }]);
  const m = createEndpointMonitor({ fetch: async (url, init) => answers[url](init), lookup });
  const good = await m.check("https://good.example/paid");
  assert.equal(good.state, "ok");
  assert.deepEqual(good.networks, ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.equal((await m.check("https://body.example/paid")).state, "ok");
  assert.match((await m.check("https://free.example/paid")).note, /200 instead of 402: it answers without asking for payment/);
  assert.match((await m.check("https://empty.example/paid")).note, /without an x402 challenge/);
  assert.match((await m.check("https://broken.example/paid")).note, /server has an error/);
  assert.match((await m.check("https://private.example/paid")).note, /private network/);
  assert.match((await m.check("https://nowhere.example/paid")).note, /doesn't resolve/);
  // The seller picked GET, but only POST asks for payment: that works, and says so.
  const post = await m.check("https://post.example/paid", "GET");
  assert.equal(post.state, "ok");
  assert.equal(post.method, "POST");
  assert.match(post.note, /on POST \(not GET\)\.$/);
  assert.equal((await m.check("https://free.example/paid", "GET")).method, "GET"); // neither works: the chosen one is reported
});

test("endpoint monitor in the account: a wrong method is switched to the one that asks for payment", async () => {
  const endpointMonitor = { check: async (_url, method) => ({ state: "ok", status: 402, ms: 50, note: method === "GET" ? "Asks for payment correctly, on POST (not GET)." : "Asks for payment correctly.", method: "POST" }) };
  const { base, server } = await boot({ endpointMonitor });
  try {
    const a = await signInAs(base, customer());
    const r = (await a.call("POST", "/api/monitors", { url: "https://shop.example/paid", method: "GET" })).body;
    assert.equal(r.monitors[0].method, "POST");
    assert.equal(r.monitors[0].switchedFrom, "GET");
    assert.equal((await a.call("POST", "/api/monitors", { url: "https://shop.example/paid", method: "GET" })).status, 409); // same endpoint
  } finally { server.close(); }
});

test("monitor alerts to a webhook: Discord, Slack or JSON; public https only; the URL is never shown back", async () => {
  const { createAlertHook, hookKind } = await import("../src/monitor.js");
  assert.equal(hookKind("https://discord.com/api/webhooks/1/abc"), "discord");
  assert.equal(hookKind("https://hooks.slack.com/services/T/B/x"), "slack");
  assert.equal(hookKind("https://example.com/hook"), "webhook");
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), redirect: init.redirect }); return new Response(null, { status: url.includes("broken") ? 500 : 204 }); };
  const hook = createAlertHook({ fetch, lookup: async (h) => [{ address: h.startsWith("internal") ? "10.0.0.5" : "93.184.216.34" }] });
  await hook.send("https://discord.com/api/webhooks/1/abc", "hi", { type: "test" });
  await hook.send("https://hooks.slack.com/services/T/B/x", "hi", { type: "test" });
  await hook.send("https://example.com/hook", "hi", { type: "down", url: "https://shop.example/paid" });
  assert.deepEqual(sent.map((x) => x.body), [{ content: "hi", allowed_mentions: { parse: [] } }, { text: "hi" }, { text: "hi", event: { type: "down", url: "https://shop.example/paid" } }]);
  assert.ok(sent.every((x) => x.redirect === "manual"));
  await assert.rejects(hook.send("http://example.com/hook", "hi"), /https/);
  await assert.rejects(hook.send("https://internal.example.com/hook", "hi"), /private network/);
  await assert.rejects(hook.send("https://broken.example.com/hook", "hi"), /HTTP 500/);

  // In the account: set, test, alerts go there too, remove.
  let t = Date.now(), up = true;
  const endpointMonitor = { check: async () => (up ? { state: "ok", status: 402, ms: 80, note: "Asks for payment correctly." } : { state: "down", status: 502, ms: 40, note: "Answers HTTP 502 instead of 402." }) };
  const hooked = [];
  const alertHook = { send: async (url, text, event) => { hooked.push({ url, text, event }); return { kind: "discord" }; } };
  const { base, server, accounts } = await boot({ now: () => t, endpointMonitor, alertHook });
  try {
    const a = await signInAs(base, customer());
    assert.equal((await a.call("POST", "/api/monitors/alert-hook/test", {})).status, 404);
    assert.equal((await a.call("PUT", "/api/monitors/alert-hook", { url: "http://discord.com/api/webhooks/1/secret" })).status, 400);
    const set = await a.call("PUT", "/api/monitors/alert-hook", { url: "https://discord.com/api/webhooks/1/secret" });
    assert.deepEqual(set.body.hook, { kind: "discord", host: "discord.com" });
    assert.doesNotMatch(JSON.stringify((await a.call("GET", "/api/monitors")).body), /secret/);
    assert.equal((await a.call("POST", "/api/monitors/alert-hook/test", {})).status, 200);
    assert.equal(hooked.at(-1).event.type, "test");
    await a.call("POST", "/api/monitors", { url: "https://shop.example/paid" });
    up = false;
    t += 61 * 60_000; await accounts.checkMonitors();
    t += 61 * 60_000; await accounts.checkMonitors();
    assert.deepEqual({ ...hooked.at(-1).event, at: 0 }, { type: "down", url: "https://shop.example/paid", method: "GET", note: "Answers HTTP 502 instead of 402.", status: 502, at: 0 });
    assert.match(hooked.at(-1).text, /stopped working for paying agents/);
    assert.equal(hooked.at(-1).url, "https://discord.com/api/webhooks/1/secret");
    up = true; t += 61 * 60_000; await accounts.checkMonitors();
    assert.equal(hooked.at(-1).event.type, "up");
    assert.equal((await a.call("PUT", "/api/monitors/alert-hook", { url: "" })).body.hook, null);
  } finally { server.close(); }
});

test("endpoint monitor in the account: free watches 1, an alert after two failed checks, and one when it's back", async () => {
  let t = Date.now(), up = true;
  const endpointMonitor = { check: async (url) => (url.includes("other") || up ? { state: "ok", status: 402, ms: 80, note: "Asks for payment correctly (eip155:8453).", networks: ["eip155:8453"] } : { state: "down", status: 502, ms: 40, note: "Answers HTTP 502 instead of 402: the server has an error." }) };
  const { base, server, tg, accounts } = await boot({ now: () => t, endpointMonitor });
  try {
    const alice = customer();
    const a = await signInAs(base, alice);
    const code = (await a.call("POST", "/api/telegram/link", {})).body.url.split("start=")[1];
    await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret-hook" }, body: JSON.stringify({ message: { text: `/start ${code}`, chat: { id: 777, type: "private" }, from: { id: 777 } } }) });
    assert.equal((await a.call("POST", "/api/monitors", { url: "http://insecure.example/x" })).status, 400);
    const added = await a.call("POST", "/api/monitors", { url: "https://shop.example/paid" });
    assert.equal(added.status, 200);
    assert.equal(added.body.max, 1);
    assert.equal(added.body.monitors[0].last.state, "ok");
    assert.equal((await a.call("POST", "/api/monitors", { url: "https://shop.example/paid" })).status, 409);
    const second = await a.call("POST", "/api/monitors", { url: "https://other.example/paid" });
    assert.equal(second.status, 403); // free: 1
    assert.match(second.body.message, /Pro watches up to 10/);

    const alerts = () => tg.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === "777").map((c) => c.body.text);
    up = false;
    t += 61 * 60_000; assert.equal(await accounts.checkMonitors(), 1);
    assert.equal(alerts().length, 0); // one failure: no alert yet
    t += 61 * 60_000; await accounts.checkMonitors();
    assert.match(alerts().at(-1), /stopped working for paying agents:\nGET https:\/\/shop\.example\/paid\nAnswers HTTP 502/);
    t += 61 * 60_000; await accounts.checkMonitors();
    assert.equal(alerts().length, 1); // still down: no repeat
    up = true;
    t += 61 * 60_000; await accounts.checkMonitors();
    assert.match(alerts().at(-1), /works again/);
    t += 10 * 60_000; assert.equal(await accounts.checkMonitors(), 0); // checked within the hour already
    const list = (await a.call("GET", "/api/monitors")).body;
    assert.equal(list.telegram, true);
    assert.equal(list.monitors[0].last.state, "ok");
    const id = list.monitors[0].id;
    assert.equal((await a.call("POST", `/api/monitors/${id}/check`, {})).status, 200);
    assert.deepEqual((await a.call("DELETE", `/api/monitors/${id}`)).body.monitors, []);
  } finally { server.close(); }
});

// A browser's push subscription, with real keys, so the message can be encrypted for it.
function fakeDevice(endpoint = `https://push.example/send/${randomBytes(6).toString("hex")}`) {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  return { endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

test("web push: RFC 8291 encryption, a VAPID token the push service can check, expired devices reported as gone", async () => {
  // The example from RFC 8291, appendix A.
  const as = createECDH("prime256v1"); as.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const out = encrypt({ keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } }, "When I grow up, I want to be a watermelon", { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverKey: as });
  assert.equal(out.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");

  const calls = [];
  let status = 201;
  const push = createPush({ seed: "a session secret of some length", subject: "https://wallet.test", fetch: async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); } });
  assert.equal(createPush({ seed: "a session secret of some length", subject: "x" }).publicKey, push.publicKey, "the same secret gives the same key, so devices keep working after a restart");
  assert.notEqual(createPush({ seed: "another secret", subject: "x" }).publicKey, push.publicKey);
  const device = fakeDevice("https://web.push.apple.com/QAbc");
  assert.equal(await push.send(device, { title: "t", body: "b" }), "ok");
  const { url, init } = calls[0];
  assert.equal(url, device.endpoint);
  assert.equal(init.headers["content-encoding"], "aes128gcm");
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.authorization);
  assert.equal(k, push.publicKey);
  const [h, c, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "https://wallet.test");
  const pub = Buffer.from(push.publicKey, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), "the push service can check who sent it");
  status = 410;
  assert.equal(await push.send(device, { title: "t" }), "gone");
  status = 500;
  await assert.rejects(push.send(device, { title: "t" }), /500/);
  assert.throws(() => cleanSubscription({ endpoint: "http://push.example/x", keys: device.keys }), /isn't a push subscription/);
  assert.throws(() => cleanSubscription({ endpoint: device.endpoint, keys: { p256dh: "abc", auth: device.keys.auth } }), /isn't a push subscription/);
});

test("notifications on the phone: turn on per device, approvals arrive with the approval id, devices that expired are forgotten", async () => {
  const sent = [], gone = new Set();
  const push = { publicKey: "BPUBLIC", send: async (sub, message) => { sent.push({ endpoint: sub.endpoint, message }); return gone.has(sub.endpoint) ? "gone" : "ok"; } };
  const { owner, agent, base, server } = await boot({ push });
  try {
    assert.deepEqual((await owner("GET", "/api/push")).body, { enabled: true, key: "BPUBLIC", devices: [] });
    assert.equal((await owner("POST", "/api/push/subscribe", { subscription: { endpoint: "http://insecure.example/x", keys: {} } })).status, 400);
    const phone = fakeDevice();
    const r = await owner("POST", "/api/push/subscribe", { subscription: phone, label: "iPhone · app<script>" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.devices.map((d) => [d.endpoint, d.label]), [[phone.endpoint, "iPhone · appscript"]]);
    // Over the limit: the phone gets the approval, with its id (Approve / Deny on Android, a tap opens the dashboard).
    const req = txRequest(8);
    assert.equal((await agent("POST", "/v1/reserve", { method: "sendTransaction", request: req, verdict: await signedVerdict(req) })).body.status, "pending");
    await new Promise((ok) => setTimeout(ok, 20));
    const ask = sent.find((x) => x.message.approval);
    assert.match(ask.message.title, /research-agent asks for your OK/);
    assert.match(ask.message.body, /8 USDC is over the limit/);
    assert.equal(ask.message.url, "/#/overview");
    const pending = (await owner("GET", "/api/state")).body.approvals.find((a) => a.status === "pending");
    assert.equal(ask.message.approval, pending.id);
    // A test, then the device unsubscribes at the push service: it's forgotten.
    assert.equal((await owner("POST", "/api/push/test", {})).body.devices, 1);
    gone.add(phone.endpoint);
    assert.equal((await owner("POST", "/api/push/test", {})).status, 404);
    assert.deepEqual((await owner("GET", "/api/push")).body.devices, []);
    // Turning it off on a device.
    gone.clear();
    await owner("POST", "/api/push/subscribe", { subscription: phone });
    assert.deepEqual((await owner("POST", "/api/push/unsubscribe", { endpoint: phone.endpoint })).body.devices, []);
    // The app parts: manifest, service worker, icons.
    const m = await fetch(`${base}/manifest.webmanifest`);
    assert.match(m.headers.get("content-type"), /application\/manifest\+json/);
    assert.equal((await m.json()).display, "standalone");
    const sw = await fetch(`${base}/sw.js`);
    assert.match(sw.headers.get("content-type"), /javascript/);
    assert.equal(sw.headers.get("cache-control"), "no-cache");
    assert.match(await sw.text(), /showNotification/);
    for (const icon of ["/app/icon-192.png", "/app/icon-512.png", "/app/maskable-512.png", "/apple-touch-icon.png"]) assert.equal((await fetch(base + icon)).status, 200, icon);
    assert.match(await (await fetch(`${base}/`)).text(), /<link rel="manifest" href="\/manifest.webmanifest">/);
  } finally { server.close(); }
});

test("notifications: off when the server has no push key", async () => {
  const { owner, server } = await boot();
  try {
    assert.equal((await owner("GET", "/api/push")).body.enabled, false);
    assert.equal((await owner("POST", "/api/push/subscribe", { subscription: fakeDevice() })).status, 503);
  } finally { server.close(); }
});

test("signing in the installed app: a code confirmed where you're signed in; the app polls with its secret token, once", async () => {
  const { owner, base, server } = await boot();
  try {
    const post = async (path, body, cookie) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie") }; };
    const d = (await post("/api/device/start", { label: "iPhone · app" })).body;
    assert.match(d.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(d.expiresIn, 600);
    assert.deepEqual((await post("/api/device/poll", { token: d.token })).body, { ok: false }, "nothing until it's confirmed");
    assert.equal((await post("/api/device/approve", { code: d.code })).status, 401, "confirming needs a signed-in session");
    assert.equal((await owner("POST", "/api/device/approve", { code: "WXYZ-2345" })).status, 404);
    const ok = await owner("POST", "/api/device/approve", { code: d.code.toLowerCase().replace("-", " ") });
    assert.deepEqual(ok.body, { ok: true, label: "iPhone · app" });
    assert.equal((await owner("POST", "/api/device/approve", { code: d.code })).status, 404, "a code works once");
    assert.deepEqual((await post("/api/device/poll", { token: "wrong-token-of-some-length" })).body, { ok: false });
    const got = await post("/api/device/poll", { token: d.token });
    assert.equal(got.body.ok, true);
    const cookie = got.cookie.split(";")[0];
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal((await me.json()).id, "admin", "the app is signed in to the account that confirmed");
    assert.deepEqual((await post("/api/device/poll", { token: d.token })).body, { ok: false }, "and only once");
  } finally { server.close(); }
});

// A mailer that keeps what it would send; the code is the first 6 digits in the text.
function fakeMailer() {
  const sent = [];
  return { sent, send: async (to, subject, text) => { sent.push({ to, subject, text }); }, last: () => /\b(\d{6})\b/.exec(sent.at(-1).text)[1] };
}
const jpost = async (base, path, body, cookie) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
const asCookie = (base, cookie) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("e-mail: sign in with a mailed 6-digit code; only a fingerprint and a hint are kept; wrong codes run out", async () => {
  const mail = fakeMailer();
  const { base, server, store } = await boot({ mailer: mail });
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).email, true);
    assert.equal((await jpost(base, "/api/signin/email", { email: "not an address" })).status, 400);
    assert.deepEqual((await jpost(base, "/api/signin/email", { email: " Frits@Example.COM " })).body, { ok: true, expiresIn: 600 });
    assert.equal(mail.sent[0].to, "frits@example.com");
    assert.match(mail.sent[0].subject, /^\d{6} is your Fizzl wallet code$/);
    const code = mail.last();
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal((await jpost(base, "/api/signin/email/code", { email: "frits@example.com", code: wrong })).status, 401);
    const ok = await jpost(base, "/api/signin/email/code", { email: "FRITS@example.com", code });
    assert.equal(ok.status, 200);
    const call = asCookie(base, ok.cookie);
    const me = (await call("GET", "/api/me")).body;
    assert.match(me.id, /^em:[0-9a-f]{40}$/);
    assert.equal(me.signedInWith, "email");
    assert.equal(me.email, "f…@example.com");
    assert.equal(me.needsWallet, true);
    assert.equal(me.billing, null);
    assert.equal(me.plan, "free");
    assert.ok(!JSON.stringify(await store.global.listAccounts()).includes("frits@example.com"), "the address itself is never stored");
    assert.equal((await jpost(base, "/api/signin/email/code", { email: "frits@example.com", code })).status, 401, "a code works once");
    // Agents work the same on an e-mail account.
    assert.equal((await call("POST", "/api/agents", { name: "mail-agent" })).status, 200);
    assert.equal((await call("POST", "/api/billing/claim", { txHash: `0x${"a".repeat(64)}` })).status, 400, "no wallet to pay from yet");
    // Five wrong codes and it's gone.
    await jpost(base, "/api/signin/email", { email: "frits@example.com" });
    const c2 = mail.last(), bad = c2 === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await jpost(base, "/api/signin/email/code", { email: "frits@example.com", code: bad });
    assert.equal((await jpost(base, "/api/signin/email/code", { email: "frits@example.com", code: c2 })).status, 401);
    // At most 5 codes an hour to one address.
    for (let i = 0; i < 3; i++) await jpost(base, "/api/signin/email", { email: "frits@example.com" });
    assert.equal((await jpost(base, "/api/signin/email", { email: "frits@example.com" })).status, 429);
  } finally { server.close(); }
});

test("e-mail and wallet on one account: add e-mail to a wallet account, or connect the paying wallet to an e-mail account", async () => {
  const mail = fakeMailer();
  const { base, server } = await boot({ mailer: mail });
  try {
    // A wallet account adds an e-mail: either signs in to the same account.
    const alice = customer();
    const a = await signInAs(base, alice);
    assert.equal((await a.call("POST", "/api/account/email", { email: "alice@example.com" })).status, 200);
    const linked = await a.call("POST", "/api/account/email/code", { email: "alice@example.com", code: mail.last() });
    assert.equal(linked.body.email, "a…@example.com");
    await jpost(base, "/api/signin/email", { email: "alice@example.com" });
    const viaMail = await jpost(base, "/api/signin/email/code", { email: "alice@example.com", code: mail.last() });
    assert.equal((await asCookie(base, viaMail.cookie)("GET", "/api/me")).body.id, alice.address.toLowerCase());
    // Another account can't take that e-mail.
    const bob = customer();
    const b = await signInAs(base, bob);
    assert.equal((await b.call("POST", "/api/account/email", { email: "alice@example.com" })).status, 409);
    // Removing it: the e-mail then makes a new account of its own.
    assert.equal((await a.call("POST", "/api/account/email/remove", {})).body.email, null);
    await jpost(base, "/api/signin/email", { email: "alice@example.com" });
    const own = await jpost(base, "/api/signin/email/code", { email: "alice@example.com", code: mail.last() });
    assert.match((await asCookie(base, own.cookie)("GET", "/api/me")).body.id, /^em:/);

    // An e-mail account connects the wallet it pays from; then that wallet signs in to it too.
    await jpost(base, "/api/signin/email", { email: "carol@example.com" });
    const c = asCookie(base, (await jpost(base, "/api/signin/email/code", { email: "carol@example.com", code: mail.last() })).cookie);
    const carolWallet = customer();
    assert.equal((await c("POST", "/api/account/wallet/message", { address: bob.address })).status, 200);
    const mb = (await c("POST", "/api/account/wallet/message", { address: bob.address })).body;
    assert.equal((await c("POST", "/api/account/wallet", { nonce: mb.nonce, signature: await bob.signMessage({ message: mb.message }) })).status, 409, "a wallet with its own account can't be taken");
    const m = (await c("POST", "/api/account/wallet/message", { address: carolWallet.address })).body;
    const after = (await c("POST", "/api/account/wallet", { nonce: m.nonce, signature: await carolWallet.signMessage({ message: m.message }) })).body;
    assert.equal(after.address, carolWallet.address);
    assert.equal(after.needsWallet, false);
    assert.equal(after.billing.payTo, PAY_TO);
    const cw = await signInAs(base, carolWallet);
    assert.match((await cw.call("GET", "/api/me")).body.id, /^em:/, "the paying wallet signs in to the e-mail account");
    // Deleting the account frees both the e-mail and the wallet.
    assert.equal((await c("POST", "/api/account/delete", { confirm: "delete" })).status, 200);
    assert.equal((await (await signInAs(base, carolWallet)).call("GET", "/api/me")).body.id, carolWallet.address.toLowerCase());
  } finally { server.close(); }
});

test("e-mail: off without a mail service", async () => {
  const { base, server } = await boot();
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).email, false);
    assert.equal((await jpost(base, "/api/signin/email", { email: "a@example.com" })).status, 503);
  } finally { server.close(); }
});

test("e-mail: when the mail service refuses (domain not verified), the reason is shown, not 'something went wrong'", async () => {
  const { createMailer } = await import("../src/mail.js");
  const mailer = createMailer({ apiKey: "re_test", fetch: async () => Response.json({ statusCode: 403, message: "The fizzl.eu domain is not verified." }, { status: 403 }) });
  const { base, server } = await boot({ mailer });
  try {
    const r = await jpost(base, "/api/signin/email", { email: "a@example.com" });
    assert.equal(r.status, 502);
    assert.match(r.body.message, /refused it \(The fizzl\.eu domain is not verified\.\)/);
  } finally { server.close(); }
});

// A software authenticator: makes a P-256 passkey and signs like Face ID would.
function softPasskey() {
  const { createHash, generateKeyPairSync, sign: nodeSign, randomBytes: rb } = require_crypto();
  const enc = (v) => {
    const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
    if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
    if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
    throw new Error("enc");
  };
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = rb(16);
  let counter = 0;
  const sha = (d) => createHash("sha256").update(d).digest();
  const authData = (rpId, withKey) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const base = Buffer.concat([sha(rpId), Buffer.from([withKey ? 0x45 : 0x05]), c]);
    if (!withKey) return base;
    const cose = enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
    return Buffer.concat([base, Buffer.alloc(16), len, credId, cose]);
  };
  const b = (x) => Buffer.from(x).toString("base64url");
  let userHandle = null;
  return {
    id: b(credId),
    create(o, origin) {
      userHandle = o.user.id;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin }));
      const attestationObject = enc(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(o.rp.id, true)]]));
      return { clientDataJSON: b(clientDataJSON), attestationObject: b(attestationObject) };
    },
    get(o, origin, { userVerified = true } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin }));
      const ad = authData(o.rpId, false);
      if (!userVerified) ad[32] = 0x01;
      const signature = nodeSign("sha256", Buffer.concat([ad, sha(clientDataJSON)]), privateKey);
      return { id: b(credId), clientDataJSON: b(clientDataJSON), authenticatorData: b(ad), signature: b(signature), userHandle };
    },
  };
}
import * as nodeCrypto from "node:crypto";
const require_crypto = () => nodeCrypto;

test("passkeys: add Face ID while signed in, then sign in with it alone; checked site, user check and challenge", async () => {
  const { base, server, owner } = await boot();
  try {
    const origin = base, key = softPasskey();
    // Add it (signed in as the owner here).
    const o = (await owner("POST", "/api/passkey/new", {})).body;
    assert.equal(o.rp.id, "127.0.0.1");
    assert.equal(Buffer.from(o.user.id, "base64url").toString(), "admin");
    assert.equal(o.authenticatorSelection.userVerification, "required");
    const fromElsewhere = await owner("POST", "/api/passkey/add", { answer: key.create(o, "https://evil.example"), label: "iPhone · app" });
    assert.equal(fromElsewhere.status, 401, "an answer made for another site is refused");
    const o2 = (await owner("POST", "/api/passkey/new", {})).body;
    const added = await owner("POST", "/api/passkey/add", { answer: key.create(o2, origin), label: "iPhone · app" });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.passkeys.map((k) => k.label), ["iPhone · app"]);
    assert.equal((await owner("POST", "/api/passkey/add", { answer: key.create(o2, origin) })).status, 401, "a registration challenge works once");

    // Sign in with nothing but the passkey.
    const lo = await jpost(base, "/api/passkey/options", {});
    const signed = await jpost(base, "/api/passkey/signin", key.get(lo.body, origin));
    assert.equal(signed.status, 200);
    assert.equal((await asCookie(base, signed.cookie)("GET", "/api/me")).body.id, "admin");
    assert.equal((await jpost(base, "/api/passkey/signin", key.get(lo.body, origin))).status, 401, "a sign-in challenge works once");
    // Without Face ID / fingerprint (user not verified): refused.
    const lo2 = await jpost(base, "/api/passkey/options", {});
    const noUv = await jpost(base, "/api/passkey/signin", key.get(lo2.body, origin, { userVerified: false }));
    assert.equal(noUv.status, 401);
    assert.match(noUv.body.message, /didn't check your face/);
    // A forged signature: refused.
    const lo3 = await jpost(base, "/api/passkey/options", {});
    const forged = { ...key.get(lo3.body, origin), signature: softPasskey().get(lo3.body, origin).signature };
    assert.equal((await jpost(base, "/api/passkey/signin", forged)).status, 401);
    // Removed: it no longer signs in.
    assert.deepEqual((await owner("POST", "/api/passkey/remove", { id: key.id })).body.passkeys, []);
    const lo4 = await jpost(base, "/api/passkey/options", {});
    assert.equal((await jpost(base, "/api/passkey/signin", key.get(lo4.body, origin))).status, 401);
  } finally { server.close(); }
});

test("tester codes: the owner makes a code for N testers; each account gets the days of Pro once; feedback reaches the owner's Telegram", async () => {
  const { base, server, owner, tg } = await boot();
  try {
    assert.equal((await owner("POST", "/api/admin/promos", { days: 0, uses: 5 })).status, 400);
    const made = (await owner("POST", "/api/admin/promos", { days: 30, uses: 2, note: "Bob · Reddit <b>" })).body.promos[0];
    assert.equal(made.note, "Bob · Reddit b");
    assert.match(made.code, /^TEST-[A-Z2-9]{6}$/);
    const alice = await signInAs(base, customer());
    assert.equal((await alice.call("GET", "/api/me")).body.plan, "free");
    assert.equal((await alice.call("POST", "/api/promo", { code: "TEST-NOPE22" })).status, 404);
    const me = (await alice.call("POST", "/api/promo", { code: made.code.toLowerCase() })).body;
    assert.equal(me.plan, "pro");
    assert.equal(me.promo.days, 30);
    assert.ok(me.proUntil > Date.now() + 29 * 86_400_000);
    assert.equal((await alice.call("POST", "/api/promo", { code: made.code })).status, 409, "one code per account");
    assert.ok(tg.calls.some((c) => c.method === "sendMessage" && /Tester code TEST-\w+ \(Bob · Reddit b\) redeemed: 30 days/.test(c.body.text)));
    const bob = await signInAs(base, customer());
    assert.equal((await bob.call("POST", "/api/promo", { code: made.code })).status, 200);
    const carol = await signInAs(base, customer());
    assert.equal((await carol.call("POST", "/api/promo", { code: made.code })).status, 410, "used up after 2");
    assert.equal((await owner("GET", "/api/admin/promos")).body.promos[0].used, 2);
    assert.equal((await alice.call("GET", "/api/admin/promos")).status, 403, "only the owner sees codes");
    // Stopped codes don't work.
    const second = (await owner("POST", "/api/admin/promos", { days: 7, uses: 10 })).body.promos[0];
    await owner("POST", `/api/admin/promos/${second.code}/stop`, {});
    assert.equal((await carol.call("POST", "/api/promo", { code: second.code })).status, 404);

    // Feedback goes to the owner's Telegram.
    assert.equal((await alice.call("POST", "/api/feedback", { text: "hi" })).status, 400);
    assert.equal((await alice.call("POST", "/api/feedback", { text: "The Face ID button confused me" })).status, 200);
    assert.ok(tg.calls.some((c) => c.method === "sendMessage" && c.body.chat_id === "4242" && /Feedback from 0x.*\(pro\):\n\nThe Face ID button confused me/.test(c.body.text)));
    for (let i = 0; i < 4; i++) await alice.call("POST", "/api/feedback", { text: `more feedback ${i}` });
    assert.equal((await alice.call("POST", "/api/feedback", { text: "one too many" })).status, 429);
  } finally { server.close(); }
});

test("usage statistics: an XRPL (Xaman) account in USAGE_OWN_WALLETS is marked own", async () => {
  const { createUsage } = await import("../src/usage.js");
  const files = new Map();
  const gh = async (url, init = {}) => {
    const path = new URL(url).pathname.split("/contents/")[1];
    if ((init.method ?? "GET") === "GET") return files.has(path) ? Response.json({ sha: "s", content: Buffer.from(files.get(path)).toString("base64") }) : new Response("", { status: 404 });
    files.set(path, Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8"));
    return Response.json({}, { status: 201 });
  };
  const usage = createUsage({ token: "ghp_test", salt: "s3cret", fetch: gh, batchMs: 0, ownWallets: ["r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw"] });
  usage.record("signup", { account: "xrpl:r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw", input: { chain: "xrpl" } });
  usage.record("signup", { account: "xrpl:rG589ewXmZfo9hQt6ntNaciUTpRurYF8gS", input: { chain: "xrpl" } });
  await usage.flush?.();
  for (let i = 0; i < 50 && ![...files.values()].join("").includes("rG5") && [...files.values()].join("").split("\n").filter(Boolean).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  const events = [...files.values()].join("\n").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.route, e.own ?? false]), [["signup", true], ["signup", false]]);
  assert.ok(!JSON.stringify(events).includes("r9xm"), "no address in the log");
});

test("e-mail: a welcome e-mail with the first steps after the first sign-in, only once", async () => {
  const mail = fakeMailer();
  const { base, server } = await boot({ mailer: mail });
  try {
    const signIn = async () => {
      await jpost(base, "/api/signin/email", { email: "new@example.com" });
      return jpost(base, "/api/signin/email/code", { email: "new@example.com", code: mail.last() });
    };
    assert.equal((await signIn()).status, 200);
    const welcomes = () => mail.sent.filter((m) => /^Welcome to the Fizzl Agent Wallet/.test(m.subject));
    assert.equal(welcomes().length, 1);
    assert.equal(welcomes()[0].to, "new@example.com");
    assert.match(welcomes()[0].text, /npx -y presign-guard-wallet-mcp/);
    assert.match(welcomes()[0].text, /Test my setup/);
    assert.ok(!/\b\d{6}\b/.test(welcomes()[0].text), "no 6-digit number that could look like a code");
    assert.equal((await signIn()).status, 200);
    assert.equal(welcomes().length, 1, "not again on the next sign-in");
  } finally { server.close(); }
});

test("sign-up source: fizzl.eu sites and a few fixed sources (a README link), nothing else", async () => {
  const { fizzlSite } = await import("../src/usage.js");
  assert.equal(fizzlSite("fizzl.eu"), "fizzl.eu");
  assert.equal(fizzlSite("lab.fizzl.eu"), "lab.fizzl.eu");
  assert.equal(fizzlSite("README"), "readme");
  assert.equal(fizzlSite("npm"), "npm");
  assert.equal(fizzlSite("evil.example"), undefined);
  assert.equal(fizzlSite("readme.evil"), undefined);
});

// Sign in with Pera (Algorand): an ed25519 signature over "MX" + the message, as Pera's signData makes it.
test("sign in with Pera: an Algorand account from a signed message; another key, text or address doesn't sign in", async () => {
  const { generateKeyPairSync, createHash, sign: edSign } = nodeCrypto;
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b32 = (buf) => { let bits = 0, v = 0, out = ""; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; };
  const algoKey = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    return { privateKey, address: b32(Buffer.concat([pub, createHash("sha512-256").update(pub).digest().subarray(28)])) };
  };
  const peraSign = (k, message) => edSign(null, Buffer.concat([Buffer.from("MX"), Buffer.from(message, "utf8")]), k.privateKey).toString("base64");
  const alice = algoKey(), mallory = algoKey();
  const { algorandPublicKey } = await import("../src/algorand.js");
  assert.ok(algorandPublicKey(alice.address), "the test's own address encoding is a valid Algorand address");
  assert.equal(algorandPublicKey("LOYVFSQ6ZTS2YWUW4GQ5L6VPP2TPIOXWYDACK53CPOHQQHLDMEMKJDXAX4")?.length, 32);
  assert.equal(algorandPublicKey("LOYVFSQ6ZTS2YWUW4GQ5L6VPP2TPIOXWYDACK53CPOHQQHLDMEMKJDXAX5"), null, "non-canonical padding");
  assert.equal(algorandPublicKey("LOYVFSQ6ZTS2YWUW4GQ5L6VPP2TPIOXWYDACK53CPOHQQHLDMEMKJDXAA4"), null, "bad checksum");

  const { base, server } = await boot();
  const post = (path, body, cookie) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).algorand, true);
    assert.equal((await post("/api/signin/message", { address: "NOTANADDRESS", chain: "algorand" })).status, 400);
    const m = await (await post("/api/signin/message", { address: alice.address, chain: "algorand" })).json();
    assert.match(m.message, /^127\.0\.0\.1:\d+ wants you to sign in with your Algorand account:\n/);
    assert.ok(m.message.includes(alice.address));
    assert.equal((await post("/api/signin", { nonce: m.nonce, signature: peraSign(mallory, m.message) })).status, 401);
    const m1 = await (await post("/api/signin/message", { address: alice.address, chain: "algorand" })).json();
    // Signed without Pera's "MX" prefix: not what Pera signs, refused.
    const bare = nodeCrypto.sign(null, Buffer.from(m1.message, "utf8"), alice.privateKey).toString("base64");
    assert.equal((await post("/api/signin", { nonce: m1.nonce, signature: bare })).status, 401);
    const m2 = await (await post("/api/signin/message", { address: alice.address, chain: "algorand" })).json();
    const r = await post("/api/signin", { nonce: m2.nonce, signature: peraSign(alice, m2.message) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie").split(";")[0];
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.id, `algo:${alice.address}`);
    assert.deepEqual([me.chain, me.signedInWith, me.address, me.plan, me.billing, me.auto], ["algorand", "pera", alice.address, "free", null, null]);
    // Pro isn't paid on Algorand yet: a claim says how to pay instead.
    const claim = await post("/api/billing/claim", { txHash: "X".repeat(52) }, cookie);
    assert.ok([400, 404, 503].includes(claim.status), String(claim.status));
  } finally { server.close(); }
});

test("Pro in USDC on Algorand: found from the Pera account, checked (asset, receiver, sender, amount, age), used once", async () => {
  const { generateKeyPairSync, createHash, sign: edSign } = nodeCrypto;
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b32 = (buf) => { let bits = 0, v = 0, out = ""; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; };
  const algoKey = () => { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32); return { privateKey, address: b32(Buffer.concat([pub, createHash("sha512-256").update(pub).digest().subarray(28)])) }; };
  const alice = algoKey(), owner = algoKey(), other = algoKey();
  const txid = (n) => b32(createHash("sha256").update(String(n)).digest()).slice(0, 52);
  const nowS = Math.floor(Date.now() / 1000);
  const axfer = (n, { from = alice.address, to = owner.address, amount = 5_000_000, asset = 31566704, age = 60, type = "axfer", confirmed = true } = {}) => ({ id: txid(n), sender: from, "tx-type": type, ...(confirmed ? { "confirmed-round": 1000 + n } : {}), "round-time": nowS - age, ...(type === "axfer" ? { "asset-transfer-transaction": { amount, "asset-id": asset, receiver: to, "close-amount": 0 } } : {}) });
  let incoming = [];
  const byId = new Map();
  const indexer = async (url) => {
    const m = /\/v2\/transactions\/([A-Z2-7]{52})$/.exec(url);
    if (m) return byId.has(m[1]) ? { transaction: byId.get(m[1]) } : null;
    if (url.includes(`/v2/accounts/${owner.address}/transactions`)) { assert.match(url, /asset-id=31566704/); return { transactions: incoming }; }
    return null;
  };
  const { base, server } = await boot({ algorand: { payTo: owner.address, indexerUrl: "https://idx.test" }, indexer });
  const post = (path, body, cookie) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    const m = await (await post("/api/signin/message", { address: alice.address, chain: "algorand" })).json();
    const sig = edSign(null, Buffer.concat([Buffer.from("MX"), Buffer.from(m.message)]), alice.privateKey).toString("base64");
    const cookie = (await post("/api/signin", { nonce: m.nonce, signature: sig })).headers.get("set-cookie").split(";")[0];
    const me0 = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.deepEqual({ payTo: me0.algoPay.payTo, asset: me0.algoPay.asset, price: me0.algoPay.priceUsdc }, { payTo: owner.address, asset: 31566704, price: 5 });
    const claim = async (body) => { const r = await post("/api/billing/claim", body, cookie); return { status: r.status, body: await r.json().catch(() => null) }; };

    // Nothing paid yet: "not found yet" (409, the dashboard keeps looking).
    const none = await claim({ chainId: "algorand" });
    assert.equal(none.status, 409, JSON.stringify(none.body));
    // Only someone else's payment, an app call, another asset, too little, too old: none counts.
    incoming = [axfer(1, { from: other.address }), axfer(2, { type: "appl" }), axfer(3, { asset: 1 }), axfer(4, { amount: 1_000_000 }), axfer(5, { age: 8 * 86400 })];
    const refused = await claim({ chainId: "algorand" });
    assert.equal(refused.status, 400);
    // A pasted id of someone else's payment, or of a payment to someone else.
    for (const tx of [axfer(6, { from: other.address }), axfer(7, { to: other.address })]) byId.set(tx.id, tx);
    assert.match((await claim({ chainId: "algorand", txHash: txid(6) })).body.message, /came from/);
    assert.match((await claim({ chainId: "algorand", txHash: txid(7) })).body.message, /not a payment to/);
    assert.equal((await claim({ chainId: "algorand", txHash: "nope" })).status, 400);
    // The real one: 5 USDC from alice's own Pera account, a minute ago.
    incoming.push(axfer(8));
    const ok = await claim({ chainId: "algorand" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.plan, "pro");
    assert.equal(ok.body.payments[0].chain, "algorand");
    assert.equal(ok.body.payments[0].tx, txid(8));
    // Used once: checking again finds nothing new; the same id pasted is a no-op on the same account.
    assert.equal((await claim({ chainId: "algorand" })).status, 409);
    assert.equal((await claim({ chainId: "algorand", txHash: txid(8) })).status, 200);
    const me1 = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me1.payments.length, 1);
  } finally { server.close(); }
});

test("an Algorand USDC transfer (presign-guard-wallet algorandSigner) counts as USDC and names its network; Telegram shows it", async () => {
  const { owner, agent, server, tg } = await boot();
  try {
    const NET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
    const SELLER = "SGLTUPAC7TKGKNNXKNPQ2QZCC7NJSLAKYZ7O7NOGGAPXWBFZTOLTPMSPPI";
    const request = (usdc) => ({ type: "algorand", network: NET, txn: { type: "axfer", sender: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA", receiver: SELLER, amount: String(usdc * 1e6), assetId: "31566704" } });
    const ok = await agent("POST", "/v1/reserve", { method: "signAlgorandTransfer", request: request(2), purchase: { url: "https://algo-seller.example/data" } });
    assert.equal(ok.body.status, "ok");
    assert.equal((await agent("GET", "/v1/spending")).body.spending[0].used, "2");
    const p = (await owner("GET", `/api/purchases/${ok.body.purchaseId}`)).body.purchase;
    assert.deepEqual([p.chainId, p.to, p.method], [NET, SELLER, "signAlgorandTransfer"]);
    const over = await agent("POST", "/v1/reserve", { method: "signAlgorandTransfer", request: request(8) });
    assert.equal(over.body.status, "pending");
    await new Promise((r) => setTimeout(r, 20));
    const msg = tg.calls.find((c) => c.method === "sendMessage").body.text;
    assert.match(msg, /<code>signAlgorandTransfer<\/code> · Algorand · to <code>SGLTUPAC/);
    assert.doesNotMatch(msg, /undefined/);
  } finally { server.close(); }
});

// Sign in with Defly: Defly signs transactions only, so the sign-in is a 0 ALGO payment to yourself with a fee of 0,
// built by the server and never sent. algosdk stands in for the wallet: it decodes the bytes, re-encodes and signs.
test("sign in with Defly: a signed 0 ALGO, fee 0 self-payment the server built; anything else doesn't sign in", async () => {
  const algosdk = (await import("algosdk")).default;
  const { algorandAuthTxn, verifyAlgorandAuthTxn } = await import("../src/algorand.js");
  const alice = algosdk.generateAccount(), mallory = algosdk.generateAccount();
  const aliceAddr = alice.addr.toString();
  // The server's bytes are exactly algosdk's canonical encoding, so what the wallet signs is what the server checks.
  const bytes = algorandAuthTxn({ address: aliceAddr, note: "hello\n" + "x".repeat(400), firstValid: 50_000_000, lastValid: 50_001_000, genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", genesisId: "mainnet-v1.0" });
  const txn = algosdk.decodeUnsignedTransaction(bytes);
  assert.deepEqual(Buffer.from(algosdk.encodeUnsignedTransaction(txn)), bytes);
  assert.equal(txn.type, "pay");
  assert.equal(txn.payment.amount, 0n);
  assert.equal(txn.fee, 0n, "fee 0: below the network minimum, it can never be confirmed alone");
  assert.equal(txn.payment.receiver.toString(), aliceAddr);
  assert.ok(verifyAlgorandAuthTxn(aliceAddr, bytes, Buffer.from(txn.signTxn(alice.sk)).toString("base64")));
  assert.equal(verifyAlgorandAuthTxn(aliceAddr, bytes, txn.signTxn(mallory.sk)), false, "another key");
  assert.equal(verifyAlgorandAuthTxn(mallory.addr.toString(), bytes, txn.signTxn(mallory.sk)), false, "not that address's transaction");
  // Rekeyed: signed by another key with "sgnr" set; refused.
  const rekeyed = algosdk.encodeObj({ sgnr: mallory.addr.publicKey, ...algosdk.decodeObj(txn.signTxn(mallory.sk)) });
  assert.equal(verifyAlgorandAuthTxn(aliceAddr, bytes, rekeyed), false, "a rekeyed account");
  // A different transaction (here: 1 ALGO to mallory) signed by alice is not the sign-in.
  const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: aliceAddr, receiver: mallory.addr, amount: 1_000_000, suggestedParams: { fee: 0, flatFee: true, firstValid: 50_000_000, lastValid: 50_001_000, genesisHash: algosdk.base64ToBytes("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="), genesisID: "mainnet-v1.0", minFee: 1000 } });
  assert.equal(verifyAlgorandAuthTxn(aliceAddr, bytes, pay.signTxn(alice.sk)), false);

  const { base, server } = await boot({ algorand: { payTo: "LOYVFSQ6ZTS2YWUW4GQ5L6VPP2TPIOXWYDACK53CPOHQQHLDMEMKJDXAX4", algodUrl: "https://algod.test" } });
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const signWith = async (account) => {
      const m = await (await post("/api/signin/message", { address: aliceAddr, chain: "algorand", style: "txn" })).json();
      const t = algosdk.decodeUnsignedTransaction(Buffer.from(m.txn, "base64"));
      assert.equal(new TextDecoder().decode(t.note), m.message);
      assert.match(m.message, /sends 0 ALGO to yourself with a fee of 0, and it is never submitted/);
      assert.equal(t.firstValid, 50_000_000n);
      return post("/api/signin", { nonce: m.nonce, signature: Buffer.from(t.signTxn(account.sk)).toString("base64") });
    };
    assert.equal((await signWith(mallory)).status, 401);
    const r = await signWith(alice);
    assert.equal(r.status, 200);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie: r.headers.get("set-cookie").split(";")[0] } })).json();
    assert.deepEqual([me.id, me.chain], [`algo:${aliceAddr}`, "algorand"]);
    // The same message signed as Pera does (signData) doesn't count for a Defly nonce: it expects the transaction.
    const m = await (await post("/api/signin/message", { address: aliceAddr, chain: "algorand", style: "txn" })).json();
    const peraStyle = nodeCrypto.sign(null, Buffer.concat([Buffer.from("MX"), Buffer.from(m.message)]), nodeCrypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(alice.sk.subarray(0, 32))]), format: "der", type: "pkcs8" })).toString("base64");
    assert.equal((await post("/api/signin", { nonce: m.nonce, signature: peraStyle })).status, 401);
  } finally { server.close(); }
});
