// The MCP server against the PayPal sandbox (test money only), the way an MCP client uses it: two customers pay by
// card, then over MCP a refund within the limits runs, one over the limit asks the owner in the chat app (here a
// scripted owner who approves), a refund of a payment already refunded is stopped, and a read passes.
//   PAYPAL_SANDBOX_CLIENT_ID=… PAYPAL_SANDBOX_SECRET=… node test/sandbox.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cardPayment, brief, creds } from "../../paypal-guard/sandbox/api.mjs";
import { paypalReader } from "fizzl-paypal-guard";

const { clientId, clientSecret } = creds();
const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

const pay = async (email, value, description) => {
  const p = await cardPayment({ email, value, currency: "USD", description });
  if (!p.ok) throw new Error(`card payment for ${email} failed at ${p.step}: ${brief(p.r)}`);
  log(`paid: ${email} ${value} USD, capture ${p.captureId}`);
  return p;
};
const [alice, carol] = await Promise.all([pay("alice@example.com", "12.00", "Mug, blue"), pay("carol@example.com", "300.00", "Lamp")]);

const dir = mkdtempSync(join(tmpdir(), "ppg-mcp-sandbox-"));
const asked = [];
const client = new Client({ name: "sandbox-check", version: "1.0.0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => { asked.push(req.params.message); return { action: "accept", content: { decision: "Approve" } }; });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [new URL("../server.js", import.meta.url).pathname, "--tools=all"],
  env: { PATH: process.env.PATH, PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PAYPAL_ENVIRONMENT: "SANDBOX", GUARD_STATE_DIR: dir },
  stderr: "inherit",
}));
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = res.content?.[0]?.text ?? "";
  let body = null; try { body = JSON.parse(text); } catch {}
  log(`${name} ${JSON.stringify(args)} -> ${res.isError ? "error: " : ""}${text.replace(/\s+/g, " ").slice(0, 300)}`);
  return { res, body, text };
};

try {
  const { tools } = await client.listTools();
  log(`${tools.length} tools listed`);
  if (tools.length !== 49) fail(`expected 47 toolkit tools and 2 guard tools, got ${tools.length}`);

  const order = await call("get_order", { id: alice.orderId });
  if (order.body?.id !== alice.orderId) fail("get_order didn't pass through");

  const own = await call("create_refund", { capture_id: alice.captureId, amount: { currency_code: "USD", value: "12.00" } });
  if (own.res.isError || own.body?.status !== "COMPLETED") fail("Alice's 12.00 refund (within the limits) should have run");

  const big = await call("create_refund", { capture_id: carol.captureId });
  if (big.res.isError || !["COMPLETED", "PENDING"].includes(big.body?.status)) fail("Carol's 300.00 refund should have run after the owner's approval");
  if (asked.length !== 1 || !/refund 300\.00 USD/.test(asked[0])) fail(`the owner should have been asked once about 300.00 USD, was asked: ${JSON.stringify(asked)}`);

  const again = await call("create_refund", { capture_id: alice.captureId });
  if (!again.body?.blocked || !/already refunded in full/.test(again.body.message)) fail("a refund of Alice's payment, already refunded in full, should be stopped");

  const status = await call("paypal_guard_status", {});
  if (status.body?.today?.used?.refund?.total !== "312.00") fail(`today's refunds should come to 312.00, are ${status.body?.today?.used?.refund?.total}`);

  const reader = paypalReader({ clientId, clientSecret, sandbox: true });
  const [a, c] = await Promise.all([reader.capture(alice.captureId), reader.capture(carol.captureId)]);
  log(`at PayPal: alice refunded ${a.refunded} of ${a.amount}, carol refunded ${c.refunded} of ${c.amount}`);
  if (a.refunded !== "12.00" || c.refunded !== "300.00") fail("PayPal should show both refunds");
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
log(process.exitCode ? "sandbox check FAILED" : "sandbox check passed");
