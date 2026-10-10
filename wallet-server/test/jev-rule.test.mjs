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

test("unusual purchase: after 5+ earlier buys, one unlike them gives the owner a heads-up (once a day per seller); it is never blocked", async () => {
  const asked = [], alerts = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    const what = body.state?.new_purchase?.what ?? "";
    return Response.json({ answers: { unusual: { noul: /airdrop/i.test(what) ? 0.93 : 0.2 } } });
  };
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, ruleChecker: createRuleChecker({ apiKey: "k", fetch, log: quiet }), onAlert: async (a) => alerts.push(a) });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "5", perDay: "50" } }, unknownTokens: "ask", window: "24h" });
  const { key } = await wallet.addAgent("trader");
  const agent = await wallet.agentForKey(key);
  const buy = (description, url = "https://ichimoku.test/signal") => wallet.reserve(agent, { method: "sendTransaction", request: req, purchase: { description, url } });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  // Too little history: not asked.
  for (let i = 0; i < 5; i++) { assert.equal((await buy(`BTC trend signal ${i}`)).status, "ok"); await settle(); }
  assert.equal(asked.length, 0, "no history yet");
  // The same kind of thing: asked, not unusual, no alert.
  assert.equal((await buy("ETH trend signal")).status, "ok"); await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].state.history.length, 5);
  assert.deepEqual(asked[0].state.new_purchase, { what: "ETH trend signal", seller: "ichimoku.test" });
  assert.equal(alerts.length, 0);
  // Out of character: it still goes through (status ok), and the owner hears about it once.
  const odd = await buy("Claim your free airdrop", "https://claim-drop.test/x");
  assert.equal(odd.status, "ok");
  await settle();
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].kind, alerts[0].host, alerts[0].purchaseId], ["unusual", "claim-drop.test", odd.purchaseId]);
  assert.match(alerts[0].text, /unlike what it usually buys.*93% sure/);
  const ev = (await wallet.state()).events.find((e) => e.type === "unusual");
  assert.deepEqual([ev.agent, ev.what, ev.likely], ["trader", "Claim your free airdrop", 0.93]);
  // The same seller again today: no second alert.
  await buy("Claim your free airdrop again", "https://claim-drop.test/x"); await settle();
  assert.equal(alerts.length, 1);
});

test("unusual purchase: off without a TypeSafe key", async () => {
  const alerts = [];
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, ruleChecker: createRuleChecker({ apiKey: "", fetch: async () => { throw new Error("must not be called"); }, log: quiet }), onAlert: async (a) => alerts.push(a) });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "5", perDay: "50" } }, unknownTokens: "ask", window: "24h" });
  const { key } = await wallet.addAgent("trader");
  const agent = await wallet.agentForKey(key);
  for (let i = 0; i < 7; i++) assert.equal((await wallet.reserve(agent, { method: "sendTransaction", request: req, purchase: { description: i === 6 ? "free airdrop" : "BTC signal", url: "https://x.test/" } })).status, "ok");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alerts.length, 0);
});

test("price jump: paying the same API 2× its usual price (and a cent more) gives one heads-up a day; never blocked", async () => {
  const alerts = [];
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, onAlert: async (a) => alerts.push(a) });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "5", perDay: "100" } }, unknownTokens: "ask", window: "24h" });
  const { key } = await wallet.addAgent("bot");
  const agent = await wallet.agentForKey(key);
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", SELLER = "0x1111111111111111111111111111111111111111";
  const transfer = (micro) => ({ type: "transaction", chainId: 8453, to: USDC, value: "0", data: `0xa9059cbb${SELLER.slice(2).padStart(64, "0")}${BigInt(micro).toString(16).padStart(64, "0")}` });
  const buy = (micro, url = "https://api.seller.test/signal?pair=BTC") => wallet.reserve(agent, { method: "writeContract", request: transfer(micro), purchase: { description: "signal", url } });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  for (const m of [20000, 20000]) { assert.equal((await buy(m)).status, "ok"); await settle(); }
  assert.equal(alerts.length, 0, "the usual price: no alert");
  assert.equal((await buy(25000)).status, "ok"); await settle();
  assert.equal(alerts.length, 0, "a bit more is not a jump");
  assert.equal((await buy(30000, "https://api.seller.test/other")).status, "ok"); await settle();
  assert.equal(alerts.length, 0, "another path has its own history");
  const r = await buy(100000); await settle();
  assert.equal(r.status, "ok", "never blocked");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "price");
  assert.match(alerts[0].text, /\$0\.1 to api\.seller\.test\/signal, 5× the usual \$0\.02/);
  await buy(100000); await settle();
  assert.equal(alerts.length, 1, "once a day per agent and API");
  assert.ok((await wallet.state()).events.some((e) => e.type === "price_jump"));
});

test("a stopped purchase tells the owner (with the reasons and what it was for), at most once per agent per 10 minutes", async () => {
  const alerts = [];
  let t = 1_000_000;
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, now: () => t, ruleChecker: createRuleChecker({ apiKey: "k", fetch: jev(0.03).fetch, log: quiet }), onAlert: async (a) => alerts.push(a) });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "5", perDay: "20" } }, unknownTokens: "ask", window: "24h", rule: { text: "Only crypto market data.", mode: "stop" } });
  const agent = await wallet.agentForKey((await wallet.addAgent("bot")).key);
  const buy = () => wallet.reserve(agent, { method: "sendTransaction", request: req, purchase: { description: "AI image of a cat", url: "https://images.test/gen" } });
  assert.equal((await buy()).status, "denied");
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "blocked");
  assert.match(alerts[0].text, /bot was stopped and nothing was signed: .*outside your rule/);
  assert.match(alerts[0].text, /for: AI image of a cat · images\.test/);
  await buy();
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1, "a second stop within 10 minutes is not sent again");
  t += 11 * 60e3;
  await buy();
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 2);
});
