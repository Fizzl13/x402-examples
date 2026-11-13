// 0.20.9: safeFetch(url, init, { maxUsd }) caps one call, e.g. at the price the user named. Held-out set 3 (12 Nov 2026):
// the user named 5 cents, the seller asked 12, within the task's budget, and safe-fetch paid it. Offline: fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSafeFetch, canonicalJson, inputHash } from "../index.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: `r${Math.random()}`, route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-13T08:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
const URL_ = "https://api.wattprice.example/v1/spot?zone=NL&hour=18";

// The endpoint asks `price`; Doctor says no_go when that is over the max_usd it was asked with (as the live one does).
function world(price) {
  const log = { probes: 0, preflights: [], paid: [] };
  const baseFetch = async () => {
    log.probes += 1;
    return Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(Math.round(price * 1e6)), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111" }] }, { status: 402 });
  };
  const createPayingFetch = (cap) => async (url) => {
    if (url.includes("/api/v1/preflight")) {
      const max = Number(new URL(url).searchParams.get("max_usd"));
      log.preflights.push(max);
      const over = price > max;
      return Response.json(await signed(over ? { verdict: "no_go", summary: `Do not pay: $${price} is over your budget of $${max}`, reasons: [{ level: "no_go", code: "over_budget" }] } : { verdict: "go", summary: "OK to pay", reasons: [] }, url));
    }
    log.paid.push(cap);
    return Response.json({ eur_per_mwh: 112.4 });
  };
  return { log, baseFetch, createPayingFetch };
}
const make = (w, options = {}) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.2, doctorSigners: [doctorKey.address], ...options });

test("a call's maxUsd is the preflight's max_usd and the payment's cap: a price over it is no_go and not paid", async () => {
  const w = world(0.12);
  await assert.rejects(make(w)(URL_, {}, { maxUsd: 0.05 }), (err) => {
    assert.equal(err.code, "no_go");
    assert.match(err.message, /over your budget of \$0\.05/);
    return true;
  });
  assert.deepEqual(w.log.preflights, [0.05]);
  assert.deepEqual(w.log.paid, []);
});

test("at or under the named price it is paid, capped at that price; without it, maxUsd applies as before", async () => {
  const w = world(0.05);
  const sf = make(w);
  assert.equal((await sf(URL_, {}, { maxUsd: 0.05 })).status, 200);
  assert.equal((await sf(URL_)).status, 200);
  assert.deepEqual(w.log.preflights, [0.05, 0.2], "a verdict asked with another max_usd is not reused");
  assert.deepEqual(w.log.paid, ["$0.05", "$0.2"]);
});

test("a call's maxUsd never raises maxUsd; a bad one is a TypeError before anything is fetched", async () => {
  const w = world(0.12);
  const sf = make(w, { maxUsd: 0.1 });
  await assert.rejects(sf(URL_, {}, { maxUsd: 5 }), (err) => err.code === "no_go");
  assert.deepEqual(w.log.preflights, [0.1]);
  for (const bad of [0, -1, "five cents", Infinity]) await assert.rejects(sf(URL_, {}, { maxUsd: bad }), TypeError);
  assert.equal(w.log.probes, 1, "only the first call reached the endpoint");
});

test("with a total budget, the call's cap is what one payment may count", async () => {
  const w = world(0.03);
  const sf = make(w, { maxTotalUsd: 0.2 });
  await sf(URL_, {}, { maxUsd: 0.04 });
  assert.deepEqual(w.log.paid, ["$0.04"]);
  assert.equal(sf.spent().totalUsd, 0.03);
});
