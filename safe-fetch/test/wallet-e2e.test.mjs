// Offline, through the real x402 client: a linked wallet asks the wallet server before signing; a refusal means
// nothing is signed or sent to the seller. The seller, Doctor and the wallet server are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { canonicalJson, inputHash } from "../index.js";
import { main, stateStore } from "../cli.js";
import { writeWallet, WALLET_URL } from "../wallet.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: "r1", route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-11T10:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "https://api.example.com/v1/quote";
const accepts = (usd, payTo) => [{ scheme: "exact", network: "eip155:8453", amount: String(Math.round(usd * 1e6)), asset: USDC, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

function world(reserveAnswer) {
  const log = { reserves: [], sellerPaid: 0, doctorPaid: 0, spent: [] };
  const fetch = async (input, init = {}) => {
    // The x402 client sends a Request; everything else a URL and init.
    const url = typeof input === "string" ? input : input.url;
    if (typeof input !== "string") init = { method: input.method, headers: input.headers, body: input.method === "GET" ? undefined : await input.text() };
    const u = new URL(url);
    const h = new Headers(init.headers ?? {});
    const paid = h.has("payment-signature") || h.has("x-payment");
    if (u.hostname === "wallet.fizzl.eu") {
      const body = JSON.parse(init.body ?? "{}");
      if (u.pathname === "/v1/reserve") { log.reserves.push(body); return Response.json(reserveAnswer(log.reserves.length)); }
      if (u.pathname === "/v1/spent") { log.spent.push(body); return Response.json({ ok: true }); }
    }
    if (u.hostname === "x402-doctor.fizzl.eu" && u.pathname === "/api/v1/preflight") {
      if (!paid) return new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, resource: { url }, accepts: accepts(0.001, "0x1111111111111111111111111111111111111111") }) } });
      log.doctorPaid++;
      return Response.json(await signed({ verdict: "go", summary: "OK to pay: $0.02 on Base.", recommended_option: 0, options: [{ index: 0, usd: 0.02 }], reasons: [] }, url));
    }
    if (u.hostname === "presign-guard.fizzl.eu") return Response.json({ verdict: "green" });
    if (url.startsWith(SELLER)) {
      if (!paid) return new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, resource: { url }, accepts: accepts(0.02, "0x6B0F4651eD42893ab58139938175E4a69f175F25") }) } });
      log.sellerPaid++;
      return Response.json({ price: 1 });
    }
    return Response.json({}, { status: 404 });
  };
  return { log, fetch };
}

function linkedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sf-e2e-"));
  const privateKey = generatePrivateKey();
  writeWallet(home, { address: privateKeyToAccount(privateKey).address, privateKey, server: { url: WALLET_URL, key: "awk_test", agent: "laptop" } });
  return home;
}

const run = (w, home) => main(["pay", SELLER, "--json"], { fetch: w.fetch, env: {}, store: stateStore({ home }), safeFetchOptions: { doctorSigners: [doctorKey.address] }, out: (s) => (run.last = JSON.parse(s)), err: (s) => (run.err = s) });

test("linked: the preflight and the payment are each reserved on the wallet server first, then paid and reported", async () => {
  const w = world(() => ({ status: "ok", entries: ["e"], purchaseId: "p" }));
  const code = await run(w, linkedHome());
  assert.equal(code, 0, JSON.stringify(run.last));
  assert.deepEqual(run.last.body, { price: 1 });
  assert.equal(w.log.reserves.length, 2, "Doctor's preflight and the seller");
  assert.ok(w.log.reserves.every((r) => r.method === "signTypedData" && r.request.typedData.primaryType === "TransferWithAuthorization"));
  assert.deepEqual(w.log.reserves.map((r) => r.request.typedData.message.value), ["1000", "20000"]);
  assert.equal(w.log.sellerPaid, 1);
  assert.equal(w.log.spent.length, 2);
});

test("linked: the owner's wallet says no to the seller's payment: nothing signed for it, the seller never paid", async () => {
  const w = world((n) => (n === 1 ? { status: "ok", entries: ["e"], purchaseId: "p" } : { status: "denied", summary: "over your $0.01 per payment limit", reasons: [] }));
  const code = await run(w, linkedHome());
  assert.equal(code, 1);
  assert.equal(run.last.code, "wallet_denied");
  assert.match(run.last.message, /your Fizzl wallet says no: over your \$0\.01 per payment limit/);
  assert.equal(w.log.sellerPaid, 0);
  assert.equal(w.log.doctorPaid, 1);
});
