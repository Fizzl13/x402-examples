// Offline: maxTotalUsd and maxPerSellerUsd. The endpoints, Doctor and the payment are fakes; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafeFetch, SafePayError, BASE, canonicalJson, inputHash, usdOfOption, XRPL, STELLAR } from "../index.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: `r${Math.random()}`, route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-10T10:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const option = (atomic, payTo = "0x1111111111111111111111111111111111111111") => ({ scheme: "exact", network: BASE, asset: USDC, amount: String(atomic), payTo, maxTimeoutSeconds: 60 });

// Every host asks `price` (atomic USDC; null: a 402 without readable options). The paying fetch answers `paidStatus`.
function world({ price = 20000, paidStatus = 200 } = {}) {
  const log = { preflights: 0, paid: [] };
  const baseFetch = async () => Response.json({ x402Version: 2, accepts: price === null ? undefined : [option(price)] }, { status: 402 });
  const createPayingFetch = (cap) => async (url) => {
    if (url.includes("/api/v1/preflight")) {
      log.preflights++;
      return Response.json(await signed({ verdict: "go", summary: "OK to pay.", reasons: [] }, url));
    }
    log.paid.push({ cap, host: new URL(url).host });
    await new Promise((r) => setTimeout(r, 5));
    return Response.json({ ok: paidStatus === 200 }, { status: paidStatus });
  };
  return { log, baseFetch, createPayingFetch };
}
const make = (w, options = {}) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.05, doctorSigners: [doctorKey.address], ...options });
const page = (n, host = "api.reviews.example") => `https://${host}/v1/reviews?page=${n}`;

test("maxTotalUsd: 2-cent pages are paid until $0.10 is spent; the sixth is refused before its preflight", async () => {
  const w = world();
  const pay = make(w, { maxTotalUsd: 0.1 });
  for (let n = 1; n <= 5; n++) assert.equal((await pay(page(n))).status, 200);
  assert.deepEqual(pay.spent(), { totalUsd: 0.1, bySeller: { "api.reviews.example": 0.1 } });
  const before = w.log.preflights;
  await assert.rejects(pay(page(6)), (e) => e instanceof SafePayError && e.code === "over_total_budget" && /\$0 left; the endpoint asks \$0\.02/.test(e.message) && e.spent.totalUsd === 0.1);
  assert.equal(w.log.preflights, before, "no preflight bought for a payment that can't be made");
  assert.equal(w.log.paid.length, 5);
});

test("the last payment is capped at what is left of the total budget", async () => {
  const w = world({ price: 30000 });
  const pay = make(w, { maxTotalUsd: 0.08 });
  await pay(page(1));
  await pay(page(2));
  // $0.02 left, the page asks $0.03: refused.
  await assert.rejects(pay(page(3)), (e) => e.code === "over_total_budget");
  assert.deepEqual(w.log.paid.map((p) => p.cap), ["$0.05", "$0.05"]);
  const w2 = world({ price: 20000 });
  const pay2 = make(w2, { maxTotalUsd: 0.07 });
  await pay2(page(1));
  await pay2(page(2));
  await pay2(page(3));
  assert.deepEqual(w2.log.paid.map((p) => p.cap), ["$0.05", "$0.05", "$0.03"], "x402's own cap shrinks to what is left");
});

test("maxPerSellerUsd: one seller's budget doesn't stop another seller", async () => {
  const w = world();
  const pay = make(w, { maxPerSellerUsd: 0.04 });
  await pay(page(1));
  await pay(page(2));
  await assert.rejects(pay(page(3)), (e) => e.code === "over_seller_budget" && e.message.includes("api.reviews.example"));
  assert.equal((await pay(page(1, "api.other.example"))).status, 200);
  assert.deepEqual(pay.spent(), { totalUsd: 0.06, bySeller: { "api.reviews.example": 0.04, "api.other.example": 0.02 } });
});

test("without a readable price, a payment counts as the most it may cost", async () => {
  const w = world({ price: null });
  const pay = make(w, { maxTotalUsd: 0.07 });
  await pay(page(1));
  await pay(page(2));
  assert.deepEqual(w.log.paid.map((p) => p.cap), ["$0.05", "$0.02"]);
  assert.equal(pay.spent().totalUsd, 0.07);
  await assert.rejects(pay(page(3)), (e) => e.code === "over_total_budget");
});

test("a payment that comes back 402 isn't counted; a paid error is", async () => {
  const again = world({ paidStatus: 402 });
  const pay = make(again, { maxTotalUsd: 0.1 });
  await pay(page(1));
  assert.equal(pay.spent().totalUsd, 0);
  const failed = world({ paidStatus: 500 });
  const pay2 = make(failed, { maxTotalUsd: 0.1 });
  await pay2(page(1));
  assert.equal(pay2.spent().totalUsd, 0.02, "the seller took the payment and failed: the money is gone");
});

test("parallel calls can't both spend what is left", async () => {
  const w = world();
  const pay = make(w, { maxTotalUsd: 0.03 });
  const results = await Promise.allSettled([pay(page(1)), pay(page(2))]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "over_total_budget");
  assert.equal(pay.spent().totalUsd, 0.02);
});

test("without maxTotalUsd or maxPerSellerUsd nothing changes: every payment within the per-call budget", async () => {
  const w = world();
  const pay = make(w);
  for (let n = 1; n <= 8; n++) await pay(page(n));
  assert.equal(w.log.paid.length, 8);
  assert.ok(w.log.paid.every((p) => p.cap === "$0.05"));
  assert.throws(() => make(w, { maxTotalUsd: 0 }), /maxUsd must be a positive number/);
});

test("usdOfOption reads USDC, Stellar USDC and RLUSD amounts in dollars", () => {
  assert.equal(usdOfOption({ amount: "20000" }, BASE), 0.02);
  assert.equal(usdOfOption({ amount: "200000" }, STELLAR), 0.02);
  assert.equal(usdOfOption({ amount: "0.02" }, XRPL), 0.02);
  assert.equal(usdOfOption({ amount: "abc" }, BASE), null);
});
