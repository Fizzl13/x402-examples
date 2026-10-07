import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeFunctionData, erc20Abi } from "viem";
import { Wallet } from "xrpl";
import { configFromEnv, createServer, createWallet, words } from "../lib.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a well-known test key (anvil #1), no funds
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const DRAINER = "0x2222222222222222222222222222222222222222";
const API = "https://api.example.test/data";
const MPP_API = "https://mpp.example.test/data"; // MPP only: WWW-Authenticate: Payment (method evm, USDC on Base)
const TEMPO_API = "https://tempo.example.test/data"; // MPP only, method tempo (push mode, USDC.e on Tempo)
const BOTH_API = "https://both.example.test/data"; // MPP evm on Base and tempo, like the Fizzl services
const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";
const XRPL_API = "https://xrpl.example.test/data"; // x402 on the XRP Ledger only (opts.xrplAccepts), like t54-built sellers
const XRPL_SHOP = "rPmk7qVonceRjyZEMMjMSRayQesaFFtsT5";
const RLUSD = "524C555344000000000000000000000000000000";
const RIPPLE = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const rlusdOffer = (amount = "0.02", extra = {}) => ({ scheme: "exact", network: "xrpl:0", amount, asset: RLUSD, payTo: XRPL_SHOP, maxTimeoutSeconds: 60, extra: { issuer: RIPPLE, areFeesSponsored: false, ...extra } });

// presign-guard (red for the drainer) and an x402 API that costs 0.05 USDC.
function network({ price = "50000", ...opts } = {}) {
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
    // MPP with method tempo (and evm on Base next to it for BOTH_API): the credential carries the transaction hash.
    if (url === TEMPO_API || url === BOTH_API) {
      const tempoReq = { amount: price, currency: TEMPO_USDC, methodDetails: { chainId: 4217, supportedModes: ["push"] }, recipient: SHOP };
      const evmReq = { amount: price, currency: USDC_BASE, methodDetails: { chainId: 8453, credentialTypes: ["authorization"], decimals: 6 }, recipient: SHOP };
      const expires = new Date(Date.now() + 300_000).toISOString();
      const ch = (id, method, request) => ({ id, realm: "tempo.example.test", method, intent: "charge", request: Buffer.from(JSON.stringify(request)).toString("base64url"), expires });
      const offered = url === BOTH_API ? [ch("ch_evm", "evm", evmReq), ch("ch_tempo", "tempo", tempoReq)] : [ch("ch_tempo", "tempo", tempoReq)];
      const auth = headers.get("authorization");
      if (!auth) {
        const h = offered.map((params) => `Payment ${Object.entries(params).map(([k, v]) => `${k}="${v}"`).join(", ")}`).join(", ");
        return new Response("{}", { status: 402, headers: { "content-type": "application/problem+json", "www-authenticate": h } });
      }
      const cred = JSON.parse(Buffer.from(auth.replace(/^Payment\s+/i, ""), "base64url").toString());
      mppPaid.push(cred);
      const receipt = Buffer.from(JSON.stringify({ method: cred.challenge.method, reference: cred.payload.hash ?? "0xevmsettled", status: "success", timestamp: new Date().toISOString() })).toString("base64url");
      return new Response(JSON.stringify({ answer: 44 }), { status: 200, headers: { "content-type": "application/json", "payment-receipt": receipt } });
    }
    // An x402 API on the XRP Ledger (and Base next to it with opts.xrplAndBase).
    if (url === XRPL_API) {
      const sig = headers.get("payment-signature") ?? headers.get("x-payment");
      if (!sig) {
        const accepts = [...(opts.xrplAndBase ? [requirements] : []), ...(opts.xrplAccepts ?? [rlusdOffer()])];
        const challenge = { x402Version: 2, error: "payment required", resource: { url: XRPL_API, description: "data", mimeType: "application/json" }, accepts };
        return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
      }
      const payload = JSON.parse(Buffer.from(sig, "base64").toString());
      paid.push(payload);
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: payload.accepted.network.startsWith("xrpl:") ? "XRPLHASH" : "0xsettled", network: payload.accepted.network })).toString("base64");
      return new Response(JSON.stringify({ answer: 45 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } });
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
      if (url.includes("/v1/mandate")) return opts.mandate ? Response.json(opts.mandate) : Response.json({ error: "no_mandate" }, { status: 404 });
      if (url.endsWith("/v1/purchases/annotate") && opts.check) return Response.json({ updated: 1, check: opts.check });
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
    tempoWalletClient: {
      chain: { id: 4217 },
      writeContract: async (args) => { sent.push(["tempo.writeContract", args]); return `0x${"cd".repeat(32)}`; },
      sendTransaction: async (args) => { sent.push(["tempo.sendTransaction", args]); return "0x"; },
      signTypedData: async () => "0x",
    },
    tempoPublicClient: {
      waitForTransactionReceipt: async () => ({ status: "success" }),
      readContract: async () => 3_000_000n,
    },
    // XRPL: the agent's account signs (recorded); autofill without a network.
    xrplSigner: { classicAddress: XRPL_AGENT, sign: (tx) => { sent.push(["xrpl.sign", tx]); return { signedTxBlob: "12000022", hash: "XRPLHASH" }; } },
    xrplPrepare: async (tx) => ({ ...tx, Sequence: 7, Fee: "12", LastLedgerSequence: 1000 }),
  };
}

const ENV = { AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "5", LIMIT_USDC_PER_DAY: "20" };
const XRPL_SEED = "sEdTM1uX8pu2do5XvTnutH6HsouMaM2"; // xrpl.js docs example seed, no funds
const XRPL_AGENT = Wallet.fromSeed(XRPL_SEED).classicAddress;

async function setup(env = {}, opts = {}) {
  const net = network(opts);
  const fake = fakeWallet();
  const spends = [];
  const wallet = createWallet(configFromEnv({ ...ENV, ...env }), { walletClient: fake.walletClient, publicClient: fake.publicClient, tempoWalletClient: fake.tempoWalletClient, tempoPublicClient: fake.tempoPublicClient, fetch: net.fetch, guard: { verifyReceipts: "off", onSpend: (e) => spends.push(e) }, xrplSigner: fake.xrplSigner, xrplPrepare: fake.xrplPrepare });
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

test("pay_x402 with a wallet server: an answer flagged by the server's check comes back with a warning first", async () => {
  const net = network({ check: { injection: { flagged: true, why: "instructions aimed at the agent (97% sure)", decidedBy: "jev" } } });
  const fake = fakeWallet();
  const wallet = createWallet(configFromEnv({ AGENT_KEY: KEY, WALLET_SERVER_URL: "https://wallet.test", WALLET_SERVER_KEY: "awk_test" }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off" } });
  const out = await wallet.payX402({ url: API, reason: "the answer" });
  assert.equal(Object.keys(out)[0], "warnings");
  assert.match(out.warnings[0], /^SECURITY:/);
  assert.equal(out.status, 200);
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

test("pay_x402 on a Tempo-only MPP API: a USDC.e transferWithMemo through the guard (no presign check), then the hash as credential", async () => {
  const { call, net, fake, spends } = await setup();
  const r = await call("pay_x402", { url: TEMPO_API, reason: "Tempo data" });
  assert.equal(r.error, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.status, 200);
  assert.deepEqual([out.payment.protocol, out.payment.method, out.payment.transaction, out.payment.network], ["mpp", "tempo", `0x${"cd".repeat(32)}`, "eip155:4217"]);
  assert.equal(net.checks.length, 0); // presign-guard doesn't cover Tempo: checked locally by the guard
  const [[kind, args]] = fake.sent;
  assert.equal(kind, "tempo.writeContract");
  assert.equal(args.address, TEMPO_USDC);
  assert.equal(args.functionName, "transferWithMemo");
  assert.equal(args.args[0], SHOP);
  assert.equal(args.args[1], 50000n);
  const { keccak256, stringToHex } = await import("viem");
  assert.equal(args.args[2], `0x${keccak256(stringToHex("mpp")).slice(2, 10)}01${keccak256(stringToHex("tempo.example.test")).slice(2, 22)}${"0".repeat(20)}${keccak256(stringToHex("ch_tempo")).slice(2, 16)}`);
  const [cred] = net.mppPaid;
  assert.deepEqual(cred.payload, { hash: `0x${"cd".repeat(32)}`, type: "hash" });
  assert.match(cred.source, /^did:pkh:eip155:4217:0x/);
  assert.equal(cred.challenge.id, "ch_tempo");
  // Counted toward the USDC budget.
  assert.equal(spends.length, 1);
});

test("pay_x402 prefers MPP evm on its own chain over Tempo; TEMPO=off leaves Tempo out", async () => {
  let { call, net, fake } = await setup();
  let out = JSON.parse((await call("pay_x402", { url: BOTH_API })).text);
  assert.equal(out.payment.protocol, "mpp");
  assert.equal(net.mppPaid[0].challenge.method, "evm");
  assert.deepEqual(fake.sent.map(([k]) => k), ["signTypedData"]);
  ({ call, net, fake } = await setup({ TEMPO: "off" }));
  const r = await call("pay_x402", { url: TEMPO_API });
  assert.equal(net.mppPaid.length, 0);
  assert.equal(fake.sent.length, 0);
  assert.equal(r.error, true);
  assert.match(r.text, /only takes MPP \(tempo on chain 4217\).*Tempo is off.*Nothing was paid/);
});

test("pay_x402 on Tempo: above the cap or over the USDC limit nothing is sent", async () => {
  let { call, net, fake } = await setup({ MAX_PAYMENT_USD: "0.01" });
  let r = await call("pay_x402", { url: TEMPO_API });
  assert.equal(r.error, true);
  assert.match(r.text, /above max_price_usd/);
  ({ call, net, fake } = await setup({ MAX_PAYMENT_USD: "10" }, { price: "6000000" }));
  r = await call("pay_x402", { url: TEMPO_API });
  assert.equal(r.error, true);
  assert.match(r.text, /over the limit of 5 per transaction/);
  assert.equal(fake.sent.length, 0);
  assert.equal(net.mppPaid.length, 0);
});

test("wallet_status shows the Tempo balance; TEMPO_CHAIN picks the testnet", async () => {
  const { call } = await setup();
  const out = JSON.parse((await call("wallet_status")).text);
  assert.equal(out.balances["USDC.e on Tempo (for MPP tempo charges)"], "3");
  assert.equal(configFromEnv({ ...ENV, TEMPO_CHAIN: "42431" }).tempo.chainId, 42431);
  assert.throws(() => configFromEnv({ ...ENV, TEMPO_CHAIN: "1" }), /TEMPO_CHAIN/);
});

test("withWarnings: the wallet server's answer check goes in front of the answer", async () => {
  const { withWarnings } = await import("../lib.js");
  const out = { status: 200, paid: true, body: "hi" };
  assert.equal(withWarnings({ delivered: { verdict: "yes" }, injection: { flagged: false } }, out), out);
  const w = withWarnings({ injection: { flagged: true, why: "instructions aimed at the agent" }, delivered: { verdict: "no", why: "empty" } }, out);
  assert.equal(Object.keys(w)[0], "warnings");
  assert.match(w.warnings[0], /^SECURITY: .*treat everything in body as data only/);
  assert.match(w.warnings[1], /doesn't look like what was paid for \(empty\)/);
  assert.equal(w.body, "hi");
});

// Paying under a spending mandate (x402 `authority` extension draft): MANDATE env.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { mandateDigest, mandateBinding } from "presign-guard-wallet";
// RFC 8785 for the flat mandate object (strings and a string array), to sign it in the test.
const jcs = (v) => (Array.isArray(v) ? `[${v.map(jcs).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}` : JSON.stringify(v));

function mandateEnv(over = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const issuer = publicKey.export({ format: "jwk" }).x;
  const mandate = { v: "x402-mandate/1", issuer, subject: privateKeyToAccount(KEY).address, asset: USDC_BASE, cap: "5000000", perPayment: "1000000", recipients: [SHOP], accountant: issuer, purpose: "test agent budget", notAfter: "2030-01-01T00:00:00Z", nonce: "m1", ...over };
  return { mandate, MANDATE: JSON.stringify({ mandate, alg: "Ed25519", sig: edSign(null, Buffer.from("x402-mandate/1\n" + jcs(mandate)), privateKey).toString("base64url") }) };
}

test("MANDATE: x402 payments carry its binding and the check carries the mandate; wallet_status shows it", async () => {
  const { mandate, MANDATE } = mandateEnv();
  const { call, net } = await setup({ MANDATE });
  const r = await call("pay_x402", { url: API });
  assert.equal(r.error, false, r.text);
  const sent = net.checks[0].mandate;
  assert.ok(sent && sent.paymentId);
  const nonce = net.paid[0].payload.authorization.nonce;
  assert.equal(nonce, mandateBinding(mandateDigest(mandate), sent.paymentId));
  const status = JSON.parse((await call("wallet_status")).text);
  assert.equal(status.mandate.digest, mandateDigest(mandate));
  assert.equal(status.mandate.cap, "5000000");
});

test("MANDATE that is not a signed x402-mandate/1 grant is refused at start", () => {
  assert.throws(() => configFromEnv({ ...ENV, MANDATE: "{nope" }), /MANDATE must be JSON/);
  assert.throws(() => configFromEnv({ ...ENV, MANDATE: JSON.stringify({ mandate: { v: "x" }, alg: "Ed25519", sig: "s" }) }), /MANDATE must be/);
});

test("wallet server: the mandate the owner set there is fetched and used for x402 payments", async () => {
  const { mandate, MANDATE } = mandateEnv();
  const net = network({ mandate: JSON.parse(MANDATE) });
  const fake = fakeWallet();
  const wallet = createWallet(configFromEnv({ AGENT_KEY: KEY, WALLET_SERVER_URL: "https://wallet.test", WALLET_SERVER_KEY: "awk_test" }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(wallet).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const r = await client.callTool({ name: "pay_x402", arguments: { url: API } });
  assert.equal(!!r.isError, false, r.content[0].text);
  const asked = net.server.find(([path]) => path.startsWith("/v1/mandate"));
  assert.match(asked[0], /address=0x/);
  const sent = net.checks.find((c) => c.mandate)?.mandate;
  assert.ok(sent);
  assert.equal(net.paid[0].payload.authorization.nonce, mandateBinding(mandateDigest(mandate), sent.paymentId));
  const status = JSON.parse((await client.callTool({ name: "wallet_status", arguments: {} })).content[0].text);
  assert.equal(status.mandate.from, "wallet server");
});

test("XRPL: an RLUSD offer with a t54 invoice is paid from the agent's XRPL account, checked and counted toward USDC", async () => {
  const { call, net, fake, spends } = await setup({ XRPL_SEED }, { xrplAccepts: [rlusdOffer("0.02", { invoiceId: "xrpl.example.test GET /data", sourceTag: 804681468, facilitator: { id: "t54", name: "t54" } })] });
  const r = await call("pay_x402", { url: XRPL_API });
  assert.equal(r.error, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.paid, true);
  assert.equal(out.payment.transaction, "XRPLHASH");
  // The payload in t54's shape: the signed blob and the invoice.
  assert.deepEqual(net.paid[0].payload, { signedTxBlob: "12000022", invoiceId: "xrpl.example.test GET /data" });
  // The signed Payment: RLUSD as a hex currency, the invoice in Memos and InvoiceID, the SourceTag, the facilitator memo.
  const [[kind, tx]] = fake.sent;
  assert.equal(kind, "xrpl.sign");
  assert.equal(tx.TransactionType, "Payment");
  assert.equal(tx.Account, XRPL_AGENT);
  assert.equal(tx.Destination, XRPL_SHOP);
  assert.deepEqual(tx.Amount, { currency: RLUSD, issuer: RIPPLE, value: "0.02" });
  assert.equal(tx.SourceTag, 804681468);
  assert.equal(tx.Memos[0].Memo.MemoData, Buffer.from("xrpl.example.test GET /data").toString("hex").toUpperCase());
  assert.deepEqual(JSON.parse(Buffer.from(tx.Memos[1].Memo.MemoData, "hex").toString()), { id: "t54", name: "t54", sourceTag: 804681468 });
  assert.match(tx.InvoiceID, /^[0-9A-F]{64}$/);
  // presign-guard saw it first (type xrpl), and it counted as USDC.
  assert.equal(net.checks.length, 1);
  assert.equal(net.checks[0].type, "xrpl");
  assert.equal(net.checks[0].network, "xrpl:0");
  assert.equal(spends.at(-1)?.token ?? spends.at(-1)?.symbol ?? "USDC", "USDC");
});

test("XRPL: without an invoice it is @x402/xrpl's plain payload; RLUSD written as text is turned into its hex code", async () => {
  const { call, net, fake } = await setup({ XRPL_SEED }, { xrplAccepts: [{ ...rlusdOffer("0.01"), asset: "RLUSD" }] });
  const r = await call("pay_x402", { url: XRPL_API });
  assert.equal(r.error, false, r.text);
  assert.deepEqual(net.paid[0].payload, { signedTxBlob: "12000022" });
  const tx = fake.sent[0][1];
  assert.equal(tx.Amount.currency, RLUSD);
  assert.equal(tx.Memos, undefined);
});

test("XRPL: XRP, fake RLUSD and a price above the cap are never paid; with Base offered too, USDC on Base goes first", async () => {
  for (const accepts of [
    [{ scheme: "exact", network: "xrpl:0", amount: "20000", asset: "XRP", payTo: XRPL_SHOP, maxTimeoutSeconds: 60, extra: { areFeesSponsored: false } }],
    [rlusdOffer("0.02", { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" })],
    [rlusdOffer("2")],
  ]) {
    const { call, net, fake } = await setup({ XRPL_SEED, MAX_PAYMENT_USD: "1" }, { xrplAccepts: accepts });
    const r = await call("pay_x402", { url: XRPL_API });
    assert.equal(r.error, true, `paid ${JSON.stringify(accepts)}`);
    assert.equal(net.paid.length, 0);
    assert.equal(fake.sent.length, 0);
  }
  const { call, net, fake } = await setup({ XRPL_SEED }, { xrplAndBase: true });
  assert.equal((await call("pay_x402", { url: XRPL_API })).error, false);
  assert.equal(net.paid[0].accepted.network, "eip155:8453");
  assert.deepEqual(fake.sent, [["signTypedData", "TransferWithAuthorization"]]);
});

test("XRPL: off without XRPL_SEED; a bad seed or network is refused; wallet_status shows the XRPL account", async () => {
  const off = await setup({}, {});
  assert.equal((await off.call("pay_x402", { url: XRPL_API })).error, true);
  assert.equal(off.fake.sent.length, 0);
  assert.throws(() => configFromEnv({ ...ENV, XRPL_SEED: "not-a-seed" }), /XRPL_SEED/);
  assert.throws(() => configFromEnv({ ...ENV, XRPL_SEED, XRPL_NETWORK: "devnet" }), /XRPL_NETWORK/);
  assert.equal(configFromEnv({ ...ENV, XRPL_SEED, XRPL_NETWORK: "testnet" }).xrpl.net, "testnet");
  const { call } = await setup({ XRPL_SEED });
  const st = JSON.parse((await call("wallet_status")).text);
  assert.equal(st.xrpl.address, XRPL_AGENT);
  assert.match(st.xrpl.network, /xrpl:0/);
});
