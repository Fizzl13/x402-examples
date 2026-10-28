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

test("X Layer: pays USD₮0 within the budget (an EIP-3009 signature, spend controls allowing it); OKB-like tokens and over-budget offers are not paid", async () => {
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { XLAYER } = await import("../index.js");
  const USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
  const account = privateKeyToAccount(generatePrivateKey());
  const offer = (amount, asset = USDT0, extra = { name: "USD₮0", version: "1" }) => ({ scheme: "exact", network: XLAYER, amount, asset, payTo: "0x6B0F4651eD42893ab58139938175E4a69f175F25", maxTimeoutSeconds: 300, extra });
  const pay = async (accepts) => {
    const s = seller(accepts);
    const safeFetch = createSafeFetch({ network: "xlayer", maxUsd: 0.05, trusted: ["seller.example"], fetch: s.fetch, register: (c) => c.register("eip155:196", new ExactEvmScheme(account)) });
    return { res: await safeFetch(URL_).catch((e) => e), s };
  };
  const ok = await pay([offer("10000", "0xe538905cf8410324e03a5a23c1c177a474d59b2b", { name: "Wrapped OKB", version: "1" }), offer("10000")]);
  assert.equal(ok.res.status, 200, String(ok.res));
  assert.equal(ok.s.paid.length, 1);
  assert.equal(ok.s.paid[0].accepted.asset, USDT0);
  assert.equal(ok.s.paid[0].payload.authorization.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(ok.s.paid[0].payload.authorization.value, "10000");
  for (const accepts of [[offer("60000")], [offer("10000", "0xe538905cf8410324e03a5a23c1c177a474d59b2b")]]) {
    const { res, s } = await pay(accepts);
    assert.ok(res instanceof Error, JSON.stringify(accepts));
    assert.equal(s.paid.length, 0);
  }
});

test("Base auth-capture (Coinbase escrow): with the scheme registered, a ReceiveWithAuthorization to the escrow's collector for at most the budget; exact preferred when both are offered", async () => {
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { AuthCaptureEvmScheme } = await import("@x402/evm/auth-capture/client");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const COLLECTOR_V1_1 = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88";
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const escrowed = (amount) => ({
    scheme: "auth-capture", network: "eip155:8453", amount, asset: USDC, payTo: "0x6B0F4651eD42893ab58139938175E4a69f175F25", maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2", captureAuthorizer: "0x1111111111111111111111111111111111111111", feeRecipient: "0x2222222222222222222222222222222222222222", captureDeadline: now + 86400, refundDeadline: now + 86400 * 30, minFeeBps: 0, maxFeeBps: 100 },
  });
  const exact = (amount) => ({ scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: "0x6B0F4651eD42893ab58139938175E4a69f175F25", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
  const pay = async (accepts, { schemes = ["exact", "auth-capture"], maxUsd = 25 } = {}) => {
    const s = seller(accepts);
    const safeFetch = createSafeFetch({
      maxUsd, trusted: ["seller.example"], fetch: s.fetch,
      register: (c) => {
        if (schemes.includes("exact")) c.register("eip155:8453", new ExactEvmScheme(account));
        if (schemes.includes("auth-capture")) c.register("eip155:8453", new AuthCaptureEvmScheme(account));
      },
    });
    return { res: await safeFetch(URL_).catch((e) => e), s };
  };
  // A $12 domain, escrowed: signed once, to the escrow's EIP-3009 collector, for exactly the amount.
  const ok = await pay([escrowed("12000000")]);
  assert.equal(ok.res.status, 200, String(ok.res));
  assert.equal(ok.s.paid.length, 1);
  const p = ok.s.paid[0];
  assert.equal(p.accepted.scheme, "auth-capture");
  assert.equal(p.payload.authorization.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(p.payload.authorization.to.toLowerCase(), COLLECTOR_V1_1.toLowerCase());
  assert.equal(p.payload.authorization.value, "12000000");
  assert.match(p.payload.signature, /^0x[0-9a-f]{130}$/i);
  // Both offered: the exact one is paid.
  const both = await pay([escrowed("12000000"), exact("12000000")]);
  assert.equal(both.s.paid[0].accepted.scheme, "exact");
  // Over the budget, or without the scheme registered: nothing is paid.
  for (const [accepts, opts] of [[[escrowed("30000000")], {}], [[escrowed("12000000")], { schemes: ["exact"] }]]) {
    const { res, s } = await pay(accepts, opts);
    assert.ok(res instanceof Error, JSON.stringify(opts));
    assert.equal(s.paid.length, 0);
  }
});

