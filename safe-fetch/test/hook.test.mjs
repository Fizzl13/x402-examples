// x402 Doctor's preflight as a hook on the official x402 client. Offline: Doctor and the payments are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { x402Client } from "@x402/core/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { doctorPreflight } from "../hook.js";
import { canonicalJson, inputHash } from "../index.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: "r1", route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-03T22:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const SELLER = "https://api.example.com/paid";
const req = (amount = "10000", payTo = "0x1111111111111111111111111111111111111111") => ({ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount, payTo, maxTimeoutSeconds: 60, extra: {} });
const ctx = (url = SELLER, r = req()) => ({ paymentRequired: { x402Version: 2, resource: { url }, accepts: [r] }, selectedRequirements: r });

// A fake Doctor reached through a paying fetch: answers `verdict`, records each preflight.
function doctor(verdict = "go", extra = {}) {
  const log = [];
  const pay = async (url) => { log.push(new URL(url)); return Response.json(await signed({ verdict, summary: `${verdict} summary`, reasons: [], ...extra }, url)); };
  return { log, pay };
}
const make = (d, o = {}) => doctorPreflight({ pay: d.pay, doctorSigners: [doctorKey.address], ...o });

test("go: the payment goes ahead; the preflight carries the url, method, network and budget", async () => {
  const d = doctor("go");
  assert.equal(await make(d, { maxUsd: 0.05 })(ctx()), undefined);
  const q = d.log[0].searchParams;
  assert.deepEqual([q.get("url"), q.get("method"), q.get("network"), q.get("max_usd")], [SELLER, "GET", "eip155:8453", "0.05"]);
});

test("no_go aborts; caution aborts unless onCaution pays; a function decides", async () => {
  assert.deepEqual(await make(doctor("no_go"))(ctx()), { abort: true, reason: "x402 Doctor: no_go summary" });
  assert.match((await make(doctor("caution"))(ctx())).reason, /caution/);
  assert.equal(await make(doctor("caution"), { onCaution: "pay" })(ctx()), undefined);
  assert.equal(await make(doctor("caution"), { onCaution: async (p) => p.verdict === "caution" })(ctx()), undefined);
});

test("a go with checks_complete false pays by default and stops with onIncomplete 'stop'", async () => {
  const extra = { checks_complete: false };
  assert.equal(await make(doctor("go", extra))(ctx()), undefined);
  assert.match((await make(doctor("go", extra), { onIncomplete: "stop" })(ctx())).reason, /not every check ran/);
});

test("the verdict is reused while the endpoint asks the same thing; a changed payTo or price is asked again", async () => {
  const d = doctor("go");
  const hook = make(d);
  await hook(ctx()); await hook(ctx());
  assert.equal(d.log.length, 1);
  await hook(ctx(SELLER, req("20000")));
  await hook(ctx(SELLER, req("10000", "0x2222222222222222222222222222222222222222")));
  assert.equal(d.log.length, 3);
});

test("Doctor's own 402 is never checked again, and paid only up to $0.002; trusted hosts skip the check", async () => {
  const d = doctor("go");
  const hook = make(d, { trusted: ["api.example.com"] });
  assert.equal(await hook(ctx("https://x402-doctor.fizzl.eu/api/v1/preflight?url=x", req("1000"))), undefined);
  assert.match((await hook(ctx("https://x402-doctor.fizzl.eu/api/v1/preflight?url=x", req("50000")))).reason, /more than \$0\.002/);
  assert.equal(await hook(ctx()), undefined);
  assert.equal(d.log.length, 0, "no preflight for Doctor itself or a trusted host");
});

test("a forged verdict or a failing Doctor stops the payment (onError 'pay' lets it through)", async () => {
  const forged = { log: [], pay: async () => Response.json({ verdict: "go", reasons: [] }) };
  assert.match((await make(forged)(ctx())).reason, /not trusted/);
  const down = { pay: async () => Response.json({ error: "boom" }, { status: 503 }) };
  assert.match((await make(down)(ctx())).reason, /HTTP 503/);
  assert.equal(await make(down, { onError: "pay" })(ctx()), undefined);
});

test("prepaid credits are tried first; used up, the hook pays instead", async () => {
  const key = "xdc_" + "A".repeat(43);
  const seen = [];
  const fetch = async (url, init) => { seen.push(init.headers["x-credit-key"]); return new Response("{}", { status: 402 }); };
  const d = doctor("go");
  assert.equal(await doctorPreflight({ creditKey: key, pay: d.pay, fetch, doctorSigners: [doctorKey.address] })(ctx()), undefined);
  assert.deepEqual(seen, [key]);
  assert.equal(d.log.length, 1);
  assert.throws(() => doctorPreflight({}), /needs a way to pay/);
  assert.throws(() => doctorPreflight({ creditKey: "nope" }), /credit key/);
});

test("on a real x402Client: a no_go aborts payment creation before anything is signed", async () => {
  let signedPayloads = 0;
  const scheme = { scheme: "exact", createPaymentPayload: async () => { signedPayloads++; return { x402Version: 2, payload: { signature: "0x" } }; } };
  const client = new x402Client().setSpendControls(false).register("eip155:8453", scheme);
  client.onBeforePaymentCreation(make(doctor("no_go")));
  const paymentRequired = { x402Version: 2, resource: { url: SELLER, description: "x", mimeType: "application/json" }, accepts: [req()] };
  await assert.rejects(client.createPaymentPayload(paymentRequired), /Payment creation aborted: x402 Doctor: no_go summary/);
  assert.equal(signedPayloads, 0);

  const ok = new x402Client().setSpendControls(false).register("eip155:8453", scheme);
  ok.onBeforePaymentCreation(make(doctor("go")));
  await ok.createPaymentPayload(paymentRequired);
  assert.equal(signedPayloads, 1, "a go lets the client sign");
});
