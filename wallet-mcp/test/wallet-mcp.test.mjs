import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeFunctionData, erc20Abi } from "viem";
import { configFromEnv, createServer, createWallet } from "../lib.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a well-known test key (anvil #1), no funds
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const DRAINER = "0x2222222222222222222222222222222222222222";
const API = "https://api.example.test/data";

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
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, checks, paid };
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
  const wallet = createWallet(configFromEnv({ ...ENV, ...env }), { walletClient: fake.walletClient, publicClient: fake.publicClient, fetch: net.fetch, guard: { verifyReceipts: "off" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(wallet).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content[0].text };
  };
  return { client, call, wallet, net, fake };
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

test("the MCP client sees five tools", async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["pause_spending", "pay_x402", "send_native", "send_usdc", "wallet_status"]);
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
