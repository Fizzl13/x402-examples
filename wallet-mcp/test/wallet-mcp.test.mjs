import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeFunctionData, erc20Abi } from "viem";
import { configFromEnv, createServer, createWallet, words } from "../lib.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a well-known test key (anvil #1), no funds
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const DRAINER = "0x2222222222222222222222222222222222222222";
const API = "https://api.example.test/data";
const MPP_API = "https://mpp.example.test/data"; // MPP only: WWW-Authenticate: Payment (method evm, USDC on Base)

// presign-guard (red for the drainer) and an x402 API that costs 0.05 USDC.
function network({ price = "50000" } = {}) {
  const checks = [], paid = [];
  const requirements = { scheme: "exact", network: "eip155:8453", amount: price, asset: USDC_BASE, payTo: SHOP, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    if (url.startsWith("https://presign-guard.fizzl.eu/")) {
      const body = JSON.parse(input instanceof Request ? await input.text() : init.body);
      checks.push(body);
      const red = JSON.stringify(body).toLowerCase().includes(DRAINER.slice(2));
      // Like the real service, decode an EIP-3009 payment into what it grants.
      const td = body.typedData;
      const subject = td?.primaryType === "TransferWithAuthorization"
        ? { kind: "transfer_authorization", grants: [{ token: td.domain.verifyingContract.toLowerCase(), spender: td.message.to.toLowerCase(), amount: String(td.message.value), mode: "payment" }] }
        : undefined;
      return Response.json({ verdict: red ? "red" : "green", reasons: red ? [{ code: "known_drainer" }] : [], subject });
    }
    if (url === API) {
      const sig = headers.get("payment-signature") ?? headers.get("x-payment");
      if (!sig) {
        const challenge = { x402Version: 2, error: "payment required", resource: { url: API, description: "data", mimeType: "application/json" }, accepts: [requirements] };
        return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
      }
      paid.push(JSON.parse(Buffer.from(sig, "base64").toString()));
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: "0xsettled", network: "eip155:8453", payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })).toString("base64");
      return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } });
    }
    // An MPP-only API (like an mppx server with evm.charge): a challenge, then a credential with the EIP-3009 authorization.
    if (url === MPP_API) {
      const request = { amount: price, currency: USDC_BASE, methodDetails: { chainId: 8453, credentialTypes: ["authorization"], decimals: 6 }, recipient: SHOP };
      const params = { id: "ch_1", realm: "mpp.example.test", method: "evm", intent: "charge", request: Buffer.from(JSON.stringify(request)).toString("base64url"), expires: new Date(Date.now() + 300_000).toISOString(), opaque: "eyJyb3V0ZSI6IkdFVCAvZGF0YSJ9" };
      const auth = headers.get("authorization");
      if (!auth) {
        const h = `Payment ${Object.entries(params).map(([k, v]) => `${k}="${v}"`).join(", ")}`;
        return new Response(JSON.stringify({ title: "Payment required" }), { status: 402, headers: { "content-type": "application/problem+json", "www-authenticate": h } });
      }
      const cred = JSON.parse(Buffer.from(auth.replace(/^Payment\s+/i, ""), "base64url").toString());
      mppPaid.push(cred);
      const receipt = Buffer.from(JSON.stringify({ method: "evm", reference: "0xmppsettled", status: "success", timestamp: new Date().toISOString() })).toString("base64url");
      return new Response(JSON.stringify({ answer: 43 }), { status: 200, headers: { "content-type": "application/json", "payment-receipt": receipt } });
    }
    // The x402 catalog (Bazaar discovery).
    if (url.startsWith("https://catalog.test/")) {
      catalogCalls.push(url);
      const usdcOn = (network, asset, amount) => ({ scheme: "exact", network, asset, amount, payTo: SHOP });
      return Response.json({ items: [
        { resource: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", description: "Ichimoku cloud trend signal for a crypto pair (bullish, bearish, neutral)", accepts: [usdcOn("eip155:8453", USDC_BASE, "20000")], extensions: { bazaar: { info: { input: { method: "GET", queryParams: { pair: "BTC-USDT" } } } } } },
        { resource: "https://pricey.example/signal", description: "Premium crypto trend signal", accepts: [usdcOn("eip155:8453", USDC_BASE, "5000000")] },
        { resource: "https://solana-only.example/signal", description: "Crypto trend signal", accepts: [usdcOn("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "10000")] },
        { resource: "https://weather.example/today", description: "Weather forecast for a city", accepts: [usdcOn("eip155:8453", USDC_BASE, "1000")] },
        { resource: "https://cheap.example/trend", description: "Crypto trend in one word", accepts: [usdcOn("eip155:8453", USDC_BASE, "5000")] },
      ] });
    }
    // A wallet server: everything allowed, records what the receipts get.
    if (url.startsWith("https://wallet.test/v1/")) {
      const body = init.body ? JSON.parse(init.body) : null;
      server.push([url.slice("https://wallet.test".length), body]);
      if (url.endsWith("/v1/reserve")) return Response.json({ status: "ok", entries: ["sp_1"], purchaseId: "pu_1" });
      return Response.json({ ok: true, updated: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const server = [], catalogCalls = [], mppPaid = [];
  return { fetch, checks, paid, server, catalogCalls, mppPaid };
}

// A stand-in for the viem wallet: records what it would send or sign.
function fakeWallet() {
  const sent = [];
  return {
    sent,
    walletClient: {
      chain: { id: 8453 },
      writeContract: async (args) => { sent.push(["writeContract", args]); return "0xtransfer"; },
      sendTransaction: async (args) => { sent.push(["sendTransaction", args]); return "0xnative"; },
      signTypedData: async (args) => { sent.push(["signTypedData", args.primaryType]); return `0x${"11".repeat(65)}`; },
    },
    publicClient: {
      getBalance: async () => 10n ** 16n,
      readContract: async ({ functionName }) => (functionName === "balanceOf" ? 12_340_000n : 0n),
    },
  };
}

const ENV = { AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "5", LIMIT_USDC_PER_DAY: "20" };

async function setup(env = {}, opts = {}) {
  const net = network(opts);
  const fake = fakeWallet();
  const spends = [];
  const wallet = createWallet(configFromEnv({ ...ENV, ...env }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off", onSpend: (e) => spends.push(e) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(wallet).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content[0].text };
  };
  return { client, call, wallet, net, fake, spends };
}

test("configuration: a budget is required and conflicting setups are refused", () => {
  assert.throws(() => configFromEnv({}), /AGENT_KEY/);
  assert.throws(() => configFromEnv({ AGENT_KEY: "nope" }), /AGENT_KEY/);
  assert.throws(() => configFromEnv({ AGENT_KEY: KEY }), /spending limits/);
  assert.throws(() => configFromEnv({ ...ENV, CHAIN: "solana" }), /CHAIN/);
  assert.throws(() => configFromEnv({ ...ENV, LIMIT_USDC_PER_TX: "five" }), /amounts/);
  assert.throws(() => configFromEnv({ ...ENV, WALLET_SERVER_URL: "https://wallet.fizzl.eu", WALLET_SERVER_KEY: "awk_x" }), /leave out the LIMIT_/);
  assert.throws(() => configFromEnv({ ...ENV, TELEGRAM_BOT_TOKEN: "123:abc" }), /TELEGRAM_CHAT_ID/);
  const c = configFromEnv({ ...ENV, CHAIN: "Arbitrum", LIMIT_NATIVE_PER_TX: "0.01" });
  assert.equal(c.chainName, "arbitrum");
  assert.deepEqual(c.limits.tokens, { USDC: { perTx: "5", perDay: "20" }, ETH: { perTx: "0.01" } });
  const s = configFromEnv({ AGENT_KEY: KEY, WALLET_SERVER_URL: "https://wallet.fizzl.eu", WALLET_SERVER_KEY: "awk_x" });
  assert.equal(s.limits, undefined);
  assert.equal(s.server.url, "https://wallet.fizzl.eu");
});

test("the MCP client sees six tools", async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["find_services", "pause_spending", "pay_x402", "send_native", "send_usdc", "wallet_status"]);
});

test("wallet_status: address, balances, limits and what is left", async () => {
  const { call } = await setup();
  const r = await call("wallet_status");
  assert.equal(r.error, false);
  const s = JSON.parse(r.text);
  assert.equal(s.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  assert.equal(s.balances.USDC, "12.34");
  assert.equal(s.balances.ETH, "0.01");
  assert.deepEqual(s.limits, { USDC: { perTx: "5", perDay: "20" } });
  assert.ok(Array.isArray(s.spending) && s.spending.some((row) => row.token === "USDC"));
  assert.match(s.approvals, /refused/);
});

test("send_usdc: checked, under the limit sent, over the limit refused without an approver", async () => {
  const { call, net, fake } = await setup();
  const ok = await call("send_usdc", { to: SHOP, amount: "2.5" });
  assert.equal(ok.error, false, ok.text);
  assert.equal(JSON.parse(ok.text).hash, "0xtransfer");
  const [, args] = fake.sent[0];
  assert.equal(args.address, USDC_BASE);
  assert.deepEqual(args.args, [SHOP, 2_500_000n]);
  assert.equal(net.checks.length, 1);
  assert.equal(decodeFunctionData({ abi: erc20Abi, data: net.checks[0].data }).functionName, "transfer");

  const over = await call("send_usdc", { to: SHOP, amount: "8" });
  assert.equal(over.error, true);
  assert.match(over.text, /over_limit/);
  assert.equal(fake.sent.length, 1);
});

test("send_usdc to a drainer is never signed", async () => {
  const { call, fake } = await setup();
  const r = await call("send_usdc", { to: DRAINER, amount: "1" });
  assert.equal(r.error, true);
  assert.match(r.text, /red/);
  assert.equal(fake.sent.length, 0);
});

test("send_native goes through the guard", async () => {
  const { call, fake } = await setup({ LIMIT_NATIVE_PER_TX: "0.01" });
  const r = await call("send_native", { to: SHOP, amount: "0.001" });
  assert.equal(r.error, false, r.text);
  assert.deepEqual(fake.sent[0], ["sendTransaction", { to: SHOP, value: 10n ** 15n }]);
  const over = await call("send_native", { to: SHOP, amount: "0.5" });
  assert.match(over.text, /over_limit/);
});

test("pay_x402: pays the API through the guard and returns its answer", async () => {
  const { call, net, fake } = await setup();
  const r = await call("pay_x402", { url: API });
  assert.equal(r.error, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.status, 200);
  assert.equal(out.paid, true);
  assert.equal(out.payment.transaction, "0xsettled");
  assert.deepEqual(JSON.parse(out.body), { answer: 42 });
  assert.equal(net.paid.length, 1);
  assert.deepEqual(fake.sent, [["signTypedData", "TransferWithAuthorization"]]);
  assert.equal(net.checks.length, 1);
  assert.equal(net.checks[0].type, "signature");
});

test("pay_x402: a price above the cap is not paid", async () => {
  const { call, net, fake } = await setup({ MAX_PAYMENT_USD: "0.01" });
  const r = await call("pay_x402", { url: API });
  assert.equal(net.paid.length, 0);
  assert.equal(fake.sent.length, 0);
  assert.ok(r.error || JSON.parse(r.text).paid === false, r.text);
});

test("pay_x402: a price over the USDC limit waits for the owner (refused without an approver)", async () => {
  const { call, net, fake } = await setup({ MAX_PAYMENT_USD: "10" }, { price: "6000000" });
  const r = await call("pay_x402", { url: API });
  assert.equal(r.error, true);
  assert.match(r.text, /^Not done.*6 USDC is over the limit of 5 per transaction/);
  assert.equal(net.paid.length, 0);
  assert.equal(fake.sent.length, 0);
});

test("pause_spending stops everything", async () => {
  const { call, fake } = await setup();
  assert.match((await call("pause_spending", { reason: "odd request" })).text, /Paused/);
  assert.match((await call("send_usdc", { to: SHOP, amount: "1" })).text, /paused/);
  assert.match((await call("pay_x402", { url: API })).text, /paused/);
  assert.equal(fake.sent.length, 0);
  assert.equal(JSON.parse((await call("wallet_status")).text).paused, true);
});

test("bad input is refused before anything is signed", async () => {
  const { call, fake } = await setup();
  assert.equal((await call("send_usdc", { to: "not-an-address", amount: "1" })).error, true);
  assert.equal((await call("send_usdc", { to: SHOP, amount: "-1" })).error, true);
  assert.equal(fake.sent.length, 0);
});

test("every payment says what it was for (receipts, approvals)", async () => {
  const { call, spends } = await setup();
  await call("pay_x402", { url: API, reason: "data for the weekly report" });
  assert.deepEqual(spends[0].purchase, { url: API, description: "data for the weekly report" });
  await call("pay_x402", { url: API });
  assert.deepEqual(spends[1].purchase, { url: API, description: "GET api.example.test" });
  await call("send_usdc", { to: SHOP, amount: "1", reason: "refund order 1042" });
  assert.deepEqual(spends[2].purchase, { description: "refund order 1042" });
  await call("send_usdc", { to: SHOP, amount: "1" });
  assert.equal(spends[3].purchase.description, `Send 1 USDC to ${SHOP}`);
});

test("pay_x402 with a wallet server: the API's answer goes on the receipt", async () => {
  const net = network();
  const fake = fakeWallet();
  const wallet = createWallet(configFromEnv({ AGENT_KEY: KEY, WALLET_SERVER_URL: "https://wallet.test", WALLET_SERVER_KEY: "awk_test" }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off" } });
  const out = await wallet.payX402({ url: API, reason: "the answer" });
  assert.equal(out.status, 200);
  await new Promise((ok) => setTimeout(ok, 50));
  const annotate = net.server.find(([path]) => path === "/v1/purchases/annotate");
  assert.ok(annotate, "the outcome is sent to the wallet server");
  assert.deepEqual(annotate[1].ids, ["pu_1"]);
  assert.equal(annotate[1].outcome.httpStatus, 200);
  assert.deepEqual(annotate[1].outcome.settlement, { transaction: "0xsettled", network: "eip155:8453" });
  assert.deepEqual(annotate[1].outcome.content, { contentType: "application/json", body: JSON.stringify({ answer: 42 }) });
});

test("find_services: paid APIs from the x402 catalog this wallet can pay, best match first, within the price cap", async () => {
  const net = network();
  const fake = fakeWallet();
  const wallet = createWallet(configFromEnv({ ...ENV, MAX_PAYMENT_USD: "1", X402_DISCOVERY_URL: "https://catalog.test/discovery" }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off" } });
  const r = await wallet.findServices({ query: "bitcoin crypto trend signal" });
  // Matches on Base in USDC under $1; the $5 one and the Solana-only one are left out, and so is the weather.
  assert.deepEqual(r.services.map((s) => s.url), ["https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", "https://cheap.example/trend"]);
  assert.equal(r.services[0].price_usd, 0.02);
  assert.equal(r.services[0].method, "GET");
  assert.deepEqual(r.services[0].input_example, { pair: "BTC-USDT" });
  assert.match(r.note, /pay_x402/);
  // A lower cap leaves out the $0.02 one; the catalog is fetched once and kept.
  assert.deepEqual((await wallet.findServices({ query: "crypto trend", maxPriceUsd: 0.01 })).services.map((s) => s.url), ["https://cheap.example/trend"]);
  assert.equal(net.catalogCalls.length, 1);
  assert.equal((await wallet.findServices({ query: "quantum chess lessons" })).services.length, 0);
  await assert.rejects(wallet.findServices({ query: "a" }), /say what you need/);
});


test("find_services understands a plain question, in Dutch too", () => {
  assert.deepEqual(words("Wat is het weer de komende dagen in Amsterdam?"), ["weather", "days", "amsterdam"]);
  assert.deepEqual(words("Wat is de koers van Bitcoin vandaag?"), ["price", "bitcoin", "today"]);
  assert.deepEqual(words("What is the weather in Amsterdam?"), ["weather", "amsterdam"]);
});

test("pay_x402 on an MPP-only API: the same EIP-3009 signature through the guard, sent as an MPP credential", async () => {
  const { call, net, fake } = await setup();
  const r = await call("pay_x402", { url: MPP_API, reason: "MPP data" });
  assert.equal(r.error, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.status, 200);
  assert.equal(out.paid, true);
  assert.deepEqual([out.payment.protocol, out.payment.transaction, out.payment.network], ["mpp", "0xmppsettled", "eip155:8453"]);
  assert.deepEqual(JSON.parse(out.body), { answer: 43 });
  // Checked by presign-guard like any x402 payment, signed once.
  assert.deepEqual(fake.sent, [["signTypedData", "TransferWithAuthorization"]]);
  assert.equal(net.checks.length, 1);
  assert.equal(net.checks[0].typedData.message.to.toLowerCase(), SHOP);
  // The credential echoes the challenge (request and opaque as received) and binds the nonce to it.
  const [cred] = net.mppPaid;
  assert.equal(cred.challenge.id, "ch_1");
  assert.equal(cred.challenge.opaque, "eyJyb3V0ZSI6IkdFVCAvZGF0YSJ9");
  assert.equal(typeof cred.challenge.request, "string");
  const { keccak256, stringToHex } = await import("viem");
  assert.equal(cred.payload.nonce, keccak256(stringToHex(JSON.stringify(["ch_1", "mpp.example.test"]))));
  assert.deepEqual([cred.payload.type, cred.payload.value, cred.payload.to.toLowerCase()], ["authorization", "50000", SHOP]);
});

test("pay_x402 on an MPP-only API: a price above the cap or over the limit is not paid", async () => {
  let { call, net, fake } = await setup({ MAX_PAYMENT_USD: "0.01" });
  let r = await call("pay_x402", { url: MPP_API });
  assert.equal(r.error, true);
  assert.match(r.text, /above max_price_usd/);
  assert.equal(net.mppPaid.length, 0);
  assert.equal(fake.sent.length, 0);
  ({ call, net, fake } = await setup({ MAX_PAYMENT_USD: "10" }, { price: "6000000" }));
  r = await call("pay_x402", { url: MPP_API });
  assert.equal(r.error, true);
  assert.match(r.text, /over the limit of 5 per transaction/);
  assert.equal(net.mppPaid.length, 0);
});

test("pay_x402 on an MPP-only API with a wallet server: the MPP settlement goes on the receipt", async () => {
  const net = network();
  const fake = fakeWallet();
  const wallet = createWallet(configFromEnv({ AGENT_KEY: KEY, WALLET_SERVER_URL: "https://wallet.test", WALLET_SERVER_KEY: "awk_test" }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off" } });
  const out = await wallet.payX402({ url: MPP_API, reason: "MPP answer" });
  assert.equal(out.paid, true);
  const done = net.server.find(([path, body]) => body && JSON.stringify(body).includes("0xmppsettled"));
  assert.ok(done, `receipt with the MPP settlement: ${JSON.stringify(net.server)}`);
});
