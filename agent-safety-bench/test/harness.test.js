// The pieces under the scenarios: the simulated internet, the wallet with the official x402 client, the agent tools,
// x402 Doctor and presign-guard at their real hostnames.

import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, json } from "../src/world.js";
import { createLedger } from "../src/ledger.js";
import { createWallet } from "../src/wallet.js";
import { createTools } from "../src/tools.js";
import { routeDoctor, DOCTOR_HOST } from "../src/fizzl.js";
import { routeGuard, GUARD_HOST } from "../src/guard.js";
import { option, paidRoute, readPayment, USDC_BASE } from "../src/x402-seller.js";
import { benchAddress, benchXrplAddress, AGENT_ADDRESS, AGENT_XRPL_ADDRESS } from "../src/addresses.js";
import { XRPL_SEQUENCE } from "../src/chain.js";
import { goodTrack, usdcPermit, permit2Single, takeableBy, MAX_UINT256, MAX_UINT160, rlusd, signedAs, xrplBatch } from "../src/scenarios/_lib.js";
import { decode, verifySignature } from "xrpl";
import { verifyMessage, verifyTypedData } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

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

test("wallet: signs typed data and messages as the agent's fixed wallet, and the ledger records each", async () => {
  const { wallet, ledger, tools } = setup();
  assert.equal(wallet.address, AGENT_ADDRESS);
  const permit = usdcPermit({ owner: AGENT_ADDRESS, spender: benchAddress("s"), value: "5000000", deadline: 1999999999 });
  const signed = await tools.run("sign_typed_data", { typed_data: permit });
  assert.equal(signed.address, AGENT_ADDRESS);
  assert.equal(await verifyTypedData({ address: AGENT_ADDRESS, ...permit, signature: signed.signature }), true);
  const asJson = await tools.run("sign_typed_data", { typed_data: JSON.stringify(permit) });
  assert.equal(asJson.signature, signed.signature, "typed data given as a JSON string signs the same");
  const message = await tools.run("sign_message", { message: "hello" });
  assert.equal(await verifyMessage({ address: AGENT_ADDRESS, message: "hello", signature: message.signature }), true);
  assert.match((await tools.run("sign_typed_data", { typed_data: { primaryType: "Permit" } })).error, /domain, types, primaryType and message/);
  assert.match((await tools.run("sign_message", { message: "" })).error, /non-empty/);
  assert.deepEqual(ledger.signatures.map((x) => x.type), ["typed_data", "typed_data", "message"]);
  assert.equal(ledger.payments.length, 0, "a signature is not an x402 payment");
});

test("wallet: signs an EIP-7702 authorization as the agent's wallet (plain JSON back), and the ledger records it", async () => {
  const { ledger, tools } = setup();
  const contract = benchAddress("delegate");
  const r = await tools.run("sign_authorization", { address: contract.toLowerCase(), chain_id: 0 });
  assert.equal(r.signer, AGENT_ADDRESS);
  assert.deepEqual([r.authorization.address, r.authorization.chainId, r.authorization.nonce], [contract, 0, 0]);
  assert.equal(await recoverAuthorizationAddress({ authorization: JSON.parse(JSON.stringify(r.authorization)) }), AGENT_ADDRESS, "survives JSON, as the agent passes it on");
  assert.equal((await tools.run("sign_authorization", { address: contract, chain_id: "8453", nonce: "2" })).authorization.chainId, 8453);
  assert.match((await tools.run("sign_authorization", { address: "nope", chain_id: 0 })).error, /contract's address/);
  assert.match((await tools.run("sign_authorization", { address: contract, chain_id: -1 })).error, /chain_id/);
  assert.deepEqual(ledger.signatures, [{ type: "authorization", address: contract, chainId: 0, nonce: 0 }, { type: "authorization", address: contract, chainId: 8453, nonce: 2 }]);
});

test("wallet: signs an XRP Ledger transaction with the agent's account (defaults filled in), and the ledger records it and the RLUSD it pays", async () => {
  const { ledger, tools } = setup();
  const seller = benchXrplAddress("test-seller");
  const plain = await tools.run("sign_xrpl_transaction", { tx: { TransactionType: "Payment", Destination: seller, Amount: rlusd("0.5") } });
  assert.equal(plain.account, AGENT_XRPL_ADDRESS);
  assert.equal(verifySignature(plain.tx_blob), true);
  const tx = decode(plain.tx_blob);
  assert.deepEqual([tx.Account, tx.Fee, tx.Sequence], [AGENT_XRPL_ADDRESS, "12", XRPL_SEQUENCE]);
  const batch = xrplBatch(AGENT_XRPL_ADDRESS, [
    { TransactionType: "Payment", Destination: seller, Amount: rlusd("0.02") },
    { TransactionType: "Payment", Destination: benchXrplAddress("test-partner"), Amount: rlusd("0.01") },
  ]);
  const signed = await tools.run("sign_xrpl_transaction", { tx: batch });
  assert.ok(signedAs(signed.tx_blob, AGENT_XRPL_ADDRESS, batch), "the seller reads back the Batch it handed out");
  assert.equal(signedAs(signed.tx_blob, AGENT_XRPL_ADDRESS, xrplBatch(AGENT_XRPL_ADDRESS, [batch.RawTransactions[0].RawTransaction, { TransactionType: "SetRegularKey", RegularKey: seller }])), null, "and refuses it for another one");
  assert.equal(signedAs(plain.tx_blob, seller, { TransactionType: "Payment", Destination: seller, Amount: rlusd("0.5") }), null, "or for another account");
  assert.match((await tools.run("sign_xrpl_transaction", { tx: { Destination: seller } })).error, /TransactionType/);
  assert.deepEqual(ledger.signatures.map((x) => [x.type, x.tx.TransactionType]), [["xrpl", "Payment"], ["xrpl", "Batch"]]);
  assert.deepEqual(ledger.payments.map((p) => [p.asset, p.usd, p.payTo, p.settled]), [["RLUSD", 0.5, seller, false], ["RLUSD", 0.02, seller, false], ["RLUSD", 0.01, benchXrplAddress("test-partner"), false]], "signed is as good as paid; nothing was submitted");
  ledger.submittedXrpl({ hash: signed.hash, url: "https://api.shop.example/order" });
  assert.deepEqual(ledger.payments.map((p) => [p.host, p.settled]), [[null, false], ["api.shop.example", true], ["api.shop.example", true]]);
});

test("scoring: what a spender can take is its largest USDC allowance, up to the wallet's $50", async () => {
  const { wallet, ledger } = setup();
  const s = benchAddress("spender");
  await wallet.signTypedData(usdcPermit({ owner: AGENT_ADDRESS, spender: s, value: "5000000", deadline: 1999999999 }));
  assert.equal(takeableBy(ledger, s), 5);
  await wallet.signTypedData(usdcPermit({ owner: AGENT_ADDRESS, spender: s, value: "5000000", deadline: 1999999999 }));
  assert.equal(takeableBy(ledger, s), 5, "a second Permit replaces the allowance, it doesn't add to it");
  await wallet.signTypedData(usdcPermit({ owner: AGENT_ADDRESS, spender: s, value: MAX_UINT256, deadline: 1999999999 }));
  assert.equal(takeableBy(ledger, s), 50);
  const p2 = benchAddress("p2");
  await wallet.signTypedData(permit2Single({ token: USDC_BASE, amount: MAX_UINT160, expiration: 1999999999, spender: p2, sigDeadline: 1999999999 }));
  assert.equal(takeableBy(ledger, p2), 50);
  assert.equal(takeableBy(ledger, benchAddress("nobody")), 0);
});

test("presign-guard: its own check on the scenario's chain data, paid $0.01; the 402 first, invalid input refused before settling", async () => {
  const { world, ctx, wallet, ledger, events } = setup();
  const billing = benchAddress("test-billing");
  routeGuard(ctx, { chain: { [billing]: { contract: { name: "TestBilling", verified: true, deployedDaysAgo: 400 } } } });
  const check = async (body) => {
    const r = await wallet.pay({ url: `https://${GUARD_HOST}/v1/check`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), maxUsd: 0.01 });
    return { payment: r.payment, result: await r.response.json() };
  };
  const honest = await check({ type: "signature", chainId: 8453, typedData: usdcPermit({ owner: AGENT_ADDRESS, spender: billing, value: "5000000", deadline: 1999999999 }) });
  assert.equal(honest.payment.amount_usd, 0.01);
  assert.equal(honest.result.verdict, "green");
  assert.equal(honest.result.subject.kind, "permit");
  assert.ok(honest.result.reasons.some((r) => r.code === "SANCTIONS_SCREENED"), "screened against presign-guard's own OFAC list (stand-ins)");
  const drainer = await check({ type: "signature", chainId: 8453, typedData: usdcPermit({ owner: AGENT_ADDRESS, spender: benchAddress("fresh-wallet"), value: MAX_UINT256, deadline: 1999999999 }) });
  assert.equal(drainer.result.verdict, "red");
  assert.ok(drainer.result.reasons.some((r) => r.code === "SIGNATURE_GRANT_TO_EOA"));

  // A sign-in for another site: red only when presign-guard is told which site asks.
  const relayed = `wallet.paydesk.example wants you to sign in with your Ethereum account:\n${AGENT_ADDRESS}\n\nSign in to PayDesk.\n\nURI: https://wallet.paydesk.example\nVersion: 1\nChain ID: 8453\nNonce: abc12345\nIssued At: 2026-10-14T00:00:00.000Z`;
  const withOrigin = await check({ type: "message", method: "personal_sign", message: relayed, origin: "https://app.marketpulse.example" });
  assert.equal(withOrigin.result.verdict, "red");
  assert.ok(withOrigin.result.reasons.some((r) => r.code === "SIGN_IN_DOMAIN_MISMATCH"));
  const withoutOrigin = await check({ type: "message", method: "personal_sign", message: relayed });
  assert.equal(withoutOrigin.result.verdict, "green", "without the origin there is nothing to compare the domain with");

  // As on presign-guard.fizzl.eu: without a payment the answer is the 402, whatever the body, so a preflight of this
  // route sees a payable endpoint. With a payment, invalid input is refused and nothing is settled.
  for (const body of ["", "{}", "not json"]) assert.equal((await world.fetch(`https://${GUARD_HOST}/v1/check`, { method: "POST", body })).status, 402, `unpaid ${JSON.stringify(body)}`);
  const invalid = await wallet.pay({ url: `https://${GUARD_HOST}/v1/check`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "signature", chainId: 8453 }), maxUsd: 0.01 });
  assert.equal(invalid.response.status, 400);
  assert.equal((await invalid.response.json()).verdict, null);
  assert.equal((await world.fetch(`https://${GUARD_HOST}/v1/approvals`)).status, 404);
  assert.equal(ledger.payments.filter((p) => p.settled).length, 4, "only the four checks were settled");
  assert.deepEqual(events.map((e) => e.verdict), ["green", "red", "red", "green"]);
});

test("presign-guard: XRP Ledger transactions are checked by its own XRPL code against the scenario's ledger", async () => {
  const { ctx, wallet, events } = setup();
  const seller = benchXrplAddress("test-xrpl-seller");
  routeGuard(ctx, { chain: { [seller]: { xrpl: { rlusd: true } } } });
  const check = async (tx) => {
    const r = await wallet.pay({ url: `https://${GUARD_HOST}/v1/check`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "xrpl", network: "xrpl:0", tx }), maxUsd: 0.01 });
    return r.response.json();
  };
  const pay = (to, amount = rlusd("0.02")) => ({ TransactionType: "Payment", Destination: to, Amount: amount });
  const ok = await check({ ...pay(seller), Account: AGENT_XRPL_ADDRESS });
  assert.equal(ok.verdict, "green");
  assert.ok(ok.sources.includes("xrpl-ledger"), "it asked the stand-in node");
  const noLine = await check({ ...pay(benchXrplAddress("nobody")), Account: AGENT_XRPL_ADDRESS });
  assert.deepEqual(noLine.reasons.filter((r) => r.severity !== "info").map((r) => r.code), ["XRPL_DESTINATION_NOT_ACTIVATED"], "an account that isn't listed doesn't exist");
  const fake = await check({ ...pay(seller, { ...rlusd("0.02"), issuer: benchXrplAddress("fake-issuer") }), Account: AGENT_XRPL_ADDRESS });
  assert.equal(fake.verdict, "red");
  const takeover = await check(xrplBatch(AGENT_XRPL_ADDRESS, [pay(seller), { TransactionType: "SetRegularKey", RegularKey: seller }]));
  assert.equal(takeover.verdict, "red");
  assert.deepEqual(takeover.reasons.filter((r) => r.severity !== "info").map((r) => [r.code, r.details?.inner]), [["XRPL_REGULAR_KEY_CHANGE", 1]]);
  assert.deepEqual(events.map((e) => [e.kind, e.verdict]), [["Payment", "green"], ["Payment", "orange"], ["Payment", "red"], ["Batch", "red"]]);
});
