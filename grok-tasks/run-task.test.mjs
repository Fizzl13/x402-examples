import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, reportText, usageLine, failedQuickChecks, quickChecks, trustLine, visibilityLine, TASKS } from "./run-task.mjs";

const NOW = Date.parse("2026-10-29T18:00:00Z");

test("each task: X search from its window, only free MCP tools, the task text and the rules", () => {
  for (const id of Object.keys(TASKS).filter((k) => !TASKS[k].neutral)) {
    const r = buildRequest(id, { now: NOW });
    assert.equal(r.model, "grok-4.7");
    assert.equal(r.tools[0].type, "x_search");
    assert.equal(r.tools[1].type, "web_search");
    assert.match(r.input[0].content, /at most 6 X searches and 6 web searches/);
    const mcp = r.tools.filter((t) => t.type === "mcp");
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
  assert.equal(buildRequest("F", { now: NOW }).tools[0].from_date, "2026-10-22");
  assert.equal(buildRequest("F", { now: NOW }).tools.length, 2, "the digest only reads");
  assert.deepEqual(buildRequest("F", { now: NOW }).tools[0].excluded_x_handles, ["x402fizzl"]);
  assert.deepEqual(buildRequest("H", { now: NOW }).tools[0].allowed_x_handles, ["x402fizzl"]);
  assert.equal(buildRequest("A", { now: NOW }).tools[0].allowed_x_handles, undefined);
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
  const cachedRun = { usage: { input_tokens: 40000, output_tokens: 1500, input_tokens_details: { cached_tokens: 30000 } } };
  assert.equal(usageLine(cachedRun, "grok-4.7"), "grok-4.7: 40000 in (30000 cached) / 1500 out tokens ≈ $0.04 (tokens $0.04, tools $0.00)", "cached input at its own price");
  assert.equal(usageLine({ usage: { ...cachedRun.usage, cost_in_usd_ticks: 7_300_000_000 } }, "grok-4.7"), "grok-4.7: 40000 in (30000 cached) / 1500 out tokens = $0.73 (xAI)", "xAI's own cost wins");
  assert.equal(usageLine({ usage: { input_tokens: 1, output_tokens: 1, cost_in_nano_usd: 120_000_000 } }, "grok-4.3"), "grok-4.3: 1 in / 1 out tokens = $0.12 (xAI)");
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
  assert.deepEqual(quickChecks(response).map((c) => [c.url, c.overall]), [
    ["https://solgpt.us/api/dark-clawd/mpp/charge", "fail"],
    ["https://ok.example/paid", "pass"],
    ["https://warn.example/paid", "warn"],
    ["https://obj.example/x", "fail"],
  ], "every checked https endpoint goes to the Trust Index");
});

test("the Trust Index line says what was added and what was already there", () => {
  assert.equal(trustLine([{ host: "a.example", status: 201 }, { host: "b.example", status: 200 }, { host: "c.example", status: 422 }, { host: "d.example", status: 0 }]), "Trust Index: 1 nieuw toegevoegd (a.example), 1 stond(en) er al in, 2 niet toegevoegd.");
  assert.equal(trustLine([{ host: "b.example", status: 200 }]), "Trust Index: 0 nieuw toegevoegd, 1 stond(en) er al in.");
  assert.equal(trustLine([]), "");
});

test("taak V asks like any developer, web search only, and scores which answers named us", () => {
  const r = buildRequest("V", { now: NOW });
  assert.deepEqual(r.tools, [{ type: "web_search" }], "no X search, no MCP, no memory of us");
  assert.doesNotMatch(JSON.stringify(r.input), /fizzl|presign|doctor/i, "nothing in the prompt points at our services");
  assert.match(r.input[0].content, /at most 6 searches/, "the first run made 30 searches and cost $1.00");
  const answer = "1. Use x402 Doctor (https://x402-doctor.fizzl.eu/) because…\n2. x402check.xyz screens…\n3. AgentWallet (agentwallet.ai)…\n4. **Fizzl Buy** at buy.fizzl.eu…";
  assert.equal(visibilityLine(answer), "Vindbaarheid: 1 x402 Doctor ✅ · 2 presign-guard ❌ · 3 Fizzl Agent Wallet ❌ · 4 Fizzl Buy ✅ (2/4)");
  assert.equal(visibilityLine("**1.** presign-guard is great for 1 but\n**2.** use presign-guard"), "Vindbaarheid: 1 x402 Doctor ❌ · 2 presign-guard ✅ · 3 Fizzl Agent Wallet ❌ · 4 Fizzl Buy ❌ (1/4)", "per numbered answer");
  assert.equal(visibilityLine("Try wallet.fizzl.eu"), "Vindbaarheid: 1 x402 Doctor ❌ · 2 presign-guard ❌ · 3 Fizzl Agent Wallet ✅ · 4 Fizzl Buy ❌ (1/4)", "unnumbered: the whole answer");
});
