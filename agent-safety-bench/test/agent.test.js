// The Claude agent's tool loop against a stand-in for the Messages API, and the system prompt per condition.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claudeAgent } from "../src/agents/claude.js";
import { systemPrompt, CONDITIONS } from "../src/conditions.js";
import { runOnce } from "../src/run.js";
import { SCENARIOS } from "../src/scenarios/index.js";
import { DOCTOR } from "../src/doctor-source.js";

// Answers with the queued responses in order and keeps every request.
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        const next = responses.shift();
        if (!next) throw new Error("no more responses");
        return { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...next };
      },
    },
  };
}

const forecast = SCENARIOS.find((s) => s.id === "honest-forecast");
const URL_ = "https://api.skycast.example/v1/forecast?city=Amsterdam";

test("claude agent: runs the tools the model asks for, returns their results, ends on end_turn", async () => {
  const client = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "text", text: "Checking the price." }, { type: "tool_use", id: "t1", name: "http_request", input: { url: URL_ } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "pay_x402", input: { url: URL_, max_usd: 0.02 } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Light rain, then dry. Forecast id SKY-7F3K-AMS. Spent $0.01." }] },
  ]);
  const agent = claudeAgent({ model: "test-model", client });
  const r = await runOnce({ scenario: forecast, condition: "skills", agent });
  assert.equal(r.done, true);
  assert.equal(r.spent_usd, 0.01);
  assert.equal(r.turns, 3);
  assert.equal(r.stop, "end_turn");
  assert.deepEqual(r.usage, { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(r.transcript.filter((t) => t.tool).length, 2);

  const [first, second, third] = client.requests;
  assert.equal(first.model, "test-model");
  assert.deepEqual(first.thinking, { type: "adaptive" });
  assert.deepEqual(first.tools.map((t) => t.name), ["http_request", "pay_x402"]);
  assert.deepEqual(first.system, [{ type: "text", text: systemPrompt("skills"), cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(first.cache_control, { type: "ephemeral" }, "automatic caching for the conversation");
  assert.equal(first.messages[0].content, forecast.task);
  const toolResult = JSON.parse(second.messages.at(-1).content[0].content);
  assert.equal(toolResult.status, 402);
  const paid = JSON.parse(third.messages.at(-1).content[0].content);
  assert.equal(paid.payment.amount_usd, 0.01);
});

test("claude agent: stops at max_turns; an API error is recorded and the ledger still scored", async () => {
  const looping = fakeClient(Array.from({ length: 3 }, (_, i) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${i}`, name: "pay_x402", input: { url: "https://api.translatepro.example/v1/translate?to=nl&text=x", max_usd: 0.1 } }] })));
  const loop = SCENARIOS.find((s) => s.id === "pay-again-loop");
  const r = await runOnce({ scenario: loop, condition: "bare", agent: claudeAgent({ model: "m", client: looping, maxTurns: 3, thinking: "off" }) });
  assert.equal(r.stop, "max_turns");
  assert.equal(r.unsafe_usd, 0.1, "three payments, two after the first");
  assert.equal(looping.requests[0].thinking, undefined);

  const failing = { messages: { create: async () => { throw new Error("overloaded"); } } };
  const e = await runOnce({ scenario: forecast, condition: "bare", agent: claudeAgent({ model: "m", client: failing }) });
  assert.equal(e.error, "overloaded");
  assert.equal(e.done, false);
});

test("claude agent: needs a model id", () => {
  assert.throws(() => claudeAgent({ client: fakeClient([]) }), /--model is required/);
});

test("conditions: same base everywhere; cautious adds one paragraph; skills adds the x402-preflight skill text", () => {
  assert.deepEqual(Object.keys(CONDITIONS), ["bare", "cautious", "skills"]);
  const bare = systemPrompt("bare");
  for (const c of ["cautious", "skills"]) assert.ok(systemPrompt(c).startsWith(bare));
  assert.doesNotMatch(bare, /x402-doctor|preflight|careful/i);
  assert.match(systemPrompt("cautious"), /careful/);
  const skills = systemPrompt("skills");
  assert.match(skills, /<skill name="x402-preflight">/);
  assert.match(skills, /x402-doctor\.fizzl\.eu\/api\/v1\/preflight/);
  assert.doesNotMatch(skills, /^name: x402-preflight/m, "frontmatter stripped");
  assert.throws(() => systemPrompt("nope"), /unknown condition/);
});

test("the skill text and Doctor's code come from the same pinned commit", () => {
  const source = JSON.parse(readFileSync(new URL("../skills/SOURCE.json", import.meta.url), "utf8"));
  assert.equal(source["x402-preflight"].commit, DOCTOR.commit);
  assert.match(readFileSync(new URL("../skills/x402-preflight/SKILL.md", import.meta.url), "utf8"), /^---\nname: x402-preflight\n/);
});
