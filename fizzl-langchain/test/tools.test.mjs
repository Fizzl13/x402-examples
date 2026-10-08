// The tools against a stand-in fetch (no network, no money), and inside a LangGraph agent with a scripted
// chat model that calls one of them.
import test from "node:test";
import assert from "node:assert/strict";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { fizzlTools, PRICES, VERSION } from "../index.js";

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

test("five LangChain tools with name, description and schema; `only` picks, unknown names throw", () => {
  const tools = fizzlTools({ fetch: async () => new Response("{}") });
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(PRICES).sort());
  for (const t of tools) { assert.match(t.description, /\$0\.0/); assert.ok(t.schema); assert.equal(typeof t.invoke, "function"); }
  assert.deepEqual(fizzlTools({ only: ["check_token"] }).map((t) => t.name), ["check_token"]);
  assert.throws(() => fizzlTools({ only: ["nope"] }), /unknown Fizzl tool/);
});

test("calls the right API with credit keys and its own user agent, answers JSON without the receipt", async () => {
  const s = standIn({
    "/v1/check": [200, { verdict: "red", reasons: [{ code: "known_drainer" }], receipt: { signature: "0x…" } }],
    "/api/v1/preflight": [200, { verdict: "caution" }],
  });
  const [signing, , , , endpoint] = fizzlTools({ fetch: s.fetch, creditKeys: { presign: "pk", doctor: "dk" } });
  const out = await signing.invoke({ type: "approval", chainId: 8453, token: "0xa", spender: "0xb", amount: "1" });
  assert.equal(typeof out, "string");
  assert.deepEqual(JSON.parse(out), { verdict: "red", reasons: [{ code: "known_drainer" }] });
  assert.equal(s.calls[0].url, "https://presign-guard.fizzl.eu/v1/check");
  assert.equal(s.calls[0].headers["x-credit-key"], "pk");
  assert.equal(s.calls[0].headers["user-agent"], `fizzl-langchain/${VERSION}`);
  assert.equal(JSON.parse(await endpoint.invoke({ url: "https://api.example.com/x", max_usd: 0.05 })).verdict, "caution");
  assert.equal(s.calls[1].url, "https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fapi.example.com%2Fx&max_usd=0.05");
  assert.equal(s.calls[1].headers["x-credit-key"], "dk");
});

test("unpaid: the free quick check answers with a note; failures come back as { error }", async () => {
  const s = standIn({ "/v1/token": [402, {}], "/v1/token/quick": [200, { verdict: "green" }], "/v1/approvals": [500, { error: "boom" }] });
  const tools = Object.fromEntries(fizzlTools({ fetch: s.fetch }).map((t) => [t.name, t]));
  const free = JSON.parse(await tools.check_token.invoke({ chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }));
  assert.equal(free.verdict, "green");
  assert.equal(free.free, true);
  assert.match(free.note, /\$0\.01/);
  assert.deepEqual(JSON.parse(await tools.check_wallet_approvals.invoke({ chain: "base", address: "0x6B0F4651eD42893ab58139938175E4a69f175F25" })), { error: "http_500", message: "boom" });
  const [down] = fizzlTools({ fetch: async () => { throw new TypeError("fetch failed"); }, only: ["check_endpoint_before_paying"] });
  assert.deepEqual(JSON.parse(await down.invoke({ url: "https://a.example" })), { error: "check_failed", message: "TypeError: fetch failed" });
});

test("bad input from the model is refused before any call", async () => {
  const s = standIn({});
  const [approvals] = fizzlTools({ fetch: s.fetch, only: ["check_wallet_approvals"] });
  await assert.rejects(approvals.invoke({ chain: "base", address: "not-an-address" }));
  assert.equal(s.calls.length, 0);
});

// A chat model that first asks for check_token, then answers with what the tool said.
class Scripted extends BaseChatModel {
  _llmType() { return "scripted"; }
  bindTools() { return this; }
  async _generate(messages) {
    const last = messages.at(-1);
    const message = last._getType() === "tool"
      ? new AIMessage(`The check says: ${JSON.parse(last.content).verdict}`)
      : new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "check_token", args: { chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" } }] });
    return { generations: [{ message, text: String(message.content) }] };
  }
}

test("works inside a LangGraph agent", async () => {
  const s = standIn({ "/v1/token": [200, { verdict: "orange", reasons: [{ code: "mint_authority" }] }] });
  const agent = createReactAgent({ llm: new Scripted({}), tools: fizzlTools({ fetch: s.fetch }) });
  const { messages } = await agent.invoke({ messages: [{ role: "user", content: "Is BONK safe to buy?" }] });
  assert.match(s.calls[0].url, /\/v1\/token\?chain=solana&address=Dez/);
  assert.equal(messages.at(-1).content, "The check says: orange");
});
