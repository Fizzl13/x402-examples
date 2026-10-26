// Fizzl safety checks as LangChain.js tools, for LangChain and LangGraph agents: check a transaction or
// signature before signing, a token before buying, a wallet's open approvals, a wallet against the OFAC
// sanctions list, and an x402 endpoint before paying it. Each tool calls a paid Fizzl API (presign-guard or x402 Doctor) through the fetch you pass: an
// x402-paying fetch (@x402/fetch) or prepaid credit keys. Without either, the free quick check answers
// (the verdict only, a few per hour).
//
// The checks only check; they never sign, pay or move anything themselves. A failed check comes back to the
// model as { error, message }, never as an exception that ends the run. One opt-in tool buys: buy_live_data
// (with `buy: true`) has Fizzl Buy buy live data for the agent, paid through the same fetch.
import { tool } from "@langchain/core/tools";
import { fizzlTools as checks, PRICES, PRESIGN_URL, DOCTOR_URL, BUY_URL } from "presign-guard-ai-sdk";

export const VERSION = "0.7.0";
export { PRICES, PRESIGN_URL, DOCTOR_URL, BUY_URL };

// The same checks as presign-guard-ai-sdk; only the user agent says where the call came from.
function withUserAgent(fetchImpl) {
  return (url, init = {}) => fetchImpl(url, { ...init, headers: { ...init.headers, "user-agent": `fizzl-langchain/${VERSION}` } });
}

/**
 * The Fizzl checks as LangChain tools: pass them to createAgent, createReactAgent or model.bindTools.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetch that pays x402 (wrapFetchWithPayment from @x402/fetch); plain fetch works with credit keys
 * @param {{ presign?: string, doctor?: string }} [options.creditKeys] prepaid credit keys (x-credit-key) per service
 * @param {string[]} [options.only] the tool names to include (default: the nine checks, plus buy_live_data with `buy`)
 * @param {boolean} [options.buy] add buy_live_data, which buys live data for the agent ($0.02 a purchase; default false)
 * @param {boolean} [options.free] fall back to the free quick checks when a check can't be paid (default true)
 * @param {string} [options.presignUrl] @param {string} [options.doctorUrl] @param {string} [options.buyUrl] @param {number} [options.timeoutMs]
 */
export function fizzlTools({ fetch: fetchImpl = globalThis.fetch, ...options } = {}) {
  const defs = checks({ ...options, fetch: withUserAgent(fetchImpl) });
  return Object.entries(defs).map(([name, d]) => tool(
    async (input) => JSON.stringify(await d.execute(input)),
    { name, description: d.description, schema: d.inputSchema },
  ));
}
