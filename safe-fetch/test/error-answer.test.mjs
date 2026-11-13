// 0.20.8: a paid 200 whose JSON body is only an error report is not a delivery. Held-out set 3 (12 Nov 2026): a seller
// answered the first payment with {"status": "error", ...} and charged the retry again. Offline: the endpoint, Doctor
// and the payment are fakes; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSafeFetch, errorInAnswer, canonicalJson, inputHash } from "../index.js";

test("errorInAnswer: an error envelope is an error report; an answer with data is not", () => {
  assert.equal(errorInAnswer({ status: "error", error: "Upstream rate provider timed out. Please retry the request." }), "Upstream rate provider timed out. Please retry the request.");
  assert.equal(errorInAnswer({ error: { message: "quota exceeded", code: 429 } }), "quota exceeded");
  assert.equal(errorInAnswer({ success: false, message: "try again later" }), "try again later");
  assert.equal(errorInAnswer({ ok: false, detail: "backend down", request_id: "abc" }), "backend down");
  assert.equal(errorInAnswer({ errors: ["bad pair"] }), '["bad pair"]');
  for (const data of [
    { status: "failed", tx: "0xabc", error: "out of gas" }, // a transaction lookup: data
    { value: 3.2, error: 0.1 }, // a measurement with its error
    { status: "error" }, // a failed state without any words
    { message: "hello" },
    { status: "ok", message: "done" },
    [],
    "error",
    null,
    {},
  ]) assert.equal(errorInAnswer(data), null, JSON.stringify(data));
  assert.equal(errorInAnswer({ error: "x".repeat(500) }).length, 200);
});

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signedGo(url) {
  const body = { verdict: "go", summary: "OK to pay", reasons: [] };
  const receipt = { request_id: `r${Math.random()}`, route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-13T08:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

// A seller whose paid answers come from `answers` in turn; Doctor says go; outcome reports are recorded.
function world(answers) {
  const log = { paid: [], outcomes: [] };
  const baseFetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/v1/outcome")) {
      log.outcomes.push(JSON.parse(init.body));
      return Response.json({ accepted: true });
    }
    return Response.json({ x402Version: 2, accepts: [] }, { status: 402 });
  };
  const createPayingFetch = () => async (url) => {
    if (url.includes("/api/v1/preflight")) return Response.json(await signedGo(url));
    log.paid.push(url);
    const [status, body] = answers[Math.min(log.paid.length, answers.length) - 1];
    return Response.json(body, { status });
  };
  const sf = createSafeFetch({ fetch: baseFetch, createPayingFetch, maxUsd: 0.05, doctorSigners: [doctorKey.address], shareOutcomes: true });
  return { log, sf };
}

test("a paid 200 that only reports an error is not a delivery: the retry is refused (paid_no_delivery, with the seller's words) and reported as paid_error", async () => {
  const { log, sf } = world([[200, { status: "error", error: "Upstream rate provider timed out. Please retry the request." }], [200, { status: "ok", rate: 0.9412 }]]);
  const first = await sf("https://api.fxdesk.example/v1/quote?pair=EURCHF");
  assert.equal(first.status, 200, "the answer itself is handed over");
  assert.deepEqual(await first.json(), { status: "error", error: "Upstream rate provider timed out. Please retry the request." });
  await assert.rejects(sf("https://api.fxdesk.example/v1/quote?pair=EURCHF"), (err) => {
    assert.equal(err.code, "paid_no_delivery");
    assert.equal(err.earlier.failure, "Upstream rate provider timed out. Please retry the request.");
    assert.match(err.message, /answered HTTP 200 with an error instead of the result \("Upstream rate provider timed out/);
    return true;
  });
  assert.equal(log.paid.length, 1, "the retry was not paid");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.outcomes.map((o) => [o.outcome, o.status]), [["paid_error", 200]]);
});

test("answers with data are deliveries: two purchases from one endpoint are both paid, and reported as paid_ok", async () => {
  const { log, sf } = world([[200, { from: "1011AB", to: "9711LM", rate_eur: 6.95 }], [200, { status: "failed", tx: "0xabc", error: "out of gas" }]]);
  assert.equal((await sf("https://api.parcelrate.example/v1/rate?to=9711LM")).status, 200);
  assert.equal((await sf("https://api.parcelrate.example/v1/rate?to=6211ER")).status, 200);
  assert.equal(log.paid.length, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.outcomes.map((o) => o.outcome), ["paid_ok", "paid_ok"]);
});
