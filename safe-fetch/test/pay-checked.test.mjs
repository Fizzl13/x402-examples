// 0.20.7: the payment is built from the 402 safe-fetch read before the preflight (the one whose address went to Doctor
// as pay_to), not from a fresh one. Held-out set 3 (12 Nov 2026): a seller switched its payout address right after the
// check; x402 fetched the 402 again and paid the new address. Offline: the seller and Doctor are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSafeFetch, canonicalJson, inputHash } from "../index.js";

const URL_ = "https://seller.example/data";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FIRST = "0x1111111111111111111111111111111111111111";
const LATER = "0x2222222222222222222222222222222222222222";
const THIRD = "0x3333333333333333333333333333333333333333";
const offer = (payTo) => ({ scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });

// A seller whose 402s ask to be paid at FIRST, then LATER, then THIRD from then on; it takes any payment and records it.
function switchingSeller() {
  const log = { unpaid: 0, paid: [] };
  const fetch = async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const sig = headers.get("payment-signature") ?? headers.get("x-payment");
    if (!sig) {
      log.unpaid += 1;
      const challenge = { x402Version: 2, error: "payment required", resource: { url: URL_, description: "data", mimeType: "application/json" }, accepts: [offer([FIRST, LATER, THIRD][Math.min(log.unpaid, 3) - 1])] };
      return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
    }
    log.paid.push(JSON.parse(Buffer.from(sig, "base64").toString()));
    return Response.json({ ok: true });
  };
  return { log, fetch };
}

test("x402 pays the 402 safe-fetch read, not a fresh one: the seller is asked twice (402, paid request), and paid where its first 402 said", async () => {
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const account = privateKeyToAccount(generatePrivateKey());
  const s = switchingSeller();
  const safeFetch = createSafeFetch({ maxUsd: 0.05, trusted: ["seller.example"], fetch: s.fetch, register: (c) => c.register("eip155:8453", new ExactEvmScheme(account)) });
  const res = await safeFetch(URL_);
  assert.equal(res.status, 200);
  assert.equal(s.log.unpaid, 1, "no second 402 fetched");
  assert.equal(s.log.paid.length, 1);
  assert.equal(s.log.paid[0].payload.authorization.to.toLowerCase(), FIRST);
  assert.equal(s.log.paid[0].accepted.payTo.toLowerCase(), FIRST);
});

// Doctor answers go; the paying fetch is built on the fetch safe-fetch hands it, as x402's is.
const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signedGo(url) {
  const body = { verdict: "go", summary: "OK to pay", reasons: [] };
  const receipt = { request_id: "r1", route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-13T08:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
const payToOf = async (res) => JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString()).accepts[0].payTo;

test("with a preflight: Doctor is asked about the address of the 402 that gets paid (pay_to), and a 402 not used for a payment is never handed to another call", async () => {
  const s = switchingSeller();
  const preflights = [];
  const asked = [];
  let askFirst = true;
  const createPayingFetch = (_cap, fetch) => async (url, init = {}) => {
    if (url.includes("/api/v1/preflight")) {
      preflights.push(new URL(url).searchParams.get("pay_to"));
      return Response.json(await signedGo(url));
    }
    let payTo = null;
    if (askFirst) {
      const first = await fetch(url, init); // as x402 does: the request without payment
      asked.push(first.status);
      payTo = await payToOf(first);
    }
    return s.fetch(url, { ...init, headers: { "payment-signature": Buffer.from(JSON.stringify({ payload: { authorization: { to: payTo } } })).toString("base64") } });
  };
  const safeFetch = createSafeFetch({ maxUsd: 0.05, fetch: s.fetch, createPayingFetch, doctorSigners: [doctorKey.address] });
  await safeFetch(URL_);
  assert.deepEqual(preflights, [FIRST]);
  assert.deepEqual(asked, [402]);
  assert.equal(s.log.unpaid, 1, "the 402 the payment used is the one Doctor was asked about");
  assert.equal(s.log.paid[0].payload.authorization.to, FIRST);

  // A paying fetch that doesn't ask first leaves its 402 unused: the next call gets its own.
  askFirst = false;
  await safeFetch(URL_);
  askFirst = true;
  await safeFetch(URL_);
  assert.deepEqual(preflights, [FIRST, LATER, THIRD]);
  assert.equal(s.log.paid[1].payload.authorization.to, null);
  assert.equal(s.log.paid[2].payload.authorization.to, THIRD, "not the unused 402 of the call before");
  assert.equal(s.log.unpaid, 3);
});
