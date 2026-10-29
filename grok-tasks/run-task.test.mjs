import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, reportText, usageLine, failedQuickChecks, TASKS } from "./run-task.mjs";

const NOW = Date.parse("2026-10-29T18:00:00Z");

test("each task: X search from its window, only free MCP tools, the task text and the rules", () => {
  for (const id of Object.keys(TASKS)) {
    const r = buildRequest(id, { now: NOW });
    assert.equal(r.model, "grok-4.7");
    assert.equal(r.tools[0].type, "x_search");
    assert.equal(r.tools[1].type, "web_search");
    assert.match(r.input[0].content, /at most 6 X searches and 6 web searches/);
    const mcp = r.tools.filter((t) => t.type === "mcp");
    assert.ok(mcp.length >= 1);
    const allowed = mcp.flatMap((t) => t.allowed_tools);
    assert.deepEqual(allowed.filter((n) => !["x402_quick_check", "token_quick_verdict", "injection_quick_check"].includes(n)), [], "free checks only");
    assert.ok(mcp.every((t) => t.allowed_tools.length > 0), "an empty list would allow every tool, the paid ones too");
    assert.match(r.input[0].content, /Never pay, never sign, never post/);
    assert.match(r.input[1].content, /^Today is 2026-10-29\./);
    assert.doesNotMatch(r.input[1].content, /check_text/, "the wallet's check_text isn't available here");
  }
  assert.equal(buildRequest("A", { now: NOW }).tools[0].from_date, "2026-10-28");
  assert.equal(buildRequest("D", { now: NOW }).tools[0].from_date, "2026-10-26");
  assert.deepEqual(buildRequest("B", { now: NOW }).tools.slice(2).map((t) => t.server_label), ["presign_guard"]);
  assert.throws(() => buildRequest("Z"), /unknown task/);
});

test("the report text and the usage line from a Responses answer", () => {
  const response = {
    output: [
      { type: "custom_tool_call", name: "x_search" },
      { type: "mcp_call", name: "x402_quick_check" },
      { type: "message", content: [{ type: "output_text", text: "Ik zoek eerst op X." }] },
      { type: "message", content: [{ type: "output_text", text: "Niets nieuws vandaag." }] },
    ],
    usage: { input_tokens: 40000, output_tokens: 1500, server_side_tool_usage_details: { x_search_calls: 3, x_posts_fetched: 20, web_search_calls: 2, mcp_calls: 1, code_interpreter_calls: 0 } },
  };
  assert.equal(reportText(response), "Niets nieuws vandaag.", "only the last message, not Grok's notes in between");
  assert.equal(reportText({ output_text: " Kort. " }), "Kort.");
  assert.equal(reportText({}), "");
  assert.equal(usageLine(response, "grok-4.7"), "grok-4.7: 40000 in / 1500 out tokens, x search calls 3, x posts fetched 20, web search calls 2, mcp calls 1 ≈ $0.20 (tokens $0.09, tools $0.11)");
  assert.equal(usageLine({}, "other-model"), "other-model: 0 in / 0 out tokens");
});

test("failing quick checks come from the tool calls, once per URL, https only", () => {
  const call = (url, overall, extra = {}) => ({ type: "mcp_call", name: "x402_quick_check", server_label: "x402_doctor", arguments: JSON.stringify({ url, ...extra }), output: JSON.stringify({ url, overall, failures: overall === "fail" ? 1 : 0 }) });
  const response = { output: [
    call("https://solgpt.us/api/dark-clawd/mpp/charge", "fail", { method: "POST" }),
    call("https://ok.example/paid", "pass"),
    call("https://warn.example/paid", "warn"),
    call("https://solgpt.us/api/dark-clawd/mpp/charge", "fail", { method: "POST" }),
    call("http://plain.example/paid", "fail"),
    { type: "mcp_call", name: "token_quick_verdict", arguments: "{}", output: "{\"overall\":\"fail\"}" },
    { type: "message", content: [{ type: "output_text", text: "x402_quick_check https://made-up.example fail" }] },
    { type: "mcp_call", name: "x402_quick_check", arguments: { url: "https://obj.example/x" }, output: [{ type: "text", text: "{\"overall\":\"fail\"}" }] },
  ] };
  assert.deepEqual(failedQuickChecks(response), [
    { url: "https://solgpt.us/api/dark-clawd/mpp/charge", method: "POST" },
    { url: "https://obj.example/x" },
  ]);
  assert.deepEqual(failedQuickChecks({}), []);
});
