// 0.20.12: payees. Only the payout addresses named for an endpoint are paid (the address the user always paid, or the
// payTo the seller's own documentation names). Held-out set 4 (13 Nov 2026): the documentation named a subdomain of the
// seller's own domain that someone else had taken over; that host asked to be paid at its own address, and safe-fetch
// paid it. Offline: a fake seller and a fake x402 client that signs through safe-fetch's fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSafeFetch, canonicalJson, inputHash } from "../index.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: `r${Math.random()}`, route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-13T16:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
const SELLER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const URL_ = "https://data.airsense.example/v1/aqi?city=rotterdam";

// A seller whose 402 pays `payTo`; counts preflights and signatures.
function world(payTo) {
  const log = { signatures: [], preflights: 0 };
  const baseFetch = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const sig = new Headers(init?.headers ?? req?.headers).get("payment-signature");
    if (!sig) return Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo }] }, { status: 402 });
    return Response.json({ city: "Rotterdam", aqi: 42 });
  };
  const createPayingFetch = (cap, fetchImpl) => async (url, init) => {
    if (String(url).includes("/api/v1/preflight")) {
      log.preflights += 1;
      return Response.json(await signed({ verdict: "go", summary: "OK to pay", reasons: [] }, url));
    }
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;
    const sig = `sig-${log.signatures.length + 1}`;
    log.signatures.push(sig);
    return fetchImpl(url, { ...init, headers: { ...(init?.headers ?? {}), "payment-signature": sig } });
  };
  return { log, baseFetch, createPayingFetch };
}
const make = (w, payees) => createSafeFetch({ fetch: w.baseFetch, createPayingFetch: w.createPayingFetch, maxUsd: 0.1, doctorSigners: [doctorKey.address], payees });

test("a 402 that asks to be paid at another address than the one named is refused before the preflight, nothing signed", async () => {
  const w = world(STRANGER);
  await assert.rejects(make(w, [SELLER])(URL_), (err) => {
    assert.equal(err.code, "other_payee");
    assert.equal(err.payTo, STRANGER);
    assert.deepEqual(err.payees, [SELLER]);
    assert.match(err.message, /not at the address named for it/);
    return true;
  });
  assert.deepEqual(w.log.signatures, []);
  assert.equal(w.log.preflights, 0, "no preflight bought");
});

test("the named address is paid, whatever its letter case", async () => {
  const w = world(SELLER);
  const res = await make(w, [SELLER.toUpperCase().replace("0X", "0x")])(URL_);
  assert.equal(res.status, 200);
  assert.deepEqual(w.log.signatures, ["sig-1"]);
});

test("a function names the addresses per URL; none for a URL leaves that URL unconstrained", async () => {
  const asked = [];
  const payees = async (url, { method }) => {
    asked.push([new URL(url).host, method]);
    return url.includes("airsense") ? [SELLER] : undefined;
  };
  const w = world(STRANGER);
  await assert.rejects(make(w, payees)(URL_), (err) => err.code === "other_payee");
  const other = await make(w, payees)("https://api.other.example/v1/x");
  assert.equal(other.status, 200, "no address named for this URL: paid as before");
  assert.deepEqual(asked, [["data.airsense.example", "GET"], ["api.other.example", "GET"]]);
});

test("no payees, null or an empty list: any address, as before", async () => {
  for (const payees of [undefined, null, []]) {
    const w = world(STRANGER);
    assert.equal((await make(w, payees)(URL_)).status, 200);
  }
});

test("payees must be a list of addresses or a function", () => {
  for (const bad of ["0x11", [""], [1], {}]) {
    assert.throws(() => createSafeFetch({ fetch: async () => new Response("x"), createPayingFetch: () => fetch, payees: bad }), /payees must be/);
  }
});
