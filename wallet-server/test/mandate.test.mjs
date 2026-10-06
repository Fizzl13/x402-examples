// Agent mandates (src/mandate.js) in the wallet: the owner sets terms, the server signs an x402-mandate/1
// for the agent's wallet, and holds every spend to them (sellers, per payment, the running total, expiry).
// Jev judges the purpose: outside or unsure, the owner is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { memoryStore } from "../src/store.js";
import { createWallet } from "../src/wallet.js";
import { createRuleChecker } from "../src/jev-rule.js";
import { issuerFor, jcs, cleanTerms, mandateCheck, USDC_BASE } from "../src/mandate.js";

const SELLER = "0x1111111111111111111111111111111111111111";
const AGENT_WALLET = "0x2222222222222222222222222222222222222222";
// A USDC transfer on Base of `micro` (6 decimals) to `to`.
const transfer = (micro, to = SELLER) => ({ type: "transaction", chainId: 8453, to: USDC_BASE, value: "0", data: `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${BigInt(micro).toString(16).padStart(64, "0")}` });

async function setup({ within = null, terms = { cap: "3", perPayment: "1.5", recipients: [SELLER], days: 7, purpose: "crypto market data" }, secret = "test-secret-0123456789" } = {}) {
  const ruleChecker = within === null ? null : createRuleChecker({ apiKey: "k", fetch: async () => Response.json({ answers: { within: { type: "noul", noul: within } } }), log: { warn() {} } });
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, ruleChecker, mandateIssuer: issuerFor(secret, "acct1") });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "50", perDay: "100" } }, unknownTokens: "ask", window: "24h" });
  const { key, agent: pub } = await wallet.addAgent("bot");
  if (terms) await wallet.setAgentMandate(pub.id, terms);
  const agent = await wallet.agentForKey(key);
  const pay = (micro, to, purchase = { description: "BTC candles", url: "https://seller.test/x" }) => wallet.reserve(agent, { method: "writeContract", request: transfer(micro, to), purchase });
  return { wallet, agent, pub, pay };
}

test("the signed mandate verifies, names the agent's wallet and carries the terms", async () => {
  const { wallet, agent } = await setup();
  const m = await wallet.mandateFor(agent, AGENT_WALLET);
  assert.equal(m.alg, "Ed25519");
  assert.equal(m.mandate.v, "x402-mandate/1");
  assert.equal(m.mandate.subject, AGENT_WALLET);
  assert.equal(m.mandate.asset, `eip155:8453/erc20:${USDC_BASE}`);
  assert.equal(m.mandate.cap, "3000000");
  assert.equal(m.mandate.perPayment, "1500000");
  assert.deepEqual(m.mandate.recipients, [SELLER]);
  assert.equal(m.mandate.accountant, m.mandate.issuer);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: m.mandate.issuer }, format: "jwk" });
  assert.ok(verify(null, Buffer.from("x402-mandate/1\n" + jcs(m.mandate)), key, Buffer.from(m.sig, "base64url")));
  assert.equal(m.terms.left, "3");
});

test("the issuer key is the same for the same secret and account, different per account", () => {
  assert.equal(issuerFor("s".repeat(20), "a").publicKey, issuerFor("s".repeat(20), "a").publicKey);
  assert.notEqual(issuerFor("s".repeat(20), "a").publicKey, issuerFor("s".repeat(20), "b").publicKey);
  assert.equal(issuerFor("", "a"), null);
});

test("inside the mandate: signed and counted; the running total stops the payment that would cross the cap", async () => {
  const { wallet, pub, pay } = await setup();
  assert.equal((await pay(1_500_000)).status, "ok");
  assert.equal((await pay(1_000_000)).status, "ok");
  const third = await pay(1_000_000);
  assert.equal(third.status, "denied");
  assert.match(third.summary, /outside the mandate: 1 USDC is more than the 0.5 USDC left of its 3 USDC/);
  const a = (await wallet.agents()).find((x) => x.id === pub.id);
  assert.equal(a.mandate.spent, "2.5");
  assert.equal(a.mandate.left, "0.5");
});

test("outside: another seller, over per payment, another token; a failed signature gives the amount back", async () => {
  const { wallet, agent, pub, pay } = await setup();
  assert.match((await pay(1_000_000, "0x3333333333333333333333333333333333333333")).summary, /not one of its sellers/);
  assert.match((await pay(2_000_000)).summary, /over its 1.5 USDC per payment/);
  const eth = await wallet.reserve(agent, { method: "sendTransaction", request: { type: "transaction", chainId: 8453, to: SELLER, value: "1000", data: "0x" } });
  assert.equal(eth.status, "denied");
  assert.match(eth.summary, /only covers USDC on Base/);
  const ok = await pay(1_000_000);
  await wallet.release(agent, ok.entries, { purchaseId: ok.purchaseId, error: "user rejected" });
  assert.equal((await wallet.agents()).find((x) => x.id === pub.id).mandate.spent, "0");
});

test("expired mandates stop everything; ending the mandate goes back to the normal limits", async () => {
  let t = Date.parse("2026-10-06T10:00:00Z");
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null, now: () => t, mandateIssuer: issuerFor("test-secret-0123456789", "a") });
  await wallet.setPolicy({ tokens: { USDC: { perTx: "50", perDay: "100" } }, unknownTokens: "ask", window: "24h" });
  const { key, agent: pub } = await wallet.addAgent("bot");
  await wallet.setAgentMandate(pub.id, { cap: "5", recipients: ["*"], days: 1, purpose: "data" });
  const agent = await wallet.agentForKey(key);
  t += 2 * 86400_000;
  assert.match((await wallet.reserve(agent, { method: "writeContract", request: transfer(100_000) })).summary, /expired/);
  await wallet.setAgentMandate(pub.id, null);
  assert.equal((await wallet.reserve(agent, { method: "writeContract", request: transfer(100_000) })).status, "ok");
  assert.equal(await wallet.mandateFor(agent, AGENT_WALLET), null);
});

test("Jev on the purpose: outside it, the owner is asked (not stopped); inside, signed", async () => {
  const outside = await setup({ within: 0.05 });
  const r = await outside.pay(1_000_000, SELLER, { description: "An AI image of a cat", url: "https://images.test/x" });
  assert.equal(r.status, "pending");
  assert.match(r.summary, /mandate purpose \("crypto market data"\)/);
  const inside = await setup({ within: 0.95 });
  assert.equal((await inside.pay(1_000_000)).status, "ok");
});

test("terms are validated; no MANDATE_SECRET, no mandates", async () => {
  assert.throws(() => cleanTerms({ cap: "0", recipients: ["*"], days: 7, purpose: "x" }), /cap/);
  assert.throws(() => cleanTerms({ cap: "5", perPayment: "6", recipients: ["*"], days: 7, purpose: "x" }), /perPayment/);
  assert.throws(() => cleanTerms({ cap: "5", recipients: ["*", SELLER], days: 7, purpose: "x" }), /recipients/);
  assert.throws(() => cleanTerms({ cap: "5", recipients: ["nope"], days: 7, purpose: "x" }), /not an address/);
  assert.throws(() => cleanTerms({ cap: "5", recipients: ["*"], days: 0, purpose: "x" }), /days/);
  assert.throws(() => cleanTerms({ cap: "5", recipients: ["*"], days: 7, purpose: " " }), /purpose/);
  const wallet = createWallet({ store: memoryStore(), signers: [], authority: null });
  const { agent } = await wallet.addAgent("bot");
  await assert.rejects(wallet.setAgentMandate(agent.id, { cap: "5", recipients: ["*"], days: 7, purpose: "x" }), /MANDATE_SECRET/);
});

test("mandateCheck: unlimited amounts are outside", () => {
  const terms = cleanTerms({ cap: "5", recipients: ["*"], days: 7, purpose: "x" });
  assert.match(mandateCheck(terms, [{ chainId: 8453, token: USDC_BASE, amount: null, to: SELLER }]).reason.message, /unlimited/);
});

test("two waiting approvals under one mandate can't both be approved past its total", async () => {
  const { wallet, pay } = await setup({ within: 0.05, terms: { cap: "2", recipients: [SELLER], days: 7, purpose: "data" } });
  const a1 = await pay(1_500_000, SELLER, { description: "cat picture", url: "https://x.test" });
  const a2 = await pay(1_500_000, SELLER, { description: "dog picture", url: "https://x.test" });
  assert.equal(a1.status, "pending"); assert.equal(a2.status, "pending");
  assert.equal((await wallet.decide(a1.approvalId, "approve")).status, "approved");
  const second = await wallet.decide(a2.approvalId, "approve");
  assert.equal(second.status, "denied");
  assert.match(second.summary, /mandate total/);
});
