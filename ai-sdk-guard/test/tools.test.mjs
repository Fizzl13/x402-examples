// The tools against a stand-in fetch (no network, no money), and inside a real AI SDK generateText loop with a
// mock model that calls one of them.
import test from "node:test";
import assert from "node:assert/strict";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { fizzlTools, PRICES } from "../index.js";

function standIn(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname;
    const [status, body] = answers[path] ?? [404, { error: "not found" }];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test("five tools, each with a description, a schema and execute; `only` picks, unknown names throw", () => {
  const t = fizzlTools({ fetch: async () => new Response("{}") });
  assert.deepEqual(Object.keys(t).sort(), Object.keys(PRICES).sort());
  for (const v of Object.values(t)) { assert.equal(typeof v.description, "string"); assert.equal(typeof v.execute, "function"); assert.ok(v.inputSchema.safeParse); }
  assert.deepEqual(Object.keys(fizzlTools({ only: ["check_token"] })), ["check_token"]);
  assert.throws(() => fizzlTools({ only: ["nope"] }), /unknown Fizzl tool/);
  // tool() from the AI SDK accepts them as they are.
  assert.equal(tool(t.check_token), t.check_token);
});

test("calls the right API, sends credit keys, leaves the receipt out", async () => {
  const s = standIn({
    "/v1/check": [200, { verdict: "red", reasons: [{ code: "known_drainer" }], receipt: { signature: "0x…" } }],
    "/v1/token": [200, { verdict: "green" }],
    "/v1/approvals": [200, { summary: { toRevoke: 1 } }],
    "/api/v1/preflight": [200, { verdict: "caution", reasons: [{ code: "brand_impersonation" }] }],
  });
  const t = fizzlTools({ fetch: s.fetch, creditKeys: { presign: "pk", doctor: "dk" } });
  const r = await t.check_before_signing.execute({ type: "approval", chainId: 8453, token: "0xa", spender: "0xb", amount: "1" });
  assert.deepEqual(r, { verdict: "red", reasons: [{ code: "known_drainer" }] });
  assert.equal(s.calls[0].method, "POST");
  assert.equal(s.calls[0].url, "https://presign-guard.fizzl.eu/v1/check");
  assert.equal(s.calls[0].headers["x-credit-key"], "pk");
  assert.equal(s.calls[0].body.spender, "0xb");
  await t.check_token.execute({ chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" });
  assert.match(s.calls[1].url, /\/v1\/token\?chain=solana&address=Dez/);
  await t.check_wallet_approvals.execute({ chain: "base", address: "0x6B0F4651eD42893ab58139938175E4a69f175F25" });
  assert.match(s.calls[2].url, /\/v1\/approvals\?chain=base&address=0x6B0F/);
  const p = await t.check_endpoint_before_paying.execute({ url: "https://api.example.com/x", max_usd: 0.05, network: "eip155:8453" });
  assert.equal(p.verdict, "caution");
  assert.equal(s.calls[3].url, "https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fapi.example.com%2Fx&max_usd=0.05&network=eip155%3A8453");
  assert.equal(s.calls[3].headers["x-credit-key"], "dk");
});

test("failures come back as { error } for the model, never thrown", async () => {
  const t = fizzlTools({ fetch: standIn({ "/v1/token": [402, {}], "/v1/check": [500, { error: "boom" }], "/v1/approvals": [200, "not json"] }).fetch });
  assert.equal((await t.check_token.execute({ chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })).error, "payment_required");
  assert.deepEqual(await t.check_before_signing.execute({ type: "transaction", chainId: 1, to: "0x1" }), { error: "http_500", message: "boom" });
  assert.equal((await t.check_wallet_approvals.execute({ chain: "base", address: "0x6B0F4651eD42893ab58139938175E4a69f175F25" })).error, "bad_response");
  const down = fizzlTools({ fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(await down.check_endpoint_before_paying.execute({ url: "https://a.example" }), { error: "check_failed", message: "TypeError: fetch failed" });
});

test("free fallback: unpaid checks answer with the free quick check, marked free, unless free: false", async () => {
  const s = standIn({
    "/v1/token": [402, {}], "/v1/token/quick": [200, { verdict: "green", grade: "SAFE", note: "Verdict only." }],
    "/v1/check": [402, {}], "/mcp": [200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ verdict: "red", note: "Verdict only." }) }] } }],
    "/api/v1/preflight": [402, {}], "/api/diagnose": [200, { overall: "fail", share_url: "https://x402-doctor.fizzl.eu/?url=x", checks: [{ id: "a", status: "pass", message: "ok" }, { id: "b", status: "fail", message: "no payTo" }] }],
    "/v1/approvals": [402, {}],
  });
  const t = fizzlTools({ fetch: s.fetch });
  const tok = await t.check_token.execute({ chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
  assert.equal(tok.verdict, "green"); assert.equal(tok.free, true); assert.match(tok.note, /\$0\.01/); assert.match(tok.payment, /paid/);
  const sig = await t.check_before_signing.execute({ type: "approval", chainId: 8453, token: "0xa", spender: "0xb", amount: "1" });
  assert.equal(sig.verdict, "red"); assert.equal(sig.free, true);
  const mcp = s.calls.find((c) => c.url.endsWith("/mcp"));
  assert.equal(mcp.body.params.name, "presign_quick_check"); assert.equal(mcp.body.params.arguments.spender, "0xb");
  const ep = await t.check_endpoint_before_paying.execute({ url: "https://api.example.com/x" });
  assert.equal(ep.verdict, "no_go"); assert.deepEqual(ep.problems, [{ status: "fail", id: "b", message: "no payTo" }]); assert.match(ep.note, /\$0\.001/);
  assert.equal((await t.check_wallet_approvals.execute({ chain: "base", address: "0x6B0F4651eD42893ab58139938175E4a69f175F25" })).error, "payment_required");
  const off = fizzlTools({ fetch: s.fetch, free: false });
  assert.equal((await off.check_token.execute({ chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })).error, "payment_required");
});

test("check_token takes chain algorand with an asset id; other chains still need a full address", async () => {
  const s = standIn({ "/v1/token": [200, { verdict: "green", grade: "SAFE" }] });
  const t = fizzlTools({ fetch: s.fetch });
  await t.check_token.execute({ chain: "algorand", address: "31566704" });
  assert.match(s.calls[0].url, /\/v1\/token\?chain=algorand&address=31566704$/);
  const schema = t.check_token.inputSchema;
  assert.equal(schema.safeParse({ chain: "algorand", address: "312769" }).success, true);
  assert.equal(schema.safeParse({ chain: "algorand", address: "ALGO" }).success, false);
  assert.equal(schema.safeParse({ chain: "algorand", address: "0" }).success, false);
  assert.equal(schema.safeParse({ chain: "base", address: "31566704" }).success, false, "a short address on an EVM chain");
});

test("XRPL: check_xrpl_transaction posts type xrpl; check_token takes chain xrpl", async () => {
  const s = standIn({ "/v1/check": [200, { verdict: "red", reasons: [{ code: "XRPL_REGULAR_KEY_CHANGE" }] }], "/v1/token": [200, { verdict: "green" }] });
  const t = fizzlTools({ fetch: s.fetch });
  const tx = { TransactionType: "SetRegularKey", Account: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32", RegularKey: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv" };
  assert.equal((await t.check_xrpl_transaction.execute({ tx })).verdict, "red");
  assert.deepEqual(s.calls[0].body, { type: "xrpl", tx });
  assert.equal(t.check_xrpl_transaction.inputSchema.safeParse({ tx: { Account: "r…" } }).success, false);
  await t.check_token.execute({ chain: "xrpl", address: "RLUSD.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" });
  assert.match(s.calls[1].url, /chain=xrpl&address=RLUSD/);
});

test("check_before_signing passes from (simulation), intent and the x402 requirements to presign-guard", async () => {
  const s = standIn({ "/v1/check": [200, { verdict: "orange", reasons: [{ code: "SIMULATION_FAILS" }] }] });
  const t = fizzlTools({ fetch: s.fetch });
  const from = "0x" + "12".repeat(20);
  const accepted = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "34".repeat(20) };
  const input = { type: "transaction", chainId: 8453, from, to: "0x1", data: "0x", intent: "send 1 USDC to Bob" };
  assert.equal(t.check_before_signing.inputSchema.safeParse(input).success, true);
  await t.check_before_signing.execute(input);
  assert.equal(s.calls[0].body.from, from);
  assert.equal(s.calls[0].body.intent, "send 1 USDC to Bob");
  await t.check_before_signing.execute({ type: "signature", chainId: 8453, typedData: {}, x402: { accepted } });
  assert.deepEqual(s.calls[1].body.x402, { accepted });
  assert.equal(t.check_before_signing.inputSchema.safeParse({ ...input, from: "0x12" }).success, false);
  assert.equal(t.check_before_signing.inputSchema.safeParse({ ...input, intent: "x".repeat(501) }).success, false);
});

test("screen_wallet: any chain's address to /v1/screen; a bad address is refused before paying; no free fallback", async () => {
  const s = standIn({ "/v1/screen": [200, { verdict: "red", one_liner: "AVOID: on the OFAC SDN list (X)", receipt: {} }] });
  const t = fizzlTools({ fetch: s.fetch, creditKeys: { presign: "pk" } });
  for (const address of ["TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81", "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", "bc1qjzk63wwatq2f638psymq3qapn00aqgksyx56l3t8eg7zuuccwasq498khf"]) {
    assert.equal(t.screen_wallet.inputSchema.safeParse({ address }).success, true, address);
  }
  assert.deepEqual(await t.screen_wallet.execute({ address: "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81" }), { verdict: "red", one_liner: "AVOID: on the OFAC SDN list (X)" });
  assert.equal(s.calls[0].url, "https://presign-guard.fizzl.eu/v1/screen?address=TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81");
  assert.equal(s.calls[0].headers["x-credit-key"], "pk");
  assert.equal(t.screen_wallet.inputSchema.safeParse({ address: "0x12" }).success, false);
  assert.equal(t.screen_wallet.inputSchema.safeParse({ address: "<script>alert(1)</script>" }).success, false);
  const unpaid = fizzlTools({ fetch: standIn({ "/v1/screen": [402, {}] }).fetch });
  assert.equal((await unpaid.screen_wallet.execute({ address: "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81" })).error, "payment_required");
  assert.equal(PRICES.screen_wallet, "$0.01");
});

test("schemas refuse bad input before anything is paid", () => {
  const t = fizzlTools();
  assert.equal(t.check_before_signing.inputSchema.safeParse({ type: "approval", chainId: 999 }).success, false);
  assert.equal(t.check_wallet_approvals.inputSchema.safeParse({ chain: "base", address: "0x12" }).success, false);
  assert.equal(t.check_endpoint_before_paying.inputSchema.safeParse({ url: "not a url" }).success, false);
  assert.equal(t.check_token.inputSchema.safeParse({ chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" }).success, true);
});

test("inside generateText: the model calls check_endpoint_before_paying and gets the verdict back", async () => {
  const s = standIn({ "/api/v1/preflight": [200, { verdict: "no_go", summary: "Do not pay: over budget." }] });
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
      if (step === 1) return { content: [{ type: "tool-call", toolCallId: "c1", toolName: "check_endpoint_before_paying", input: JSON.stringify({ url: "https://api.example.com/x", max_usd: 0.01 }) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage, warnings: [] };
      return { content: [{ type: "text", text: "Not paying: Doctor says no_go." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
    },
  });
  const r = await generateText({ model, tools: fizzlTools({ fetch: s.fetch }), prompt: "Buy the data at https://api.example.com/x for at most $0.01", stopWhen: stepCountIs(3) });
  assert.equal(r.text, "Not paying: Doctor says no_go.");
  const results = r.steps.flatMap((x) => x.toolResults);
  assert.equal(results[0].toolName, "check_endpoint_before_paying");
  assert.equal(results[0].output.verdict, "no_go");
  assert.match(s.calls[0].url, /max_usd=0.01/);
});

test("Algorand: check_algorand_transaction posts type algorand with one transaction or a group, and falls back to the free check", async () => {
  const s = standIn({ "/v1/check": [200, { verdict: "red", reasons: [{ code: "ALGORAND_REKEY" }] }] });
  const t = fizzlTools({ fetch: s.fetch });
  const transaction = "iqNhbXTOAA9CQKNmZWXNA+iiZnbOAAAD6KNnZW6sbWFpbm5ldC12MS4w";
  assert.equal((await t.check_algorand_transaction.execute({ transaction, intent: "pay 1 ALGO" })).verdict, "red");
  assert.deepEqual(s.calls[0].body, { type: "algorand", transaction, intent: "pay 1 ALGO" });
  await t.check_algorand_transaction.execute({ transactions: [transaction, transaction] });
  assert.deepEqual(s.calls[1].body, { type: "algorand", transactions: [transaction, transaction] });
  const schema = t.check_algorand_transaction.inputSchema;
  assert.equal(schema.safeParse({}).success, false, "one of transaction or transactions");
  assert.equal(schema.safeParse({ transaction, transactions: [transaction] }).success, false, "not both");
  assert.equal(schema.safeParse({ transaction: "not base64!" }).success, false);
  assert.equal(schema.safeParse({ transactions: Array(17).fill(transaction) }).success, false, "a group holds at most 16");
  assert.equal(schema.safeParse({ transaction, from: "0x12" }).success, false);

  const unpaid = standIn({ "/v1/check": [402, {}], "/mcp": [200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ verdict: "red" }) }] } }] });
  const free = await fizzlTools({ fetch: unpaid.fetch }).check_algorand_transaction.execute({ transaction });
  assert.equal(free.verdict, "red");
  assert.equal(unpaid.calls[1].body.params.arguments.type, "algorand");
});

test("Solana and messages: check_solana_transaction posts type solana, check_message type message; both fall back to the free check", async () => {
  const s = standIn({ "/v1/check": [200, { verdict: "red", reasons: [{ code: "SOLANA_TOKEN_ACCOUNT_TAKEOVER" }] }] });
  const t = fizzlTools({ fetch: s.fetch });
  const transaction = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  assert.equal((await t.check_solana_transaction.execute({ transaction, intent: "pay 1 USDC" })).verdict, "red");
  assert.deepEqual(s.calls[0].body, { type: "solana", transaction, intent: "pay 1 USDC" });
  assert.equal(t.check_solana_transaction.inputSchema.safeParse({ transaction: "not base64!" }).success, false);
  assert.equal(t.check_solana_transaction.inputSchema.safeParse({ transaction, from: "0x12" }).success, false);
  await t.check_message.execute({ message: "hello", origin: "https://app.example" });
  assert.deepEqual(s.calls[1].body, { type: "message", message: "hello", origin: "https://app.example" });
  assert.equal(t.check_message.inputSchema.safeParse({ message: "x", method: "eth_signTypedData" }).success, false);

  const unpaid = standIn({ "/v1/check": [402, {}], "/mcp": [200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ verdict: "red" }) }] } }] });
  const u = fizzlTools({ fetch: unpaid.fetch });
  const free = await u.check_message.execute({ message: "x", method: "eth_sign" });
  assert.equal(free.free, true);
  assert.deepEqual(unpaid.calls.find((c) => c.url.endsWith("/mcp")).body.params.arguments, { type: "message", message: "x", method: "eth_sign" });
});
