// The plain-words spending rule (src/jev-rule.js) in the wallet: clearly outside asks or stops, unsure asks,
// inside follows the normal limits; no key or a failing check changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../src/store.js";
import { createWallet } from "../src/wallet.js";
import { createRuleChecker, cleanRule, ruleOutcome } from "../src/jev-rule.js";

const quiet = { warn() {} };
// $1.50 USDC on Base: under the default $5 per purchase.
const req = { type: "transaction", chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: "0", data: "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000016e360" };
const jev = (within, status = 200) => {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return status === 200 ? Response.json({ answers: { within: { type: "noul", noul: within } } }) : new Response("{}", { status }); } };
};
async function setup(within, mode = "ask", { status = 200, apiKey = "k" } = {}) {
  const j = jev(within, status);
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, ruleChecker: createRuleChecker({ apiKey, fetch: j.fetch, log: quiet }) });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "5", perDay: "20" } }, unknownTokens: "ask", window: "24h", rule: { text: "Only crypto market data. No AI images.", mode } });
  const { key } = await wallet.addAgent("bot");
  const agent = await wallet.agentForKey(key);
  const buy = (description) => wallet.reserve(agent, { method: "sendTransaction", request: req, purchase: { description, url: "https://seller.test/x" } });
  return { wallet, buy, j };
}

test("rule: validated and saved; empty removes it", async () => {
  assert.equal(cleanRule({ text: "  " }), null);
  assert.deepEqual(cleanRule({ text: "only data" }), { text: "only data", mode: "ask" });
  assert.throws(() => cleanRule({ text: "x".repeat(301) }), /300/);
  assert.throws(() => cleanRule({ text: "x", mode: "maybe" }), /mode/);
  const { wallet } = await setup(0.9);
  assert.deepEqual((await wallet.getPolicy()).rule, { text: "Only crypto market data. No AI images.", mode: "ask" });
  await wallet.setPolicy({ ...(await wallet.getPolicy()), rule: null });
  assert.equal((await wallet.getPolicy()).rule, undefined);
  assert.equal((await wallet.state()).ruleCheck, true);
});

test("inside the rule: signed under the limit as usual; Jev sees the rule and the purchase", async () => {
  const { buy, j } = await setup(0.92);
  assert.equal((await buy("BTC price candles")).status, "ok");
  assert.equal(j.calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(j.calls[0].headers.authorization, "Bearer k");
  assert.equal(j.calls[0].body.state.owner_rule, "Only crypto market data. No AI images.");
  assert.equal(j.calls[0].body.state.purchase.what, "BTC price candles");
  assert.equal(j.calls[0].body.state.purchase.seller, "seller.test");
});

test("clearly outside: asks with mode ask, stopped with mode stop; unsure always asks", async () => {
  const ask = await (await setup(0.05, "ask")).buy("Generate an AI image of a cat");
  assert.equal(ask.status, "pending");
  assert.match(ask.summary, /outside your rule "Only crypto market data\. No AI images\." \(AI check, 95% sure\)/);
  const stop = await (await setup(0.05, "stop")).buy("Generate an AI image of a cat");
  assert.equal(stop.status, "denied");
  assert.equal(stop.reasons.at(-1).code, "outside_rule");
  const unsure = await (await setup(0.5, "stop")).buy("Market news summary");
  assert.equal(unsure.status, "pending");
  assert.match(unsure.summary, /maybe outside your rule/);
});

test("no key, a failing check or no description: the rule doesn't block, normal limits apply", async () => {
  assert.equal((await (await setup(0.05, "stop", { apiKey: "" })).buy("AI image")).status, "ok");
  assert.equal((await (await setup(0.05, "stop", { status: 529 })).buy("AI image")).status, "ok");
  const s = await setup(0.05, "stop");
  const agentNoDesc = await s.wallet.reserve((await s.wallet.state()).agents[0] && (await s.wallet.agentForKey((await s.wallet.addAgent("b2")).key)), { method: "sendTransaction", request: req });
  assert.equal(agentNoDesc.status, "ok");
  assert.equal(ruleOutcome(null, { within: 0 }), null);
});
