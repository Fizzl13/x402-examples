import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, fileStore, configFromEnv, serverFromConfig, ALL_TOOLS, INSTRUCTIONS } from "../lib.js";

// A pretend PayPal: three card payments, and the toolkit's tools the way its AI SDK export gives them.
function fakePaypal() {
  const captures = {
    CAP0000000000000A: { amount: "12.00", currency: "USD", refunded: "0.00", payer: "alice@example.com" },
    CAP0000000000000C: { amount: "300.00", currency: "USD", refunded: "0.00", payer: "carol@example.com" },
    CAP0000000000000B: { amount: "30.00", currency: "USD", refunded: "30.00", payer: "bob@example.com" },
  };
  const calls = [];
  const money = z.object({ currency_code: z.string(), value: z.string() });
  const tools = {
    get_order: { description: "\nRetrieves the order details.\n", parameters: z.object({ id: z.string() }), execute: async (a) => { calls.push(["get_order", a]); return JSON.stringify({ id: a.id, status: "COMPLETED" }); } },
    create_refund: {
      description: "Initiate a refund for a PayPal payment capture.",
      parameters: z.object({ capture_id: z.string().regex(/^[A-Za-z0-9_-]{15,32}$/).describe("The ID of the capture to refund."), amount: money.optional() }),
      execute: async (a) => {
        calls.push(["create_refund", a]);
        const c = captures[a.capture_id];
        if (!c) return JSON.stringify({ error: { message: "RESOURCE_NOT_FOUND", type: "paypal_error" } });
        c.refunded = (Number(c.refunded) + Number(a.amount?.value ?? Number(c.amount) - Number(c.refunded))).toFixed(2);
        return JSON.stringify({ id: `RF${calls.length}`, status: "COMPLETED" });
      },
    },
    accept_dispute_claim: { description: "Accept a dispute claim.", parameters: z.object({ dispute_id: z.string(), note: z.string() }), execute: async (a) => { calls.push(["accept_dispute_claim", a]); return "{}"; } },
  };
  const reader = { capture: async (id) => (captures[id] ? { ...captures[id] } : null), dispute: async () => ({ amount: "50.00", currency: "USD" }) };
  return { tools, reader, calls, captures };
}

async function connect(server, { elicit = null } = {}) {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const body = (res) => JSON.parse(res.content[0].text);
const refund = (capture_id, value) => ({ name: "create_refund", arguments: { capture_id, ...(value ? { amount: { currency_code: "USD", value } } : {}) } });

test("lists the PayPal tools with JSON schemas and hints, the guard's own tools, and instructions", async () => {
  const pp = fakePaypal();
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["get_order", "create_refund", "accept_dispute_claim", "paypal_guard_status", "paypal_guard_check"]);
  const r = tools.find((t) => t.name === "create_refund");
  assert.equal(r.inputSchema.type, "object");
  assert.deepEqual(r.inputSchema.required, ["capture_id"]);
  assert.equal(r.inputSchema.properties.capture_id.description, "The ID of the capture to refund.");
  assert.equal(r.annotations.destructiveHint, true);
  assert.match(r.description, /Checked by fizzl-paypal-guard before it runs: never more than is left of the payment/);
  const o = tools.find((t) => t.name === "get_order");
  assert.equal(o.annotations.readOnlyHint, true);
  assert.equal(o.description, "Retrieves the order details.");
  assert.match(tools.find((t) => t.name === "accept_dispute_claim").description, /the owner approves or denies each one/);
  assert.equal(client.getInstructions(), INSTRUCTIONS);
});

test("a read passes straight through; a refund within the limits runs", async () => {
  const pp = fakePaypal();
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false }));
  const read = await client.callTool({ name: "get_order", arguments: { id: "O-1" } });
  assert.equal(body(read).status, "COMPLETED");
  const res = await client.callTool(refund("CAP0000000000000A", "12.00"));
  assert.equal(res.isError, undefined);
  assert.equal(body(res).status, "COMPLETED");
  assert.equal(pp.captures.CAP0000000000000A.refunded, "12.00");
});

test("over a limit with no way to ask the owner, and a refund of a payment already refunded: not done", async () => {
  const pp = fakePaypal();
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false }));
  const big = await client.callTool(refund("CAP0000000000000C"));
  assert.equal(big.isError, true);
  assert.equal(body(big).blocked, true);
  assert.match(body(big).message, /needs the shop owner's OK.*300\.00 USD is over the limit of 25\.00 USD per refund/);
  const twice = await client.callTool(refund("CAP0000000000000B"));
  assert.match(body(twice).message, /already refunded in full/);
  const dispute = await client.callTool({ name: "accept_dispute_claim", arguments: { dispute_id: "PP-D-1", note: "ok" } });
  assert.equal(body(dispute).blocked, true);
  assert.deepEqual(pp.calls, []);
});

test("bad arguments are refused by the toolkit's own schema, before the guard or PayPal", async () => {
  const pp = fakePaypal();
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false }));
  const res = await client.callTool({ name: "create_refund", arguments: { capture_id: "x" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Arguments for create_refund don't fit: capture_id/);
  const none = await client.callTool({ name: "send_money", arguments: {} });
  assert.match(none.content[0].text, /There is no PayPal tool send_money/);
  assert.deepEqual(pp.calls, []);
});

test("the owner approves or denies in the chat app (MCP elicitation)", async () => {
  const pp = fakePaypal();
  const asked = [];
  let answer = "Approve";
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader }), { elicit: async (req) => { asked.push(req.params.message); return { action: "accept", content: { decision: answer } }; } });
  const yes = await client.callTool(refund("CAP0000000000000C", "300.00"));
  assert.equal(body(yes).status, "COMPLETED");
  assert.match(asked[0], /^test-client \(PayPal MCP\) wants to refund 300\.00 USD to carol@example\.com \(capture CAP0000000000000C\)/);
  assert.match(asked[0], /over the limit of 25\.00 USD per refund/);
  answer = "Deny";
  const no = await client.callTool({ name: "accept_dispute_claim", arguments: { dispute_id: "PP-D-1", note: "ok" } });
  assert.equal(body(no).blocked, true);
  assert.match(body(no).message, /the shop owner didn't approve it/);
  assert.deepEqual(pp.calls.map(([t]) => t), ["create_refund"]);
  const status = body(await client.callTool({ name: "paypal_guard_status", arguments: {} }));
  assert.equal(status.approvals, "chat");
  assert.deepEqual(status.today.used.refund, { total: "300.00", count: 1 });
  assert.deepEqual(status.recent.map((e) => e.outcome), ["asked", "done", "asked", "blocked"]);
  assert.equal(status.recent[1].approvedBy, "the owner, in the chat app");
});

test("a phone approval that takes longer than the call waits: 'waiting', and it runs once approved", async () => {
  const pp = fakePaypal();
  let decide;
  const approve = Object.assign(() => new Promise((r) => { decide = r; }), { channel: "Telegram" });
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader, approve, waitMs: 50 }));
  const res = await client.callTool(refund("CAP0000000000000C", "300.00"));
  const w = body(res);
  assert.equal(w.waiting, true);
  assert.match(w.message, /Waiting for the shop owner's OK to refund 300\.00 USD to carol@example\.com.*Don't call this again/);
  assert.deepEqual(pp.calls, []);
  let s = body(await client.callTool({ name: "paypal_guard_status", arguments: {} }));
  assert.equal(s.approvals, "Telegram");
  assert.deepEqual(s.waiting.map((x) => x.approvalId), [w.approvalId]);
  decide({ approved: true, by: "telegram:owner" });
  await new Promise((r) => setTimeout(r, 20));
  s = body(await client.callTool({ name: "paypal_guard_status", arguments: { approval_id: w.approvalId } }));
  assert.equal(s.status, "done");
  assert.match(s.result, /COMPLETED/);
  assert.equal(pp.captures.CAP0000000000000C.refunded, "300.00");
});

test("the customer an app serves comes with the request (_meta), not from the model: someone else's payment is stopped", async () => {
  const pp = fakePaypal();
  const client = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false }));
  const res = await client.callTool({ ...refund("CAP0000000000000C", "10.00"), _meta: { "fizzl.eu/customer": "alice@example.com", "fizzl.eu/request": "Refund my husband's lamp" } });
  assert.equal(body(res).blocked, true);
  assert.match(body(res).message, /this is for carol@example\.com, not for alice@example\.com/);
  const own = await client.callTool({ ...refund("CAP0000000000000A", "12.00"), _meta: { "fizzl.eu/customer": "alice@example.com" } });
  assert.equal(body(own).status, "COMPLETED");
  const dry = body(await client.callTool({ name: "paypal_guard_check", arguments: { tool: "create_refund", arguments: { capture_id: "CAP0000000000000C" } } }));
  assert.equal(dry.decision, "ask");
  assert.deepEqual(dry.reasons.map((r) => r.code), ["PER_ACTION", "PER_DAY"]);
  assert.deepEqual(pp.calls.map(([t, a]) => a.capture_id), ["CAP0000000000000A"]);
});

test("the day's limits survive a restart of the MCP client (the counts are kept in a file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ppg-mcp-"));
  try {
    const pp = fakePaypal(), file = join(dir, "limits.json"), logFile = join(dir, "log.jsonl");
    const first = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false, store: fileStore(file), logFile }));
    assert.equal(body(await first.callTool(refund("CAP0000000000000C", "10.00"))).status, "COMPLETED");
    const again = await connect(createServer({ tools: pp.tools, reader: pp.reader, chat: false, store: fileStore(file), logFile }));
    const res = body(await again.callTool(refund("CAP0000000000000C", "10.00")));
    assert.equal(res.blocked, true);
    assert.match(res.message, /already refunded once today/);
    const s = body(await again.callTool({ name: "paypal_guard_status", arguments: {} }));
    assert.deepEqual(s.today.used.refund, { total: "10.00", count: 1 });
    assert.deepEqual(s.recent.map((e) => e.outcome), ["done", "blocked"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an expired PayPal token: a fresh toolkit tries once more", async () => {
  let builds = 0;
  const make = () => {
    const n = ++builds;
    return { get_order: { description: "Get an order.", parameters: z.object({ id: z.string() }), execute: async (a) => JSON.stringify(n === 1 ? { error: { message: "Request failed with status code 401", type: "paypal_error" } } : { id: a.id }) } };
  };
  let current = null;
  const tools = { get: () => (current ??= make()), reset: () => { current = null; } };
  const client = await connect(createServer({ tools, chat: false }));
  const res = await client.callTool({ name: "get_order", arguments: { id: "O-9" } });
  assert.equal(body(res).id, "O-9");
  assert.equal(builds, 2);
});

test("without credentials it lists all 47 toolkit tools, and each call says how to set it up", async () => {
  const config = configFromEnv({ GUARD_STATE_DIR: "/nonexistent" });
  assert.equal(config.setup, true);
  const client = await connect(serverFromConfig(config));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 49);
  assert.ok(tools.every((t) => t.inputSchema.type === "object" && t.description));
  assert.equal(tools.find((t) => t.name === "list_transactions").annotations.readOnlyHint, true);
  const res = await client.callTool({ name: "list_invoices", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
});

test("configuration from the environment", () => {
  const base = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", GUARD_STATE_DIR: "/tmp/ppg" };
  const c = configFromEnv(base);
  assert.equal(c.setup, false);
  assert.equal(c.sandbox, true);
  assert.equal(c.actions, ALL_TOOLS);
  assert.equal(c.approval.kind, "chat");
  assert.equal(c.limitsFile, "/tmp/ppg/limits.sandbox.json");
  assert.equal(c.waitMs, 45_000);
  assert.equal(configFromEnv({ ...base, PAYPAL_ENVIRONMENT: "production" }).logFile, "/tmp/ppg/log.live.jsonl");
  assert.throws(() => configFromEnv({ ...base, PAYPAL_ENVIRONMENT: "LIVE" }), /SANDBOX or PRODUCTION/);
  assert.deepEqual(configFromEnv(base, ["--tools=payments.createRefund,orders.get"]).actions, { payments: { createRefund: true }, orders: { get: true } });
  assert.deepEqual(configFromEnv(base, ["--tools", "orders.get"]).actions, { orders: { get: true } });
  assert.throws(() => configFromEnv({ ...base, PAYPAL_TOOLS: "payments.sendMoney" }), /Unknown PayPal tool "payments.sendMoney"/);
  const p = configFromEnv({ ...base, LIMIT_REFUND: "50", LIMIT_REFUNDS_PER_DAY: "3", LIMIT_CURRENCY: "eur", GUARD_POLICY: '{"dispute":"deny","refund":{"perDay":"80.00"}}' }).policy;
  assert.deepEqual(p, { dispute: "deny", currency: "EUR", refund: { perDay: "80.00", perAction: "50", countPerDay: 3 } });
  assert.throws(() => configFromEnv({ ...base, LIMIT_REFUND: "ten" }), /LIMIT_REFUND must be an amount/);
  assert.throws(() => configFromEnv({ ...base, LIMIT_REFUND: "0" }), /LIMIT_REFUND must be an amount/);
  assert.throws(() => configFromEnv({ ...base, GUARD_POLICY: '{"dispute":"maybe"}' }), /policy\.dispute/);
  assert.throws(() => configFromEnv({ ...base, GUARD_POLICY: "dispute=deny" }), /GUARD_POLICY must be JSON/);
  assert.throws(() => configFromEnv({ ...base, TELEGRAM_BOT_TOKEN: "123:abc" }), /TELEGRAM_CHAT_ID is required/);
  assert.equal(configFromEnv({ ...base, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }).approval.kind, "telegram");
  assert.throws(() => configFromEnv({ ...base, FIZZL_AGENT_KEY: "sk_live_x" }), /awk_/);
  assert.deepEqual(configFromEnv({ ...base, FIZZL_AGENT_KEY: "awk_abc" }).approval, { kind: "fizzl", key: "awk_abc", url: "https://wallet.fizzl.eu" });
  assert.equal(configFromEnv({ ...base, APPROVAL_IN_CHAT: "off" }).approval.kind, "none");
  assert.equal(configFromEnv({ ...base, APPROVAL_WAIT_SECONDS: "20", APPROVAL_MINUTES: "5" }).approvalMs, 300_000);
});

test("as a Claude Desktop bundle: optional settings left as their ${user_config.…} placeholder count as not set", async () => {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = mkdtempSync(join(tmpdir(), "ppg-mcpb-"));
  try {
    const client = new Client({ name: "bundle", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [new URL("../server.js", import.meta.url).pathname, "--tools=all"],
      env: { PATH: process.env.PATH, GUARD_STATE_DIR: dir, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_ENVIRONMENT: "SANDBOX", FIZZL_AGENT_KEY: "${user_config.fizzl_agent_key}", TELEGRAM_BOT_TOKEN: "${user_config.telegram_bot_token}", LIMIT_REFUND: "25" },
      stderr: "ignore",
    }));
    const status = body(await client.callTool({ name: "paypal_guard_status", arguments: {} }));
    assert.equal(status.approvals, "none"); // no Fizzl key, no Telegram, and this client can't ask in the chat
    assert.equal(status.limits.refund.perAction, "25");
    await client.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
