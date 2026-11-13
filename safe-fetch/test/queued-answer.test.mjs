// 0.20.11: a paid 200 that only says the purchase is not ready yet, and asks to be requested again, is held like a 202.
// Held-out set 4 (13 Nov 2026): the seller answered {"status": "queued", ..., "message": "Request it again in a few
// seconds"} and charged the request it asked for again; safe-fetch paid both. Offline: a fake seller and a fake x402
// client that signs through safe-fetch's fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSafeFetch, canonicalJson, inputHash, pendingInAnswer } from "../index.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: `r${Math.random()}`, route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-13T16:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
const ORIGIN = "https://api.plateinfo.example";
const REPORT = (plate) => `${ORIGIN}/v1/report?plate=${plate}`;
const QUEUED = { status: "queued", report_id: "PI-88213", message: "Your report is being compiled. Request it again in a few seconds to receive it." };
const READY = { status: "ready", report_id: "PI-88213", plate: "GZ-417-K", make: "Volkswagen", owners: 3 };

// The seller: a 402 without a payment on a paid path; `paid(n, url)` answers the n-th paid request, `free(url)` a path
// that is never paid (return undefined to ask for a payment there too).
function world({ paid, free = () => undefined }) {
  const log = { signatures: [], paidRequests: 0 };
  const baseFetch = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const url = String(req ? req.url : input);
    const sig = new Headers(init?.headers ?? req?.headers).get("payment-signature");
    if (!sig) {
      const open = free(url);
      if (open) return open;
      return Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "40000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x2222222222222222222222222222222222222222" }] }, { status: 402 });
    }
    log.paidRequests += 1;
    return paid(log.paidRequests, url);
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
  return { log, baseFetch, createPayingFetch };
}
const make = (w) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.2, maxTotalUsd: 0.2, doctorSigners: [doctorKey.address] });

test("a paid 200 that says the report is queued and asks to be requested again: asking again is not paid", async () => {
  const w = world({ paid: (n) => Response.json(n === 1 ? QUEUED : READY) });
  const sf = make(w);
  const first = await sf(REPORT("GZ-417-K"));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "queued", "the answer itself is handed back as it came");
  await assert.rejects(sf(REPORT("GZ-417-K")), (err) => {
    assert.equal(err.code, "paid_no_delivery");
    assert.equal(err.earlier.queued, QUEUED.message);
    assert.match(err.message, /not ready yet.*Request it again in a few seconds/s);
    return true;
  });
  assert.deepEqual(w.log.signatures, ["sig-1"], "one payment signed");
  assert.equal(sf.spent().totalUsd, 0.04);
});

test("the status URL the queued answer names asks to be paid: refused too", async () => {
  const w = world({ paid: () => Response.json({ ...QUEUED, message: "Your report is being compiled.", status_url: "/v1/reports/PI-88213" }) });
  const sf = make(w);
  await sf(REPORT("GZ-417-K"));
  await assert.rejects(sf(`${ORIGIN}/v1/reports/PI-88213`), (err) => {
    assert.equal(err.code, "paid_no_delivery");
    assert.match(err.earlier.pollOf, /\/v1\/report$/);
    assert.match(err.message, /on the status URL it named/);
    return true;
  });
  assert.deepEqual(w.log.signatures, ["sig-1"]);
});

test("the status URL hands the report over for free: the hold ends, and the next report is bought as usual", async () => {
  const w = world({
    paid: () => Response.json({ ...QUEUED, message: "Your report is being compiled.", status_url: "/v1/reports/PI-88213" }),
    free: (url) => (url.includes("/v1/reports/") ? Response.json(READY) : undefined),
  });
  const sf = make(w);
  await sf(REPORT("GZ-417-K"));
  const ready = await sf(`${ORIGIN}/v1/reports/PI-88213`);
  assert.equal((await ready.json()).status, "ready");
  const next = await sf(REPORT("HX-002-B"));
  assert.equal(next.status, 200);
  assert.deepEqual(w.log.signatures, ["sig-1", "sig-2"], "the second report is a new purchase, paid once");
});

test("a free answer that still says queued does not end the hold", async () => {
  const w = world({
    paid: () => Response.json({ ...QUEUED, message: "Your report is being compiled.", status_url: "/v1/reports/PI-88213" }),
    free: (url) => (url.includes("/v1/reports/") ? Response.json({ status: "queued", report_id: "PI-88213", message: "Still compiling. Check back in a minute." }) : undefined),
  });
  const sf = make(w);
  await sf(REPORT("GZ-417-K"));
  await sf(`${ORIGIN}/v1/reports/PI-88213`);
  await assert.rejects(sf(REPORT("GZ-417-K")), (err) => err.code === "paid_no_delivery");
  assert.deepEqual(w.log.signatures, ["sig-1"]);
});

test("an order whose status is processing is the answer: the second lookup on the endpoint is paid (the honest twin)", async () => {
  const orders = {
    "NL-55120": { order_id: "NL-55120", status: "processing", message: "Payment received; the order is being packed." },
    "NL-55187": { order_id: "NL-55187", status: "shipped", carrier: "PostNL", tracking: "3SFZK0091827" },
  };
  const w = world({ paid: (n, url) => Response.json(orders[new URL(url).searchParams.get("id")]) });
  const sf = make(w);
  const a = await sf("https://api.shoptrack.example/v1/order?id=NL-55120");
  const b = await sf("https://api.shoptrack.example/v1/order?id=NL-55187");
  assert.equal((await a.json()).status, "processing");
  assert.equal((await b.json()).tracking, "3SFZK0091827");
  assert.deepEqual(w.log.signatures, ["sig-1", "sig-2"]);
});

test("pendingInAnswer: only a promise for later, with a pending status and a way to ask again", () => {
  assert.equal(pendingInAnswer(QUEUED), QUEUED.message);
  assert.equal(pendingInAnswer({ job_id: "j1", state: "pending", poll_url: "https://x.example/v1/jobs/j1" }), "status: pending");
  assert.equal(pendingInAnswer({ requestId: "r", status: "in_progress", message: "Try again later." }), "Try again later.");
  // The status is the answer: no request to come back.
  assert.equal(pendingInAnswer({ order_id: "NL-55120", status: "processing", message: "Payment received; the order is being packed." }), null);
  // Any data next to it: a result.
  assert.equal(pendingInAnswer({ ...QUEUED, plate: "GZ-417-K" }), null);
  // Not a pending status.
  assert.equal(pendingInAnswer({ status: "ready", message: "Call again for another report." }), null);
  assert.equal(pendingInAnswer({ status: "failed", message: "Please try again." }), null);
  for (const v of [null, "queued", [QUEUED], {}]) assert.equal(pendingInAnswer(v), null);
});
