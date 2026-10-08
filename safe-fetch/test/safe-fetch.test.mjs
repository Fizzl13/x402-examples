// Offline: the endpoint, Doctor and the payment are fakes; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafeFetch, SafePayError, usdCap, preflightUrl, diagnosisOf, BASE, canonicalJson, inputHash, verifyReceipt, DOCTOR_SIGNERS, AUTHORITY, certMessage } from "../index.js";
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
function world({ verdict = "go", summary = "OK to pay: $0.02 on Base.", doctorStatus = 200, tamper = null } = {}) {
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
        const body = await signed({ verdict, summary, reasons: [] }, url);
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
  const sf = make(w, { diagnoseOnFailure: true, onDiagnosis: (r, info) => seen.push([r.overall, info.status]) });
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
function outcomeWorld({ endpointStatus = 200 } = {}) {
  const log = { reports: [] };
  const baseFetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/v1/outcome")) {
      log.reports.push({ ua: init.headers["user-agent"], body: JSON.parse(init.body) });
      return Response.json({ accepted: true });
    }
    return Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  };
  const createPayingFetch = () => async (url) => {
    if (url.includes("/api/v1/preflight")) return Response.json(await signed({ verdict: "go", summary: "OK", reasons: [] }, url));
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
  assert.match(ua, /^x402-safe-fetch\/0\.6\.0$/);
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
  // Base and Solana keep the first option on the network (x402's spend controls cap USDC there).
  assert.equal(payableOption([{ network: "eip155:8453", asset: "0xA" }], "eip155:8453", 0.05).asset, "0xA");
});

test("network aliases: 'algorand' and 'xrpl' become their CAIP-2 ids in the preflight", async () => {
  for (const [alias, id] of [["algorand", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="], ["xrpl", "xrpl:0"], ["xrpl-testnet", "xrpl:1"]]) {
    const w = world();
    await make(w, { network: alias })(PAID);
    assert.equal(w.log.preflights[0].url.searchParams.get("network"), id);
  }
});
