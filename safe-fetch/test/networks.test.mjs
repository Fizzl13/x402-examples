// Offline: a real x402Client pays a fake seller on Algorand (USDC, signed by @x402/avm against a local algod)
// and on the XRP Ledger (RLUSD, x402's spend controls plus the dollar check here). Trusted host: no preflight.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, createPrivateKey, createPublicKey } from "node:crypto";
import { toClientAvmSigner, decodeSignedTransaction } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { findDefaultAsset as xrplDefaultAsset } from "@x402/xrpl";
import { createSafeFetch, ALGORAND, XRPL } from "../index.js";

const URL_ = "https://seller.example/data";
const SELLER = "SGLTUPAC7TKGKNNXKNPQ2QZCC7NJSLAKYZ7O7NOGGAPXWBFZTOLTPMSPPI";
const FEE_PAYER = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

// A seller answering 402 with `accepts` until a payment header comes, recording what it was paid with.
function seller(accepts) {
  const paid = [];
  const fetch = async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const sig = headers.get("payment-signature") ?? headers.get("x-payment");
    if (!sig) {
      const challenge = { x402Version: 2, error: "payment required", resource: { url: URL_, description: "data", mimeType: "application/json" }, accepts };
      return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
    }
    paid.push(JSON.parse(Buffer.from(sig, "base64").toString()));
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, paid };
}

test("Algorand: pays the USDC offer (not another ASA) with the agent's signed transfer", async () => {
  const algod = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ "consensus-version": "future", fee: 0, "genesis-hash": Buffer.alloc(32, 7).toString("base64"), "genesis-id": "mainnet-v1.0", "last-round": 1000, "min-fee": 1000 }));
  });
  await new Promise((r) => algod.listen(0, "127.0.0.1", r));
  const key = randomBytes(32);
  try {
    // A throwaway ed25519 key: 32-byte seed + public key, as @x402/avm wants it.
    const pk = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), key]), format: "der", type: "pkcs8" });
    const pub = createPublicKey(pk).export({ format: "der", type: "spki" }).subarray(-32);
    const signer = toClientAvmSigner(Buffer.concat([key, pub]).toString("base64"));
    const offer = (asset) => ({ scheme: "exact", network: ALGORAND, amount: "10000", asset, payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER, decimals: 6 } });
    const s = seller([offer("123"), offer("31566704")]);
    const safeFetch = createSafeFetch({ network: "algorand", trusted: ["seller.example"], fetch: s.fetch, register: (c) => c.register("algorand:*", new ExactAvmScheme(signer, { algodUrl: `http://127.0.0.1:${algod.address().port}` })) });
    const res = await safeFetch(URL_);
    assert.equal(res.status, 200);
    assert.equal(s.paid.length, 1);
    assert.equal(String(s.paid[0].accepted.asset), "31566704");
    const transfer = decodeSignedTransaction(s.paid[0].payload.paymentGroup[1]);
    assert.ok(transfer.sig);
    assert.equal(transfer.txn.sender.toString(), signer.address);
    assert.equal(transfer.txn.assetTransfer.receiver.toString(), SELLER);
  } finally { algod.close(); }
});

test("XRP Ledger: RLUSD within the budget is paid; '2' (two dollars) over a $0.05 budget, XRP and look-alikes are not", async () => {
  // A stand-in XRPL scheme with @x402/xrpl's real default assets, so x402's spend controls run as they would.
  const created = [];
  const scheme = { scheme: "exact", findDefaultAsset: xrplDefaultAsset, async createPaymentPayload(v, req) { created.push(req); return { x402Version: v, payload: { signedTxBlob: "00" } }; } };
  const offer = (amount, extra = { issuer: ISSUER }, asset = RLUSD) => ({ scheme: "exact", network: XRPL, amount, asset, payTo: "r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw", maxTimeoutSeconds: 60, extra });
  const pay = async (accepts) => {
    const s = seller(accepts);
    const safeFetch = createSafeFetch({ network: "xrpl", maxUsd: 0.05, trusted: ["seller.example"], fetch: s.fetch, register: (c) => c.register("xrpl:*", scheme) });
    return { res: await safeFetch(URL_).catch((e) => e), s };
  };
  const ok = await pay([offer("0.02")]);
  assert.equal(ok.res.status, 200);
  assert.equal(ok.s.paid.length, 1);
  assert.equal(created.at(-1).amount, "0.02");
  for (const accepts of [[offer("2")], [offer("1000", {}, "XRP")], [offer("0.01", { issuer: "rFakeIssuer" })]]) {
    const n = created.length;
    const { res, s } = await pay(accepts);
    assert.ok(res instanceof Error, JSON.stringify(accepts));
    assert.equal(s.paid.length, 0);
    assert.equal(created.length, n, "nothing signed");
  }
  const { res } = await pay([offer("2")]);
  assert.match(String(res.message ?? res), /RLUSD within \$0\.05|spendControls/);
});
