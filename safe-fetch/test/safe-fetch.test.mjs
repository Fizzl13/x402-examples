// Offline: the endpoint, Doctor and the payment are fakes; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafeFetch, SafePayError, usdCap, preflightUrl, BASE } from "../index.js";

const PAID = "https://api.example.com/paid";
const FREE = "https://api.example.com/free";

// A world with one paid endpoint, Doctor answering `verdict`, and a paying fetch that records its cap.
function world({ verdict = "go", summary = "OK to pay: $0.02 on Base.", doctorStatus = 200 } = {}) {
  const log = { probes: [], preflights: [], paid: [], caps: [] };
  const baseFetch = async (url, init = {}) => {
    log.probes.push([url, init.method ?? "GET"]);
    return url === FREE ? Response.json({ free: true }) : Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  };
  const createPayingFetch = (cap) => {
    log.caps.push(cap);
    return async (url, init = {}) => {
      if (url.includes("/api/v1/preflight")) {
        log.preflights.push({ cap, url: new URL(url) });
        return doctorStatus === 200 ? Response.json({ verdict, summary, reasons: [] }) : Response.json({ error: "boom" }, { status: doctorStatus });
      }
      log.paid.push({ cap, url, method: init.method ?? "GET", body: init.body });
      return Response.json({ ok: true });
    };
  };
  return { log, baseFetch, createPayingFetch };
}

const make = (w, options = {}) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.05, ...options });

test("a free endpoint is answered as is: no preflight, nothing paid", async () => {
  const w = world();
  const res = await make(w)(FREE);
  assert.deepEqual(await res.json(), { free: true });
  assert.equal(w.log.preflights.length, 0);
  assert.equal(w.log.paid.length, 0);
});

test("go: the preflight (capped at $0.002) carries url, method, budget and network; then the endpoint is paid within the budget", async () => {
  const w = world();
  const seen = [];
  const res = await make(w, { onPreflight: (p, info) => seen.push([p.verdict, info]) })(PAID, { method: "POST", body: '{"a":1}' });
  assert.deepEqual(await res.json(), { ok: true });
  const q = w.log.preflights[0].url.searchParams;
  assert.equal(w.log.preflights[0].cap, "$0.002");
  assert.deepEqual([q.get("url"), q.get("method"), q.get("max_usd"), q.get("network")], [PAID, "POST", "0.05", BASE]);
  assert.deepEqual(w.log.paid, [{ cap: "$0.05", url: PAID, method: "POST", body: '{"a":1}' }]);
  assert.deepEqual(seen, [["go", { url: PAID, method: "POST", cached: false }]]);
});

test("no_go: throws SafePayError with the preflight; the endpoint is not paid", async () => {
  const w = world({ verdict: "no_go", summary: "Do not pay: over your budget" });
  await assert.rejects(make(w)(PAID), (err) => {
    assert.ok(err instanceof SafePayError);
    assert.equal(err.code, "no_go");
    assert.match(err.message, /over your budget/);
    assert.equal(err.preflight.verdict, "no_go");
    return true;
  });
  assert.equal(w.log.paid.length, 0);
});

test("caution: stops by default; pays with onCaution 'pay'; asks a function otherwise", async () => {
  const stop = world({ verdict: "caution" });
  await assert.rejects(make(stop)(PAID), { code: "caution" });
  assert.equal(stop.log.paid.length, 0);

  const pay = world({ verdict: "caution" });
  await make(pay, { onCaution: "pay" })(PAID);
  assert.equal(pay.log.paid.length, 1);

  const asked = [];
  const no = world({ verdict: "caution" });
  await assert.rejects(make(no, { onCaution: async (p) => { asked.push(p.verdict); return false; } })(PAID), { code: "caution" });
  const yes = world({ verdict: "caution" });
  await make(yes, { onCaution: async () => true })(PAID);
  assert.deepEqual(asked, ["caution"]);
  assert.equal(no.log.paid.length, 0);
  assert.equal(yes.log.paid.length, 1);
});

test("a verdict is reused for 10 minutes per method and URL, then asked again", async () => {
  const w = world();
  let t = 0;
  const safeFetch = make(w, { now: () => t });
  await safeFetch(PAID);
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 1);
  await safeFetch(PAID, { method: "POST", body: "{}" });
  assert.equal(w.log.preflights.length, 2, "another method is another check");
  t = 10 * 60 * 1000 + 1;
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 3);
  assert.equal(w.log.paid.length, 4);
});

test("trusted hosts are paid without a preflight", async () => {
  const w = world({ verdict: "no_go" });
  await make(w, { trusted: ["api.example.com"] })(PAID);
  assert.equal(w.log.preflights.length, 0);
  assert.equal(w.log.paid.length, 1);
});

test("Doctor failing is never a payment", async () => {
  const w = world({ doctorStatus: 502 });
  await assert.rejects(make(w)(PAID), { code: "preflight_failed" });
  assert.equal(w.log.paid.length, 0);
});

test("input checks: stream bodies, Request objects, budgets, register", async () => {
  const w = world();
  await assert.rejects(make(w)(PAID, { method: "POST", body: new ReadableStream() }), /stream/);
  await assert.rejects(make(w)(new Request(PAID)), /not a Request/);
  assert.equal(usdCap(0.05), "$0.05");
  assert.equal(usdCap("$0.001"), "$0.001");
  assert.throws(() => usdCap(0), /positive/);
  assert.throws(() => usdCap("abc"), /positive/);
  assert.throws(() => createSafeFetch({}), /register is required/);
  assert.throws(() => createSafeFetch({ register: () => {}, onCaution: "maybe" }), /onCaution/);
  assert.equal(new URL(preflightUrl(PAID, { network: "solana:x" })).searchParams.get("network"), "solana:x");
});

test("network aliases: 'solana' becomes the CAIP-2 id in the preflight", async () => {
  const w = world();
  await make(w, { network: "solana" })(PAID);
  assert.equal(w.log.preflights[0].url.searchParams.get("network"), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
});

test("default paying fetch: built from your register function, with a spend cap per client", async () => {
  const registered = [];
  const safeFetch = createSafeFetch({
    register: (client) => registered.push(typeof client.register),
    fetch: async () => Response.json({ free: true }),
  });
  await safeFetch(FREE);
  assert.deepEqual(registered, [], "no client is built for a free endpoint");
});

test("default paying fetch: your register function gets a real x402Client, only once payment is needed", async () => {
  const clients = [];
  const safeFetch = createSafeFetch({
    register: (client) => { clients.push(client); throw new Error("stop here: no real payment in tests"); },
    fetch: async (url) => (url === FREE ? Response.json({}) : Response.json({}, { status: 402 })),
  });
  await safeFetch(FREE);
  assert.equal(clients.length, 0);
  await assert.rejects(safeFetch(PAID), /stop here/);
  assert.equal(clients.length, 1, "the preflight client");
  assert.equal(typeof clients[0].register, "function");
  assert.equal(typeof clients[0].setSpendControls, "function");
});
