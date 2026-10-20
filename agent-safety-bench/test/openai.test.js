// The agent for OpenAI-compatible endpoints (OpenAI, OpenRouter) against a stand-in for /chat/completions.

import test from "node:test";
import assert from "node:assert/strict";
import { openaiAgent } from "../src/agents/openai.js";
import { systemPrompt } from "../src/conditions.js";
import { runOnce } from "../src/run.js";
import { SCENARIOS } from "../src/scenarios/index.js";

// Answers with the queued responses in order ({ status, body } or a chat completion) and keeps every request.
function fakeEndpoint(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    const { status = 200, body = next, headers = {} } = next.status ? next : {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { requests, fetch };
}

const completion = (message, finish_reason, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({ choices: [{ message: { role: "assistant", ...message }, finish_reason }], usage });
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

const forecast = SCENARIOS.find((s) => s.id === "honest-forecast");
const URL_ = "https://api.skycast.example/v1/forecast?city=Amsterdam";

test("openai agent: the same tools as functions, results back as tool messages, ends without tool calls", async () => {
  const endpoint = fakeEndpoint([
    completion({ content: "Checking the price.", tool_calls: [call("c1", "http_request", { url: URL_ })] }, "tool_calls"),
    completion({ content: null, tool_calls: [call("c2", "pay_x402", { url: URL_, max_usd: 0.02 })], reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] }, "tool_calls", { prompt_tokens: 300, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 200 } }),
    completion({ content: "Light rain, then dry. Forecast id SKY-7F3K-AMS. Spent $0.01." }, "stop"),
  ]);
  const agent = openaiAgent({ model: "vendor/model", endpoint: "openrouter", apiKey: "k", fetch: endpoint.fetch });
  assert.equal(agent.name, "openrouter:vendor/model");
  const r = await runOnce({ scenario: forecast, condition: "skills", agent });
  assert.equal(r.done, true);
  assert.equal(r.spent_usd, 0.01);
  assert.equal(r.turns, 3);
  assert.equal(r.stop, "stop");
  assert.deepEqual(r.usage, { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 });

  const [first, second, third] = endpoint.requests;
  assert.equal(first.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(first.headers.authorization, "Bearer k");
  assert.equal(first.body.model, "vendor/model");
  assert.deepEqual(first.body.messages, [{ role: "system", content: systemPrompt("skills") }, { role: "user", content: forecast.task }]);
  assert.deepEqual(first.body.tools.map((t) => [t.type, t.function.name]), [["function", "http_request"], ["function", "pay_x402"], ["function", "sign_typed_data"], ["function", "sign_message"], ["function", "sign_authorization"], ["function", "sign_xrpl_transaction"]]);
  assert.equal(first.body.tools[1].function.parameters.required.join(), "url,max_usd");
  const toolMessage = second.body.messages.at(-1);
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "c1");
  assert.equal(JSON.parse(toolMessage.content).status, 402);
  assert.deepEqual(third.body.messages.at(-2).reasoning_details, [{ type: "reasoning.encrypted", data: "x" }], "reasoning goes back with the tool call");
  assert.equal(JSON.parse(third.body.messages.at(-1).content).payment.amount_usd, 0.01);
});

test("openai agent: stops at max_turns; arguments that aren't JSON get an error, not a crash", async () => {
  const looping = fakeEndpoint(Array.from({ length: 2 }, (_, i) => completion({ content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "http_request", arguments: "{not json" } }] }, "tool_calls")));
  const r = await runOnce({ scenario: forecast, condition: "bare", agent: openaiAgent({ model: "m", apiKey: "k", fetch: looping.fetch, maxTurns: 2 }) });
  assert.equal(r.stop, "max_turns");
  assert.equal(r.error, null);
  assert.deepEqual(r.transcript[0].result, { error: "the arguments are not valid JSON" });
  assert.equal(looping.requests[0].url, "https://api.openai.com/v1/chat/completions");
});

test("openai agent: retries a rate limit, records a bad key as the run's error", async () => {
  const flaky = fakeEndpoint([{ status: 429, body: { error: { message: "rate limited" } } }, completion({ content: "No payment needed. Spent $0." }, "stop")]);
  const sleeps = [];
  const ok = await runOnce({ scenario: forecast, condition: "bare", agent: openaiAgent({ model: "m", apiKey: "k", fetch: flaky.fetch, sleep: async (ms) => sleeps.push(ms) }) });
  assert.equal(ok.error, null);
  assert.deepEqual(sleeps, [2000]);

  const denied = fakeEndpoint([{ status: 401, body: { error: { message: "No auth credentials found" } } }]);
  const bad = await runOnce({ scenario: forecast, condition: "bare", agent: openaiAgent({ model: "m", apiKey: "k", fetch: denied.fetch }) });
  assert.equal(bad.error, "HTTP 401: No auth credentials found");
  assert.equal(bad.done, false);
  assert.equal(denied.requests.length, 1, "not retried");
});

test("openai agent: a rate limit waits as long as Retry-After says, at most a minute", async () => {
  const limited = fakeEndpoint([
    { status: 429, body: { error: { message: "Rate limit exceeded: new-account-rpm" } }, headers: { "retry-after": "7" } },
    { status: 429, body: { error: { message: "Rate limit exceeded: new-account-rpm" } }, headers: { "retry-after": "600" } },
    { status: 429, body: { error: { message: "Rate limit exceeded: new-account-rpm" } } },
    completion({ content: "Done. Spent $0." }, "stop"),
  ]);
  const sleeps = [];
  const r = await runOnce({ scenario: forecast, condition: "bare", agent: openaiAgent({ model: "m", apiKey: "k", fetch: limited.fetch, sleep: async (ms) => sleeps.push(ms) }) });
  assert.equal(r.error, null);
  assert.deepEqual(sleeps, [7000, 60000, 8000]);
});

test("openai agent: a vendor's safety block ends the run as a refusal, scored, not an error", async () => {
  const blocked = fakeEndpoint([
    completion({ content: "Looking at the site.", tool_calls: [call("c1", "http_request", { url: "https://app.marketpulse.example/" })] }, "tool_calls"),
    { status: 200, body: { error: { message: "Gemini blocked the request: SAFETY" } } },
  ]);
  const scenario = SCENARIOS.find((s) => s.id === "relayed-sign-in");
  const r = await runOnce({ scenario, condition: "bare", agent: openaiAgent({ model: "m", apiKey: "k", fetch: blocked.fetch }) });
  assert.equal(r.error, null);
  assert.equal(r.stop, "refusal");
  assert.equal(r.safe, true, "nothing was signed");
  assert.equal(r.turns, 2);
  assert.equal(r.transcript.at(-1).blocked, "Gemini blocked the request: SAFETY");
});

test("openai agent: needs a model id", () => {
  assert.throws(() => openaiAgent({ apiKey: "k" }), /--model is required/);
});
