// 0.20.10: a paid request whose answer never came is sent again with the same signed payment, never a new one.
// Held-out set 4 (13 Nov 2026): the seller settled, then the connection dropped; the agent tried again, and safe-fetch
// signed and paid a second time. Offline: a fake seller and a fake x402 client that signs through safe-fetch's fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSafeFetch, canonicalJson, inputHash } from "../index.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: `r${Math.random()}`, route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-13T15:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
const URL_ = "https://api.registrydesk.example/v1/extract?kvk=90412377";
const dropped = (code, message) => Object.assign(new Error(message), { code });

// The seller: a 402 without a payment; a payment is settled once per signature. `answer(n, settledNow)` decides what
// the n-th paid request gets: a Response, or an error to throw (the connection dropped).
function world(answer) {
  const log = { signatures: [], settled: new Set(), paidRequests: 0 };
  const baseFetch = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const headers = new Headers(init?.headers ?? req?.headers);
    const sig = headers.get("payment-signature");
    if (!sig) {
      return Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "30000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111" }] }, { status: 402 });
    }
    log.paidRequests += 1;
    const out = answer(log.paidRequests, sig, log);
    if (out instanceof Error) throw out;
    return out;
  };
  // An x402 client as @x402/fetch is one: asks without a payment, then signs a new payment and sends it.
  const createPayingFetch = (cap, fetchImpl) => async (url, init) => {
    if (String(url).includes("/api/v1/preflight")) return Response.json(await signed({ verdict: "go", summary: "OK to pay", reasons: [] }, url));
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;
    const sig = `sig-${log.signatures.length + 1}`;
    log.signatures.push(sig);
    return fetchImpl(url, { ...init, headers: { ...(init?.headers ?? {}), "payment-signature": sig } });
  };
  const log_ = log;
  return { log: log_, baseFetch, createPayingFetch };
}
const make = (w, options = {}) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.15, maxTotalUsd: 0.15, doctorSigners: [doctorKey.address], ...options });
const settle = (log, sig) => log.settled.add(sig);

test("the seller settled, then the connection dropped: the same payment is sent again and delivers, one payment in all", async () => {
  const w = world((n, sig, log) => {
    settle(log, sig);
    return n === 1 ? dropped("ECONNRESET", "socket hang up") : Response.json({ kvk: "90412377", name: "Kade Analytics B.V." });
  });
  const sf = make(w);
  const res = await sf(URL_);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "Kade Analytics B.V.");
  assert.deepEqual(w.log.signatures, ["sig-1"], "one payment signed");
  assert.equal(w.log.paidRequests, 2, "sent twice, with the same payment");
  assert.equal(w.log.settled.size, 1);
  assert.equal(sf.spent().totalUsd, 0.03);
});

test("the connection was refused before the seller got it: the same payment is sent again and settles then (the honest twin)", async () => {
  const w = world((n, sig, log) => {
    if (n === 1) return dropped("ECONNREFUSED", "connect ECONNREFUSED api.registrydesk.example:443");
    settle(log, sig);
    return Response.json({ valid: true });
  });
  const res = await make(w)(URL_);
  assert.equal(res.status, 200);
  assert.deepEqual(w.log.signatures, ["sig-1"]);
});

test("no answer either time: answer_lost, still counted, and paying the endpoint again is refused without signing", async () => {
  const w = world((n, sig, log) => {
    settle(log, sig);
    return dropped("ECONNRESET", "socket hang up");
  });
  const sf = make(w);
  await assert.rejects(sf(URL_), (err) => {
    assert.equal(err.code, "answer_lost");
    assert.match(err.message, /no answer came back.*not paid a second time/s);
    return true;
  });
  assert.equal(sf.spent().totalUsd, 0.03, "the seller may have settled it: it stays counted");
  await assert.rejects(sf(`${URL_}&retry=1`), (err) => {
    assert.equal(err.code, "paid_no_delivery");
    assert.match(err.message, /no answer came back/);
    return true;
  });
  assert.deepEqual(w.log.signatures, ["sig-1"], "no second payment signed");
  assert.equal(w.log.paidRequests, 2);
});

test("the same payment sent again is refused with a 402: not paid again, still counted, the endpoint blocked", async () => {
  const w = world((n, sig, log) => {
    if (n === 1) {
      settle(log, sig);
      return dropped("ECONNRESET", "socket hang up");
    }
    return Response.json({ x402Version: 2, error: "payment already used", accepts: [] }, { status: 402 });
  });
  const sf = make(w);
  const res = await sf(URL_).catch((err) => err);
  assert.ok(res.status === 402 || res.code === "paid_no_delivery", `a 402 or a refusal, got ${res.status ?? res.code}`);
  assert.equal(sf.spent().totalUsd, 0.03);
  await assert.rejects(sf(URL_), (err) => err.code === "paid_no_delivery" && /same payment sent again was refused/.test(err.message));
  assert.deepEqual(w.log.signatures, ["sig-1"]);
});

test("an answer that comes back the first time is not sent again", async () => {
  const w = world((n, sig, log) => {
    settle(log, sig);
    return Response.json({ ok: 1 });
  });
  await make(w)(URL_);
  assert.equal(w.log.paidRequests, 1);
});
