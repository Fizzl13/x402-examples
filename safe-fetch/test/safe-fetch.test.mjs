// Offline: the endpoint, Doctor and the payment are fakes; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION, createSafeFetch, SafePayError, usdCap, preflightUrl, diagnosisOf, BASE, canonicalJson, inputHash, verifyReceipt, DOCTOR_SIGNERS, AUTHORITY, certMessage } from "../index.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// A stand-in for Doctor's signer: preflights are signed like the live service signs them.
const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url, key = doctorKey, cert = null) {
  const receipt = { request_id: "r1", route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), ...(cert && { cert }), signed_at: "2026-09-27T10:00:00.000Z", signer: key.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await key.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const PAID = "https://api.example.com/paid";
const FREE = "https://api.example.com/free";

// A world with one paid endpoint, Doctor answering `verdict`, and a paying fetch that records its cap.
function world({ verdict = "go", summary = "OK to pay: $0.02 on Base.", doctorStatus = 200, tamper = null, extra = {} } = {}) {
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
        if (doctorStatus !== 200) return Response.json({ error: "boom" }, { status: doctorStatus });
        const body = await signed({ verdict, summary, reasons: [], ...extra }, url);
        return Response.json(tamper ? await tamper(body, url) : body);
      }
      log.paid.push({ cap, url, method: init.method ?? "GET", body: init.body });
      return Response.json({ ok: true });
    };
  };
  return { log, baseFetch, createPayingFetch };
}

const make = (w, options = {}) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.05, doctorSigners: [doctorKey.address], ...options });

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

test("go with checks_complete false: pays by default; onIncomplete 'stop' throws code incomplete naming what didn't run; a function decides; reused at most 10 minutes", async () => {
  const extra = { checks_complete: false, not_checked: [{ check: "sanctions", because: "unavailable", why: "x" }, { check: "track_record", because: "no_data", why: "y" }] };
  const dflt = world({ extra });
  await make(dflt)(PAID);
  assert.equal(dflt.log.paid.length, 1);

  const stop = world({ extra });
  await assert.rejects(make(stop, { onIncomplete: "stop" })(PAID), (err) => {
    assert.equal(err.code, "incomplete");
    assert.match(err.message, /not every check ran \(sanctions\)/);
    return true;
  });
  assert.equal(stop.log.paid.length, 0);

  const asked = [];
  const yes = world({ extra });
  await make(yes, { onIncomplete: async (p) => { asked.push(p.checks_complete); return true; } })(PAID);
  assert.deepEqual(asked, [false]);
  assert.equal(yes.log.paid.length, 1);

  let t = 0;
  const cached = world({ extra });
  const f = make(cached, { now: () => t });
  await f(PAID);
  t = 11 * 60 * 1000;
  await f(PAID);
  assert.equal(cached.log.preflights.length, 2, "an incomplete verdict is asked again after 10 minutes");
  const full = world({ extra: { checks_complete: true } });
  const g = make(full, { now: () => t });
  t = 0;
  await g(PAID);
  t = 11 * 60 * 1000;
  await g(PAID);
  assert.equal(full.log.preflights.length, 1, "a complete verdict is reused for the hour");
  assert.throws(() => createSafeFetch({ register: () => {}, onIncomplete: "maybe" }), /onIncomplete/);
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

test("a verdict is reused per method and URL while the offer stays the same (an hour), then asked again", async () => {
  const w = world();
  let t = 0;
  const safeFetch = make(w, { now: () => t });
  await safeFetch(PAID);
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 1);
  await safeFetch(PAID, { method: "POST", body: "{}" });
  assert.equal(w.log.preflights.length, 2, "another method is another check");
  t = 59 * 60 * 1000;
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 2, "same offer: still reused");
  t = 60 * 60 * 1000 + 1;
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 3);
  assert.equal(w.log.paid.length, 5);
});

test("a changed offer (price, payout address, token, network) is checked again at once; a new invoice id is not a change", async () => {
  const offer = { scheme: "exact", network: BASE, asset: "0xUSDC", amount: "20000", payTo: "0xSeller", extra: { invoiceId: "a" } };
  let current = offer;
  const w = world();
  w.baseFetch = async (url) => {
    const challenge = { x402Version: 2, accepts: [current] };
    return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
  };
  let t = 0;
  const safeFetch = make(w, { now: () => t });
  await safeFetch(PAID);
  current = { ...offer, extra: { invoiceId: "b" } };
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 1, "a per-request invoice id doesn't count");
  for (const change of [{ payTo: "0xAttacker" }, { amount: "900000" }, { asset: "0xOther" }, { network: "solana:x" }]) {
    t += 1000;
    const n = w.log.preflights.length;
    current = { ...offer, ...change };
    await safeFetch(PAID);
    assert.equal(w.log.preflights.length, n + 1, JSON.stringify(change));
  }
});

test("without a readable x402 offer, a verdict is reused for at most 10 minutes", async () => {
  const w = world();
  w.baseFetch = async () => new Response("not json", { status: 402 });
  let t = 0;
  const safeFetch = make(w, { now: () => t });
  await safeFetch(PAID);
  t = 9 * 60 * 1000;
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 1);
  t = 10 * 60 * 1000 + 1;
  await safeFetch(PAID);
  assert.equal(w.log.preflights.length, 2);
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

test("signed receipts: a changed, unsigned, foreign or mismatched preflight is never a payment", async () => {
  for (const [name, tamper, reason] of [
    ["verdict flipped to go", (b) => ({ ...b, verdict: "go" }), /answer was changed/],
    ["no receipt", ({ receipt, ...b }) => b, /no signed receipt/],
    ["receipt for another request", (b) => b, /different request/],
  ]) {
    const w = world({ verdict: name === "verdict flipped to go" ? "no_go" : "go", tamper: name === "receipt for another request" ? null : tamper });
    const options = name === "receipt for another request" ? { maxUsd: 0.05 } : {};
    let fetchFn = make(w, options);
    if (name === "receipt for another request") {
      // Doctor signs for a different budget than the one we asked with.
      const inner = w.createPayingFetch;
      w.createPayingFetch = (cap) => async (url, init) => inner(cap)(url.includes("/api/v1/preflight") ? url.replace("max_usd=0.05", "max_usd=1") : url, init);
      fetchFn = make(w);
    }
    await assert.rejects(fetchFn(PAID), (err) => {
      assert.equal(err.code, "bad_receipt", name);
      assert.match(err.message, reason, name);
      return true;
    });
    assert.equal(w.log.paid.length, 0, `${name}: nothing paid`);
  }
  const stranger = world();
  await assert.rejects(make(stranger, { doctorSigners: ["0x0000000000000000000000000000000000000001"] })(PAID), (err) => err.code === "bad_receipt" && /unknown key/.test(err.message));
  assert.equal(stranger.log.paid.length, 0);
});

test("signed receipts: verifyReceipts 'off' skips the check; the published signer is pinned by default", async () => {
  const w = world({ tamper: ({ receipt, ...b }) => b });
  const res = await make(w, { verifyReceipts: "off" })(PAID);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(DOCTOR_SIGNERS, ["0xAaE66eF9Ee234397df33901568c8FBc36d43277d"]);
  assert.throws(() => createSafeFetch({ register: () => {}, verifyReceipts: "maybe" }), /verifyReceipts/);
});

test("signed receipts: a real Doctor receipt from production verifies (27 Sep 2026 preflight)", () => {
  const live = {"url":"https://ichimoku-signal.onrender.com/signal/BTC-USDT","method":"GET","verdict":"go","safe_to_pay":true,"summary":"OK to pay: $0.02 on Base.","recommended_option":0,"options":[{"index":0,"network":"eip155:8453","network_name":"Base","testnet":false,"scheme":"exact","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","asset_symbol":"USDC","amount":"20000","usd":0.02,"pay_to":"0x6B0F4651eD42893ab58139938175E4a69f175F25","payable":true,"problems":[]},{"index":1,"network":"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp","network_name":"Solana","testnet":false,"scheme":"exact","asset":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","asset_symbol":"USDC","amount":"20000","usd":0.02,"pay_to":"ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9","payable":true,"problems":[]}],"signals":{"https":true,"advertised_price_usd":0.02,"listed_in_cdp_bazaar":false,"origin_in_cdp_bazaar":true,"track_record":null,"x402_version":2},"reasons":[],"checked_at":"2026-09-27T07:47:00.700Z","cached":false,"receipt":{"request_id":"edddd0ee-ff3a-4470-80bb-b92a82e17d96","route":"GET /api/v1/preflight","input_sha256":"2da6ecd53282b9699f961b5095b926a46c9044ecc5d6cf88080d65eaabe63af1","signed_at":"2026-09-27T07:47:00.700Z","signer":"0xAaE66eF9Ee234397df33901568c8FBc36d43277d","algorithm":"eip191-canonical-json-v1","signature":"0xdcad07dfb5f05ee688bc62144759d928f7527c2157437485b0868969c1f118250e2677d910a81ee91be55bc8ac1fbf1c7487910ec5ab0d890f8475aa49821a481c"}};
  const input = { url: "https://ichimoku-signal.onrender.com/signal/BTC-USDT", max_usd: "0.05" };
  assert.equal(verifyReceipt(live, { route: "GET /api/v1/preflight", input }).valid, true);
  assert.equal(verifyReceipt({ ...live, verdict: "no_go" }).valid, false);
});

test("key rotation: a new Doctor key certified by the payout wallet is trusted without a new release", async () => {
  assert.equal(AUTHORITY, "0x6B0F4651eD42893ab58139938175E4a69f175F25");
  const payout = privateKeyToAccount(generatePrivateKey()); // stands in for the payout wallet
  const rotated = privateKeyToAccount(generatePrivateKey()); // Doctor's new signing key, not pinned anywhere
  const certBy = async (key, service = "x402-doctor", validFrom = "2026-09-01") => {
    const c = { service, signer: rotated.address, valid_from: validFrom, authority: payout.address };
    return { ...c, signature: await key.signMessage({ message: certMessage(c) }) };
  };
  const resign = (cert) => async ({ receipt, ...body }, url) => signed(body, url, rotated, cert);

  const ok = world({ tamper: resign(await certBy(payout)) });
  const res = await make(ok, { authority: payout.address })(PAID);
  assert.deepEqual(await res.json(), { ok: true }, "certified: paid");

  for (const [name, cert, options] of [
    ["no certificate", null, { authority: payout.address }],
    ["certified by someone else", await certBy(privateKeyToAccount(generatePrivateKey())), { authority: payout.address }],
    ["certified for another service", await certBy(payout, "presign-guard"), { authority: payout.address }],
    ["used before valid_from", await certBy(payout, "x402-doctor", "2999-01-01"), { authority: payout.address }],
    ["certificates switched off", await certBy(payout), { authority: null }],
  ]) {
    const w = world({ tamper: resign(cert) });
    await assert.rejects(make(w, options)(PAID), (err) => err.code === "bad_receipt" && /unknown key/.test(err.message), name);
    assert.equal(w.log.paid.length, 0, `${name}: nothing paid`);
  }
});

// Doctor's diagnosis, signed like the live service signs it.
async function signedDiagnosis(body, url, key = doctorKey) {
  const route = "GET /api/v1/diagnose";
  const receipt = { request_id: "d1", route, input_sha256: inputHash(route, Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-09-30T10:00:00.000Z", signer: key.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await key.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

// A world whose endpoint takes the payment but still answers 402 (or throws), with a Doctor that diagnoses.
function failingWorld({ endpoint = "402", signer = doctorKey } = {}) {
  const log = { diagnoses: [], caps: [] };
  const report = { url: PAID, overall: "fail", checks: [{ id: "network", status: "fail", message: "Payment option is on Base Sepolia, not Base mainnet." }] };
  const baseFetch = async () => Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  const createPayingFetch = (cap) => {
    log.caps.push(cap);
    return async (url, init = {}) => {
      if (url.includes("/api/v1/preflight")) return Response.json(await signed({ verdict: "go", summary: "OK", reasons: [] }, url));
      if (url.includes("/api/v1/diagnose")) {
        log.diagnoses.push({ cap, url: new URL(url), ua: init.headers?.["user-agent"] });
        return Response.json(await signedDiagnosis(report, url, signer));
      }
      if (endpoint === "throw") throw new Error("payment rejected by facilitator");
      return Response.json({ error: "payment invalid" }, { status: 402 });
    };
  };
  return { log, report, baseFetch, createPayingFetch };
}

test("diagnoseOnFailure off (default): a failed payment is not diagnosed", async () => {
  const w = failingWorld();
  const res = await make(w)(PAID);
  assert.equal(res.status, 402);
  assert.equal(w.log.diagnoses.length, 0);
});

test("diagnoseOnFailure: a payment answered with 402 again gets one signed Doctor diagnosis, capped at $0.02 and reused", async () => {
  const w = failingWorld();
  const seen = [];
  // onPaidError "pay": this test pays the same request twice on purpose (by default the second would be refused).
  const sf = make(w, { diagnoseOnFailure: true, onPaidError: "pay", onDiagnosis: (r, info) => seen.push([r.overall, info.status]) });
  const res = await sf(PAID);
  assert.equal(res.status, 402);
  const d = diagnosisOf(res);
  assert.equal(d.overall, "fail");
  assert.match(d.checks[0].message, /Base Sepolia/);
  assert.equal(w.log.diagnoses.length, 1);
  assert.equal(w.log.diagnoses[0].cap, "$0.02");
  assert.equal(w.log.diagnoses[0].url.searchParams.get("url"), PAID);
  assert.match(w.log.diagnoses[0].ua, /^x402-safe-fetch\//);
  assert.deepEqual(seen, [["fail", 402]]);
  await sf(PAID);
  assert.equal(w.log.diagnoses.length, 1); // reused within cacheMs
});

test("diagnoseOnFailure: when paying throws, the error carries the diagnosis and is rethrown", async () => {
  const w = failingWorld({ endpoint: "throw" });
  await assert.rejects(make(w, { diagnoseOnFailure: true })(PAID), (err) => {
    assert.match(err.message, /payment rejected/);
    assert.equal(err.diagnosis.overall, "fail");
    return true;
  });
});

test("diagnoseOnFailure: a diagnosis not signed by Doctor is dropped, never shown", async () => {
  const w = failingWorld({ signer: privateKeyToAccount(generatePrivateKey()) });
  const res = await make(w, { diagnoseOnFailure: true })(PAID);
  assert.equal(res.status, 402);
  assert.equal(diagnosisOf(res), null);
});

// A world that records the outcome reports sent to Doctor.
function outcomeWorld({ endpointStatus = 200, verdict = "go", reasons = [], refusal = undefined } = {}) {
  const log = { reports: [], toSeller: [] };
  const baseFetch = async (url, init = {}) => {
    if (String(url).endsWith("/.well-known/x402-refusal") || String(url).includes("victim")) {
      log.toSeller.push({ url: String(url), redirect: init.redirect, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith("/api/v1/outcome")) {
      log.reports.push({ ua: init.headers["user-agent"], body: JSON.parse(init.body) });
      return Response.json({ accepted: true });
    }
    return Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  };
  const createPayingFetch = () => async (url) => {
    if (url.includes("/api/v1/preflight")) return Response.json(await signed({ verdict, summary: verdict === "go" ? "OK" : "Not safe", reasons, ...(refusal ? { refusal } : {}) }, url));
    return Response.json(endpointStatus === 200 ? { ok: true } : { error: "x" }, { status: endpointStatus });
  };
  return { log, baseFetch, createPayingFetch };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("shareOutcomes off (default): nothing is reported", async () => {
  const w = outcomeWorld();
  await make(w)(PAID);
  await tick();
  assert.equal(w.log.reports.length, 0);
});

test("shareOutcomes: after paying, Doctor gets the outcome with the signed preflight and its query, once per preflight", async () => {
  const w = outcomeWorld();
  const sf = make(w, { shareOutcomes: true });
  await sf(PAID);
  await tick();
  assert.equal(w.log.reports.length, 1);
  const { body, ua } = w.log.reports[0];
  assert.equal(body.outcome, "paid_ok");
  assert.equal(body.status, 200);
  assert.equal(body.preflight.verdict, "go");
  assert.ok(body.preflight.receipt.request_id);
  assert.deepEqual(body.query, { url: PAID, method: "GET", max_usd: "0.05", network: BASE });
  assert.equal(inputHash("GET /api/v1/preflight", body.query), body.preflight.receipt.input_sha256);
  assert.match(ua, /^x402-safe-fetch\/0\.20\.8$/);
  await sf(PAID); // the cached verdict: same preflight, not reported twice
  await tick();
  assert.equal(w.log.reports.length, 1);
});

test("shareOutcomes: a payment answered with 402 again is paid_failed, a 500 is paid_error", async () => {
  const failed = outcomeWorld({ endpointStatus: 402 });
  const res = await make(failed, { shareOutcomes: true })(PAID);
  assert.equal(res.status, 402);
  await tick();
  assert.equal(failed.log.reports[0].body.outcome, "paid_failed");
  const error = outcomeWorld({ endpointStatus: 500 });
  await make(error, { shareOutcomes: true })(PAID);
  await tick();
  assert.equal(error.log.reports[0].body.outcome, "paid_error");
});

test("Algorand and the XRP Ledger: only USDC / Ripple's RLUSD are paid, RLUSD within the budget in dollars", async () => {
  const { payableOption, ALGORAND, XRPL } = await import("../index.js");
  const RLUSD = "524C555344000000000000000000000000000000";
  const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
  const algo = [
    { scheme: "exact", network: ALGORAND, asset: "123", amount: "1000" },
    { scheme: "exact", network: ALGORAND, asset: "31566704", amount: "1000" },
  ];
  assert.equal(payableOption(algo, ALGORAND, 0.05).asset, "31566704", "USDC, not another ASA");
  assert.equal(payableOption([algo[0]], ALGORAND, 0.05), null);
  const xrpl = (amount, extra = { issuer: ISSUER }, asset = RLUSD) => ({ scheme: "exact", network: XRPL, asset, amount, extra });
  assert.ok(payableOption([xrpl("0.001")], XRPL, "$0.002"));
  assert.equal(payableOption([xrpl("2")], XRPL, 0.05), null, '"2" is two dollars, over a $0.05 budget');
  assert.equal(payableOption([xrpl("0.01", { issuer: "rFakeIssuer" })], XRPL, 0.05), null, "an RLUSD look-alike");
  assert.equal(payableOption([xrpl("1000", {}, "XRP")], XRPL, 0.05), null, "never XRP");
  assert.equal(payableOption([xrpl("0.02")], XRPL, 0.05).amount, "0.02");
  // Base: of two exact options, the cheapest within the budget ($0.50 listed first, $0.01 second: the exam's
  // expensive-first-option); none within the budget: the first exact one, as before (x402's cap then refuses it).
  const evm = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount, payTo: "0x1111111111111111111111111111111111111111" });
  assert.equal(payableOption([evm("500000"), evm("10000")], "eip155:8453", 1).amount, "10000");
  assert.equal(payableOption([evm("500000"), evm("10000")], "eip155:8453", 0.05).amount, "10000");
  assert.equal(payableOption([evm("500000"), evm("200000")], "eip155:8453", 0.05).amount, "500000");
  // 0.20.1: only options to the first option's payee, in its token, are compared. A cheaper option to another address
  // (the held-out test's stranger-cheaper-option) or in another token is not picked; the first option is.
  const other = (amount, payTo, asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") => ({ ...evm(amount), payTo, asset });
  assert.equal(payableOption([evm("20000"), other("15000", "0x2222222222222222222222222222222222222222")], "eip155:8453", 0.1).payTo, "0x1111111111111111111111111111111111111111");
  assert.equal(payableOption([evm("20000"), other("15000", "0x1111111111111111111111111111111111111111", "0x4200000000000000000000000000000000000006")], "eip155:8453", 0.1).amount, "20000", "not another token");
  const mixed = { ...evm("20000"), payTo: "0xAbCdEf0000000000000000000000000000000001" };
  assert.equal(payableOption([mixed, other("15000", "0xabcdef0000000000000000000000000000000001")], "eip155:8453", 0.1).amount, "15000", "the same payee in another letter case");
  // The first option over the budget and a cheaper one to someone else: nothing within the budget to that payee, so
  // the first one is returned and x402's cap refuses it (never the stranger's).
  assert.equal(payableOption([evm("500000"), other("10000", "0x2222222222222222222222222222222222222222")], "eip155:8453", 0.05).amount, "500000");
  // Stellar: only Circle's USDC contract, within the budget (7 decimals: 100000 is $0.01).
  const { STELLAR } = await import("../index.js");
  const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
  const st = (amount, asset = USDC_SAC) => ({ scheme: "exact", network: STELLAR, asset, amount, extra: { areFeesSponsored: true } });
  assert.equal(payableOption([st("100000", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"), st("100000")], STELLAR, 0.05).asset, USDC_SAC, "USDC, not another contract");
  assert.ok(payableOption([st("10000")], STELLAR, "$0.002"), "the $0.001 preflight");
  assert.equal(payableOption([st("10000000")], STELLAR, 0.05), null, "$1 is over a $0.05 budget");
  assert.equal(payableOption([st("1.5")], STELLAR, 0.05), null, "an atomic amount only");
  // X Layer: only USD₮0 or the USDC Doctor knows, within the budget (6 decimals: 10000 is $0.01).
  const { XLAYER } = await import("../index.js");
  const xl = (amount, asset = "0x779ded0c9e1022225f8e0630b35a9b54be713736") => ({ scheme: "exact", network: XLAYER, asset, amount, extra: { name: "USD₮0", version: "1" } });
  assert.equal(payableOption([xl("10000", "0xb6ceceab302e2e4948951ee7843fc24e92933061"), xl("10000")], XLAYER, 0.05).asset, "0x779ded0c9e1022225f8e0630b35a9b54be713736", "not another token called USDC");
  assert.ok(payableOption([xl("10000", "0x74B7F16337B8972027F6196A17A631AC6DE26D22")], XLAYER, 0.05), "USDC, any case");
  assert.ok(payableOption([xl("1000")], XLAYER, "$0.002"), "the $0.001 preflight");
  assert.equal(payableOption([xl("1000000")], XLAYER, 0.05), null, "$1 is over a $0.05 budget");
  // Base and Solana keep the first option on the network (x402's spend controls cap USDC there).
  assert.equal(payableOption([{ network: "eip155:8453", asset: "0xA" }], "eip155:8453", 0.05).asset, "0xA");
});

test("network aliases: 'algorand' and 'xrpl' become their CAIP-2 ids in the preflight", async () => {
  for (const [alias, id] of [["algorand", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="], ["xrpl", "xrpl:0"], ["xrpl-testnet", "xrpl:1"], ["xlayer", "eip155:196"]]) {
    const w = world();
    await make(w, { network: alias })(PAID);
    assert.equal(w.log.preflights[0].url.searchParams.get("network"), id);
  }
});

test("shareOutcomes: not paid after a no_go or a stopped caution is reported as refused, with the reason code", async () => {
  const noGo = outcomeWorld({ verdict: "no_go", reasons: [{ level: "info", code: "onchain_payments" }, { level: "no_go", code: "payto_sanctioned" }] });
  await assert.rejects(make(noGo, { shareOutcomes: true })(PAID), (e) => e.code === "no_go");
  await tick();
  assert.equal(noGo.log.reports.length, 1);
  const { body } = noGo.log.reports[0];
  assert.deepEqual([body.outcome, body.reason, body.source, body.preflight.verdict], ["refused", "payto_sanctioned", "doctor", "no_go"]);
  assert.equal(inputHash("GET /api/v1/preflight", body.query), body.preflight.receipt.input_sha256);
  const caution = outcomeWorld({ verdict: "caution", reasons: [{ level: "caution", code: "payto_changed" }] });
  const sf = make(caution, { shareOutcomes: true });
  await assert.rejects(sf(PAID), (e) => e.code === "caution");
  await assert.rejects(sf(PAID), (e) => e.code === "caution"); // the cached verdict: reported once
  await tick();
  assert.deepEqual(caution.log.reports.map((r) => [r.body.outcome, r.body.reason]), [["refused", "payto_changed"]]);
  // A caution the agent pays anyway is a payment, not a refusal.
  const paid = outcomeWorld({ verdict: "caution", reasons: [{ level: "caution", code: "payto_changed" }] });
  await make(paid, { shareOutcomes: true, onCaution: "pay" })(PAID);
  await tick();
  assert.equal(paid.log.reports[0].body.outcome, "paid_ok");
  // Off by default.
  const off = outcomeWorld({ verdict: "no_go", reasons: [{ level: "no_go", code: "x" }] });
  await assert.rejects(make(off)(PAID));
  await tick();
  assert.equal(off.log.reports.length, 0);
});

test("refusalReason: the first reason at the verdict's level, as a code Doctor accepts", async () => {
  const { refusalReason } = await import("../index.js");
  assert.equal(refusalReason({ verdict: "caution", reasons: [{ level: "info", code: "a_b" }, { level: "caution", code: "price_changed" }] }), "price_changed");
  assert.equal(refusalReason({ verdict: "no_go", reasons: [] }), "no_go");
  assert.equal(refusalReason({ verdict: "no_go", reasons: [{ level: "no_go", code: "Weird-Code!" }] }), "weird_code_");
  assert.equal(refusalReason(null), "refused");
});

// The draft refusal extension (x402-foundation/x402#4087): with tellSellers, the seller hears why it wasn't paid.
test("tellSellers: a no_go for a seller that takes refusals sends Doctor's ready report to the seller, once a day; off by default", async () => {
  const report = { x402Version: 2, resource: PAID, offer: { hash: "a".repeat(64), acceptIndex: 0 }, reason: "network_unsupported", detail: "x402 Doctor preflight: network_not_offered", checkedAt: "2026-11-01T08:00:00.000Z" };
  const refusal = { url: "https://api.example.com/.well-known/x402-refusal", send_if: "you do not pay", report };
  const reasons = [{ level: "no_go", code: "network_not_offered" }];
  const w = outcomeWorld({ verdict: "no_go", reasons, refusal });
  const sf = make(w, { tellSellers: true, cacheMs: 0 });
  await assert.rejects(sf(PAID), (e) => e.code === "no_go");
  await assert.rejects(sf(PAID), (e) => e.code === "no_go");
  await tick();
  assert.equal(w.log.toSeller.length, 1, "once a day per endpoint and reason");
  assert.equal(w.log.toSeller[0].url, refusal.url);
  assert.equal(w.log.toSeller[0].redirect, "error");
  assert.deepEqual(w.log.toSeller[0].body, report, "the report as is: no \"by\" naming this client");
  assert.equal(w.log.reports.length, 0, "tellSellers alone sends nothing to Doctor");

  const off = outcomeWorld({ verdict: "no_go", reasons, refusal });
  await assert.rejects(make(off)(PAID), (e) => e.code === "no_go");
  await tick();
  assert.equal(off.log.toSeller.length, 0, "off by default");

  // Never to another site, and never a report about another endpoint.
  const elsewhere = outcomeWorld({ verdict: "no_go", reasons, refusal: { ...refusal, url: "https://victim.example/hook" } });
  await assert.rejects(make(elsewhere, { tellSellers: true })(PAID), (e) => e.code === "no_go");
  const other = outcomeWorld({ verdict: "no_go", reasons, refusal: { ...refusal, report: { ...report, resource: "https://api.example.com/other" } } });
  await assert.rejects(make(other, { tellSellers: true })(PAID), (e) => e.code === "no_go");
  await tick();
  assert.equal(elsewhere.log.toSeller.length + other.log.toSeller.length, 0);

  // A screening_hit only signed (draft 0.2): this client can't sign, so it isn't sent.
  const hit = outcomeWorld({ verdict: "no_go", reasons: [{ level: "no_go", code: "payto_sanctioned" }], refusal: { ...refusal, signature_required: true, report: { ...report, reason: "screening_hit" } } });
  await assert.rejects(make(hit, { tellSellers: true })(PAID), (e) => e.code === "no_go");
  await tick();
  assert.equal(hit.log.toSeller.length, 0);
});

// The paid-twice guard (paid-guard.js): the exam's costliest mistake was paying again after a seller took the
// payment and answered with an error.
function paidErrorWorld(statuses) {
  const log = { paid: [], preflights: 0 };
  const baseFetch = async () => Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  const createPayingFetch = () => async (url, init = {}) => {
    if (url.includes("/api/v1/preflight")) {
      log.preflights++;
      return Response.json(await signed({ verdict: "go", summary: "OK", reasons: [] }, url));
    }
    log.paid.push({ url, method: init.method ?? "GET", body: init.body });
    const status = statuses.shift() ?? 200;
    return Response.json(status === 200 ? { ok: true } : { error: "x" }, { status });
  };
  return { log, baseFetch, createPayingFetch };
}

test("paid-twice guard: an endpoint paid and answered with an error is not paid again (no preflight bought either); another endpoint is", async () => {
  let t = 1_000_000;
  const w = paidErrorWorld([405]);
  const sf = make(w, { now: () => t });
  assert.equal((await sf(PAID, { method: "POST", body: '{"q":1}' })).status, 405);
  await assert.rejects(sf(PAID, { method: "POST", body: '{"q":1}' }), (err) => {
    assert.ok(err instanceof SafePayError);
    assert.equal(err.code, "paid_no_delivery");
    assert.deepEqual(err.earlier, { at: 1_000_000, status: 405 });
    assert.match(err.message, /already paid .* HTTP 405 without delivering/);
    return true;
  });
  assert.equal(w.log.paid.length, 1);
  assert.equal(w.log.preflights, 1, "the second call stopped before buying a preflight");
  // Another body or query on the same endpoint is still that endpoint: not paid.
  await assert.rejects(sf(PAID, { method: "POST", body: '{"q":2}' }), { code: "paid_no_delivery" });
  await assert.rejects(sf(`${PAID}?nonce=1`, { method: "POST", body: '{"q":1}' }), { code: "paid_no_delivery" });
  assert.equal(w.log.paid.length, 1);
  // Another method or path is another endpoint.
  await sf(PAID, { method: "GET" });
  await sf("https://api.example.com/other", { method: "POST", body: '{"q":1}' });
  assert.equal(w.log.paid.length, 3);
  // After the window the endpoint may be paid again.
  t += 30 * 60 * 1000;
  await sf(PAID, { method: "POST", body: '{"q":1}' });
  assert.equal(w.log.paid.length, 4);
});

test("paid-twice guard: changing the query string doesn't get around it (the exam's '&nonce=1' loop)", async () => {
  const w = paidErrorWorld([402, 402, 402]);
  const sf = make(w);
  const url = `${PAID}?to=nl&text=The%20meeting%20is%20moved`;
  assert.equal((await sf(url)).status, 402);
  for (const again of [url, `${url}&nonce=1`, `${url}&nonce=2`, `${PAID}/?to=nl`, `${PAID}#retry`]) {
    await assert.rejects(sf(again), (err) => {
      assert.equal(err.code, "paid_no_delivery");
      assert.match(err.message, /^not paid again: https:\/\/api\.example\.com\/paid was already paid .* HTTP 402/);
      assert.doesNotMatch(err.message, /meeting/, "the message names the endpoint, not the query");
      return true;
    });
  }
  assert.equal(w.log.paid.length, 1, "one payment lost, not nine");

  const { purchaseKey } = await import("../index.js");
  assert.equal(purchaseKey(`${PAID}?a=1#x`, { method: "post", body: "{}" }), "POST https://api.example.com/paid");
  assert.equal(purchaseKey("https://API.example.com:443/paid/"), "GET https://api.example.com/paid");
  assert.equal(purchaseKey("not a url?q=1"), "GET not a url");
});

test("paid-twice guard: another 402 after paying blocks too; a success clears; trusted hosts are guarded as well", async () => {
  const w = paidErrorWorld([402]);
  const sf = make(w, { trusted: ["api.example.com"] });
  assert.equal((await sf(PAID)).status, 402);
  await assert.rejects(sf(PAID), { code: "paid_no_delivery" });
  assert.equal(w.log.paid.length, 1);

  const { createPaidGuard } = await import("../index.js");
  const g = createPaidGuard();
  g.record(PAID, { method: "GET" }, 500);
  assert.equal(g.blocked(PAID, {}).status, 500);
  g.record(PAID, {}, 200);
  assert.equal(g.blocked(PAID, {}), null);
});

test("paid-twice guard: a paid answer that redirects blocks the URL it sends the agent to (0.20.2, the held-out second paywall)", async () => {
  // The seller takes its payment and answers 303 to a download host, which asks for the same price again.
  const DL = "https://dl.example-cdn.com/r/77";
  const log = { paid: [] };
  const baseFetch = async () => Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  const createPayingFetch = () => async (url, init = {}) => {
    if (url.includes("/api/v1/preflight")) return Response.json(await signed({ verdict: "go", summary: "OK", reasons: [] }, url));
    log.paid.push(url);
    return new Response(JSON.stringify({ location: DL }), { status: 303, headers: { location: DL, "content-type": "application/json" } });
  };
  const sf = make({ baseFetch, createPayingFetch });
  assert.equal((await sf(PAID)).status, 303);
  await assert.rejects(sf(DL), (err) => {
    assert.equal(err.code, "paid_no_delivery");
    assert.equal(err.earlier.redirectedFrom, "https://api.example.com/paid");
    assert.match(err.message, /^not paid: https:\/\/api\.example\.com\/paid was paid at .* and sent you here \(HTTP 303\)/);
    return true;
  });
  assert.deepEqual(log.paid, [PAID], "the download host was not paid");

  // A fetch that followed the redirect itself: the answer is the download host's 402, with redirected and url set.
  const { createPaidGuard } = await import("../index.js");
  const g = createPaidGuard();
  g.record(PAID, {}, 402, { redirectedTo: DL });
  assert.equal(g.blocked(`${DL}?token=1`, {}).redirectedFrom, "https://api.example.com/paid");
  // A relative Location is read against the paid URL; a success blocks nothing.
  g.record("https://api.example.com/report", {}, 302, { redirectedTo: "/files/9" });
  assert.equal(g.blocked("https://api.example.com/files/9", {}).status, 302);
  const ok = createPaidGuard();
  ok.record(PAID, {}, 200, { redirectedTo: DL });
  assert.equal(ok.blocked(DL, {}), null);
});

test("paid-twice guard: onPaidError 'pay' pays again, a function decides, anything else is refused", async () => {
  const pay = paidErrorWorld([500, 500]);
  const sf = make(pay, { onPaidError: "pay" });
  await sf(PAID);
  await sf(PAID);
  assert.equal(pay.log.paid.length, 2);

  const asked = [];
  const ask = paidErrorWorld([500]);
  const sf2 = make(ask, { onPaidError: (earlier, info) => { asked.push([earlier.status, info.url]); return asked.length > 1; } });
  await sf2(PAID);
  await assert.rejects(sf2(PAID), { code: "paid_no_delivery" });
  assert.equal((await sf2(PAID)).status, 200);
  assert.deepEqual(asked, [[500, PAID], [500, PAID]]);
  assert.throws(() => createSafeFetch({ createPayingFetch: () => fetch, onPaidError: "maybe" }), /onPaidError/);
});

// 0.20.3: the payout address safe-fetch would pay, from the 402 it got, goes with the preflight as pay_to (held-out
// set 2: a seller showed the checker a clean address and the buyer one on the sanctions list).
test("pay_to: the preflight names the address it would pay; Doctor's caution on it stops the payment; the outcome report carries it", async () => {
  const SELLER = "0x1111111111111111111111111111111111111111";
  const offerWorld = (verdict, reasons = []) => {
    const log = { preflights: [], paid: [], reports: [] };
    const baseFetch = async (url, init = {}) => {
      if (String(url).endsWith("/api/v1/outcome")) {
        log.reports.push(JSON.parse(init.body));
        return Response.json({ accepted: true });
      }
      const accepts = [{ scheme: "exact", network: BASE, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "20000", payTo: SELLER, maxTimeoutSeconds: 60 }];
      return Response.json({ x402Version: 2, accepts }, { status: 402 });
    };
    const createPayingFetch = () => async (url) => {
      if (url.includes("/api/v1/preflight")) {
        log.preflights.push(new URL(url));
        return Response.json(await signed({ verdict, summary: verdict, reasons }, url));
      }
      log.paid.push(url);
      return Response.json({ ok: true });
    };
    return { log, baseFetch, createPayingFetch };
  };
  const ok = offerWorld("go");
  await make(ok, { shareOutcomes: true })(PAID);
  await tick();
  assert.equal(ok.log.preflights[0].searchParams.get("pay_to"), SELLER);
  assert.equal(ok.log.paid.length, 1);
  // The outcome report carries the query the preflight was bought with, pay_to included: Doctor binds them.
  assert.equal(ok.log.reports[0].query.pay_to, SELLER);
  assert.equal(inputHash("GET /api/v1/preflight", ok.log.reports[0].query), ok.log.reports[0].preflight.receipt.input_sha256);
  // The seller showed Doctor another address: caution, not paid.
  const cloaked = offerWorld("caution", [{ level: "caution", code: "payto_not_shown", message: "Your agent was asked to pay another address than x402 Doctor was shown." }]);
  await assert.rejects(make(cloaked)(PAID), (e) => e instanceof SafePayError && e.code === "caution" && e.preflight.reasons[0].code === "payto_not_shown");
  assert.equal(cloaked.log.paid.length, 0);
  // A 402 without a readable option: no pay_to. And preflightUrl drops anything that isn't one address.
  const w = world();
  await make(w)(PAID);
  assert.equal(w.log.preflights[0].url.searchParams.has("pay_to"), false);
  assert.equal(new URL(preflightUrl(PAID, { payTo: "0x1 or more" })).searchParams.has("pay_to"), false);
  assert.equal(new URL(preflightUrl(PAID, { payTo: SELLER })).searchParams.get("pay_to"), SELLER);
});

// 0.20.4: a paid 202 Accepted is not a delivery yet (held-out set 2: a seller answered 202 and charged again for every
// poll, and safe-fetch paid three times for one summary).
test("paid-twice guard: after a paid 202, paying the endpoint or its poll URL again is refused until the result is handed over", async () => {
  const POLL = `${PAID}?job=J-1`;
  // Charges again on every poll of the same endpoint (another query): the second payment is refused.
  const log = { paid: [] };
  const baseFetch = async () => Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  const createPayingFetch = () => async (url) => {
    if (url.includes("/api/v1/preflight")) return Response.json(await signed({ verdict: "go", summary: "OK", reasons: [] }, url));
    log.paid.push(url);
    return Response.json({ status: "processing", poll_url: POLL }, { status: 202 });
  };
  const sf = make({ baseFetch, createPayingFetch });
  assert.equal((await sf(PAID)).status, 202);
  await assert.rejects(sf(POLL), (err) => {
    assert.equal(err.code, "paid_no_delivery");
    assert.equal(err.earlier.status, 202);
    assert.match(err.message, /answered 202 Accepted: the purchase is being prepared, not delivered/);
    return true;
  });
  assert.deepEqual(log.paid, [PAID], "the poll was not paid");

  // An honest seller: the poll URL (another path) is free and hands over the result; after that the endpoint can be
  // bought again.
  const JOB = "https://api.example.com/jobs/7";
  let polls = 0;
  const honest = { paid: [] };
  const baseFetch2 = async (url) => {
    if (url === JOB) return ++polls < 2 ? Response.json({ status: "processing" }, { status: 202 }) : Response.json({ image: "7.jpg" });
    return Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  };
  const createPayingFetch2 = () => async (url) => {
    if (url.includes("/api/v1/preflight")) return Response.json(await signed({ verdict: "go", summary: "OK", reasons: [] }, url));
    honest.paid.push(url);
    return new Response(JSON.stringify({ status: "processing" }), { status: 202, headers: { location: "/jobs/7", "content-type": "application/json" } });
  };
  const sf2 = make({ baseFetch: baseFetch2, createPayingFetch: createPayingFetch2 });
  assert.equal((await sf2(PAID)).status, 202);
  assert.equal((await sf2(JOB)).status, 202, "a free poll is answered as is");
  assert.deepEqual(await (await sf2(JOB)).json(), { image: "7.jpg" });
  assert.equal((await sf2(PAID)).status, 202, "delivered: a new purchase on the endpoint is paid");
  assert.equal(honest.paid.length, 2);

  // The guard on its own: a POST endpoint's poll URL (GET) is blocked from payment; its delivery ends both holds.
  const { createPaidGuard } = await import("../index.js");
  const g = createPaidGuard();
  g.record(PAID, { method: "POST" }, 202, { pollAt: "/jobs/9" });
  assert.equal(g.blocked(PAID, { method: "POST" }).status, 202);
  assert.equal(g.blocked("https://api.example.com/jobs/9", {}).pollOf, "https://api.example.com/paid");
  g.delivered("https://api.example.com/jobs/9", {});
  assert.equal(g.blocked(PAID, { method: "POST" }), null);
  assert.equal(g.blocked("https://api.example.com/jobs/9", {}), null);
  // A 200 still clears as before; a 202 without a poll URL holds the endpoint alone.
  g.record(PAID, {}, 202);
  assert.equal(g.blocked(PAID, {}).status, 202);
  g.record(PAID, {}, 200);
  assert.equal(g.blocked(PAID, {}), null);
});

// 0.20.6: sites, the sites the owner named (held-out set 2: the docs named an unrelated host as the API server).
test("sites: a payment asked on another site is refused before the preflight; subdomains of a named site are paid", async () => {
  const { siteOf } = await import("../index.js");
  assert.equal(siteOf("api.metroquote.example"), "metroquote.example");
  assert.equal(siteOf("https://www.metroquote.example/openapi.json"), "metroquote.example");
  assert.equal(siteOf("shop.example.co.uk"), "example.co.uk");
  assert.equal(siteOf("seller-a.vercel.app"), "seller-a.vercel.app");
  const w = world();
  const sf = make(w, { sites: ["https://www.example.com/openapi.json"] });
  assert.deepEqual(await (await sf("https://api.example.com/paid")).json(), { ok: true }, "a subdomain of a named site is paid");
  await assert.rejects(sf("https://api.example-gateway.com/paid"), (err) => {
    assert.equal(err.code, "other_site");
    assert.match(err.message, /^not paid: api\.example-gateway\.com is not on a site this agent may pay \(example\.com\)/);
    return true;
  });
  assert.equal(w.log.preflights.length, 1, "no preflight bought for the other site");
  assert.equal(w.log.paid.length, 1);
  // A free answer on another site is answered as is: only payments are limited.
  const free = world();
  free.baseFetch = async () => Response.json({ free: true });
  assert.deepEqual(await (await make(free, { sites: ["example.com"] })("https://other.example.org/free")).json(), { free: true });
  // Without sites nothing changes; a bad list is refused.
  assert.equal((await make(world())("https://api.example-gateway.com/paid")).status, 200);
  for (const bad of [[], "example.com", [""], [42]]) assert.throws(() => make(world(), { sites: bad }), /sites must be/);
});
