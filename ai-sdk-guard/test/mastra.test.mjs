// The same tools in a Mastra agent (Mastra takes AI SDK tools as they are). Runs when @mastra/core is installed:
// CI installs it in a separate step (npm i --no-save @mastra/core@1); a plain `npm test` skips it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fizzlTools } from "../index.js";

let Agent, MockLanguageModelV4;
try {
  ({ Agent } = await import("@mastra/core/agent"));
  ({ MockLanguageModelV4 } = await import("ai/test"));
} catch {}

test("a Mastra agent calls check_endpoint_before_paying and gets the verdict", { skip: !Agent && "@mastra/core not installed" }, async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ verdict: "no_go", summary: "Do not pay." }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => (step++ === 0
      ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "check_endpoint_before_paying", input: JSON.stringify({ url: "https://api.example.com/x", max_usd: 0.01 }) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage, warnings: [] }
      : { content: [{ type: "text", text: "Not paying: no_go." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
  });
  const agent = new Agent({ id: "buyer", name: "buyer", instructions: "Check before paying.", model, tools: fizzlTools({ fetch, only: ["check_endpoint_before_paying"] }) });
  const out = await agent.generate("Is it safe to pay?");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/v1\/preflight\?url=https%3A%2F%2Fapi\.example\.com%2Fx&max_usd=0\.01/);
  assert.equal(out.text, "Not paying: no_go.");
});
