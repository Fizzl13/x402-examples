// Offline demo: an AI SDK agent with the Fizzl tools, a scripted model and stand-in APIs. No keys, no network,
// no money. Swap the mock model for a real one (e.g. anthropic("claude-…")) and the stand-in fetch for an
// x402-paying fetch, and it is a real agent.
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { fizzlTools } from "../index.js";

const answers = {
  "/api/v1/preflight": { verdict: "caution", summary: "Payable, with caution: $0.02 on Base. It presents itself as an official service of a well-known brand that does not own this domain (judged by TypeSafe Jev).", reasons: [{ level: "caution", code: "brand_impersonation" }] },
  "/v1/check": { verdict: "red", reasons: [{ code: "UNLIMITED_APPROVAL_UNKNOWN_SPENDER" }], summary: "Unlimited USDC approval to an unknown contract." },
};
const standInFetch = async (url) => new Response(JSON.stringify(answers[new URL(url).pathname] ?? { error: "not found" }), { status: answers[new URL(url).pathname] ? 200 : 404 });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const script = [
  { type: "tool-call", toolCallId: "1", toolName: "check_endpoint_before_paying", input: JSON.stringify({ url: "https://coinbase-official-api.xyz/price", max_usd: 0.05 }) },
  { type: "tool-call", toolCallId: "2", toolName: "check_before_signing", input: JSON.stringify({ type: "approval", chainId: 8453, token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", spender: "0x000000000000000000000000000000000000dEaD", amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935" }) },
];
let step = 0;
const model = new MockLanguageModelV4({
  doGenerate: async () => step < script.length
    ? { content: [script[step++]], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage, warnings: [] }
    : { content: [{ type: "text", text: "I did not pay: the API pretends to be Coinbase, and the approval it asked for is unlimited to an unknown contract (red)." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] },
});

const result = await generateText({ model, tools: fizzlTools({ fetch: standInFetch }), prompt: "Buy the BTC price from https://coinbase-official-api.xyz/price", stopWhen: stepCountIs(5) });
for (const s of result.steps) for (const r of s.toolResults) console.log(`▶ ${r.toolName}\n   → ${r.output.verdict}: ${r.output.summary}\n`);
console.log(`Agent: ${result.text}`);
