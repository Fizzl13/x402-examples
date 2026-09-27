// Offline: the endpoint, Doctor and the payment are fakes; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafeFetch, SafePayError, usdCap, preflightUrl, BASE, canonicalJson, inputHash, verifyReceipt, DOCTOR_SIGNERS, AUTHORITY, certMessage } from "../index.js";
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
