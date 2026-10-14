// The pieces under the scenarios: the simulated internet, the wallet with the official x402 client, the agent tools
// and x402 Doctor at its real hostname.

import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, json } from "../src/world.js";
import { createLedger } from "../src/ledger.js";
import { createWallet } from "../src/wallet.js";
import { createTools } from "../src/tools.js";
import { routeDoctor, DOCTOR_HOST } from "../src/fizzl.js";
import { option, paidRoute, readPayment, USDC_BASE } from "../src/x402-seller.js";
import { benchAddress } from "../src/addresses.js";
import { goodTrack } from "../src/scenarios/_lib.js";

function setup() {
  const world = createWorld();
  const ledger = createLedger();
  const events = [];
  const ctx = { world, ledger, events };
  const payTo = benchAddress("test-seller");
  const accepts = [option({ usd: 0.3, payTo }), option({ usd: 0.02, payTo })];
  world.route("api.shop.example", async (req) => {
    if (req.url.pathname === "/item") return paidRoute(ctx, req, { accepts, description: "an item", deliver: async () => json(200, { item: "ok" }) });
    return json(404, {});
  });
  const wallet = createWallet({ world, ledger });
  return { world, ledger, events, ctx, wallet, payTo, tools: createTools({ world, wallet }) };
}

test("world: unknown hosts and plain http fail like a failed DNS lookup", async () => {
  const { world } = setup();
  await assert.rejects(world.fetch("https://nowhere.example/"), { code: "ENOTFOUND" });
  await assert.rejects(world.fetch("http://api.shop.example/item"), { code: "ENOTFOUND" });
});

test("bench addresses are stable per label and differ between labels", () => {
  assert.equal(benchAddress("a"), benchAddress("a"));
  assert.notEqual(benchAddress("a"), benchAddress("b"));
  assert.match(benchAddress("a"), /^0x[0-9a-fA-F]{40}$/);
});

test("wallet: signs a real EIP-3009 USDC authorization the seller verifies, and the ledger records it", async () => {
  const { wallet, ledger, payTo } = setup();
  const r = await wallet.pay({ url: "https://api.shop.example/item", maxUsd: 1 });
  assert.equal(r.response.status, 200);
  assert.deepEqual(await r.response.json(), { item: "ok" });
  assert.equal(r.payment.option_index, 0, "the default client pays the first option");
  assert.equal(r.payment.amount_usd, 0.3);
  assert.match(r.payment.transaction, /^0x0+1$/);
  assert.equal(ledger.payments.length, 1);
  assert.deepEqual({ host: ledger.payments[0].host, usd: ledger.payments[0].usd, payTo: ledger.payments[0].payTo, asset: ledger.payments[0].asset, settled: ledger.payments[0].settled }, { host: "api.shop.example", usd: 0.3, payTo, asset: USDC_BASE, settled: true });
});

test("wallet: option_index picks the option; max_usd is x402's own spend cap", async () => {
  const { wallet, ledger } = setup();
  const cheap = await wallet.pay({ url: "https://api.shop.example/item", maxUsd: 1, optionIndex: 1 });
  assert.equal(cheap.payment.amount_usd, 0.02);
  const capped = await wallet.pay({ url: "https://api.shop.example/item", maxUsd: 0.05 });
  assert.equal(capped.payment.amount_usd, 0.02, "over-cap options are filtered out, the next one is paid");
  const refused = await wallet.pay({ url: "https://api.shop.example/item", maxUsd: 0.01 });
  assert.match(refused.error, /refused by the x402 client/);
  const missing = await wallet.pay({ url: "https://api.shop.example/item", maxUsd: 1, optionIndex: 5 });
  assert.match(missing.error, /option_index 5 does not exist/);
  assert.equal(ledger.payments.length, 2);
});

test("seller: a payment signed for another option, or tampered with, is refused", async () => {
  const { ctx } = setup();
  const req = (headers) => ({ method: "GET", url: new URL("https://api.shop.example/item"), headers: new Headers(headers), body: "" });
  const accepts = [option({ usd: 0.02, payTo: benchAddress("x") })];
  assert.equal(await readPayment(req({}), accepts), null);
  const bad = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from: benchAddress("p"), to: benchAddress("x"), value: "20000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"1".repeat(64)}` } } })).toString("base64");
  assert.deepEqual(await readPayment(req({ "payment-signature": bad }), accepts), { ok: false, reason: "invalid signature" });
  const other = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from: benchAddress("p"), to: benchAddress("y"), value: "20000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"1".repeat(64)}` } } })).toString("base64");
  assert.equal((await readPayment(req({ "payment-signature": other }), accepts)).reason, "the payment does not match an offered option");
  assert.equal(ctx.ledger.payments.length, 0);
});

test("tools: http_request never pays; pay_x402 reports the payment; bad input is an error, not a crash", async () => {
  const { tools, ledger } = setup();
  const free = await tools.run("http_request", { url: "https://api.shop.example/item" });
  assert.equal(free.status, 402);
  assert.ok(free.headers["payment-required"]);
  assert.equal(JSON.parse(free.body).accepts.length, 2);
  assert.equal(ledger.payments.length, 0);
  const paid = await tools.run("pay_x402", { url: "https://api.shop.example/item", max_usd: 0.05 });
  assert.equal(paid.status, 200);
  assert.equal(paid.payment.paid, true);
  assert.equal(paid.payment.amount_usd, 0.02);
  assert.match((await tools.run("pay_x402", { url: "https://api.shop.example/item", max_usd: 0 })).error, /max_usd/);
  assert.match((await tools.run("http_request", { url: "https://nowhere.example/" })).error, /could not resolve host/);
  assert.match((await tools.run("rm_rf", {})).error, /unknown tool/);
});

test("doctor: free track record by URL (query string ignored), paid preflight, outcome reports", async () => {
  const { world, ctx, wallet, events } = setup();
  routeDoctor(ctx, { trust: { "https://api.shop.example/item": goodTrack(12, 0.02) } });
  const trust = await world.fetch(`https://${DOCTOR_HOST}/api/trust?url=${encodeURIComponent("https://api.shop.example/item?x=1")}`);
  assert.equal(trust.status, 200);
  assert.equal((await trust.json()).days_payable, 12);
  assert.equal((await world.fetch(`https://${DOCTOR_HOST}/api/trust?url=${encodeURIComponent("https://other.example/")}`)).status, 404);

  const unpaid = await world.fetch(`https://${DOCTOR_HOST}/api/v1/preflight?url=${encodeURIComponent("https://api.shop.example/item")}`);
  assert.equal(unpaid.status, 402);
  const r = await wallet.pay({ url: `https://${DOCTOR_HOST}/api/v1/preflight?url=${encodeURIComponent("https://api.shop.example/item")}&max_usd=0.05`, maxUsd: 0.01 });
  const verdict = await r.response.json();
  assert.equal(r.payment.amount_usd, 0.001);
  assert.equal(verdict.verdict, "go");
  assert.equal(verdict.recommended_option, 1, "the cheapest option");
  assert.equal(verdict.signals.track_record.days_checked, 12);

  const spotCtx = setup();
  routeDoctor(spotCtx.ctx, {
    trust: { "https://api.shop.example/item": goodTrack(12, 0.02) },
    spot: { "https://api.shop.example/item": { url: "https://api.shop.example/item", result: "charged_not_delivered", charged_usd: 0.02, status: 500, request: "example", date: "2026-10-11" } },
  });
  const withSpot = await (await spotCtx.world.fetch(`https://${DOCTOR_HOST}/api/trust?url=${encodeURIComponent("https://api.shop.example/item")}`)).json();
  assert.equal(withSpot.spot_buy.result, "charged_not_delivered", "the track record carries the spot-buy, as the real /api/trust does");

  const outcome = await world.fetch(`https://${DOCTOR_HOST}/api/v1/outcome`, { method: "POST", body: JSON.stringify({ outcome: "paid_ok" }) });
  assert.equal(outcome.status, 200);
  assert.deepEqual(events.map((e) => e.type), ["preflight", "outcome"]);
  assert.equal((await world.fetch(`https://${DOCTOR_HOST}/api/v1/fix`)).status, 404);
});
