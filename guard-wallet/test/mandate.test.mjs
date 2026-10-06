// Paying under a mandate (mandate.js): the nonce is the mandate binding, and the guarded wallet
// sends the mandate with the check. Offline: presign-guard and the wallet are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { guardWallet, mandatePayer, mandateDigest, mandateBinding } from "../index.js";
import { jcs } from "../mandate.js";

const AGENT = "0x2222222222222222222222222222222222222222";
const SELLER = "0x6B0F4651eD42893ab58139938175E4a69f175F25";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const issuer = publicKey.export({ format: "jwk" }).x;
const grant = { v: "x402-mandate/1", issuer, subject: AGENT, asset: USDC, cap: "5000000", perPayment: "1000000", recipients: [SELLER], accountant: issuer, purpose: "test", notAfter: "2030-01-01T00:00:00Z", nonce: "g1" };
const envelope = { mandate: grant, alg: "Ed25519", sig: sign(null, Buffer.from("x402-mandate/1\n" + jcs(grant)), privateKey).toString("base64url") };

const requirements = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };

test("vector: digest and binding match the draft's conformance values", () => {
  const m = { v: "x402-mandate/1", issuer: "ZpxwxbuTQMjJCKTuNk6E-qHD4wGTc7QJ8yYPUdUvSm8", subject: "HMcvJ5nY6DANhYEDgfaEHjR5Ur7xbfmqwbOn2kG5qE8", asset: "FCUSD", cap: "1000000", perPayment: "250000", recipients: ["merchant.example", "api.vendor.example"], accountant: "M16cS6EkFTGx6nsxHb5QM0yn-dzWlxHsrbFsEhJ7il8", purpose: "conformance vectors — model A", notAfter: "2027-01-01T00:00:00Z", nonce: "authority-vec-a-001" };
  assert.equal(mandateDigest(m), "sha256:445fed871d7c43d2b775e68124103c77646fc0f096fb42c9ea3d9f00c960ca05");
  assert.equal(mandateBinding(mandateDigest(m), "pay-001"), "0x5aa71c23c84e6763bdb31a473f1981fd37ccf93945205b77eb84e0c271c1e74b");
});

test("an x402 payment under a mandate: nonce = binding, and the check carries the mandate", async () => {
  const checks = [];
  const wallet = { chain: { id: 8453 }, account: { address: AGENT }, signTypedData: async () => "0xsig" };
  const pay = async (_url, init) => { checks.push(JSON.parse(init.body)); return Response.json({ version: "2", verdict: "green", reasons: [] }); };
  const guarded = guardWallet(wallet, { pay, verifyReceipts: "off" });
  const signer = { address: AGENT, signTypedData: (t) => guarded.signTypedData(t) };
  const base = { scheme: "exact", signer, createPaymentPayload: async () => { throw new Error("not used for EIP-3009"); } };
  const out = await mandatePayer(base, envelope).createPaymentPayload(2, requirements);
  const { authorization } = out.payload;
  assert.equal(out.payload.signature, "0xsig");
  assert.equal(checks.length, 1);
  const sent = checks[0].mandate;
  assert.equal(sent.sig, envelope.sig);
  assert.match(sent.paymentId, /^pgw-[A-Za-z0-9_-]{16}$/);
  assert.equal(authorization.nonce, mandateBinding(mandateDigest(grant), sent.paymentId));
  assert.equal(checks[0].typedData.message.nonce, authorization.nonce);
  assert.equal(authorization.to, SELLER);
  assert.equal(authorization.value, "20000");
});

test("a payment not made through mandatePayer carries no mandate", async () => {
  const checks = [];
  const wallet = { chain: { id: 8453 }, account: { address: AGENT }, signTypedData: async () => "0xsig" };
  const pay = async (_url, init) => { checks.push(JSON.parse(init.body)); return Response.json({ version: "2", verdict: "green", reasons: [] }); };
  await guardWallet(wallet, { pay, verifyReceipts: "off" }).signTypedData({ domain: {}, types: {}, primaryType: "TransferWithAuthorization", message: { nonce: "0x" + "00".repeat(32) } });
  assert.equal(checks[0].mandate, undefined);
});

test("permit2 payments go to the wrapped scheme; a malformed mandate is refused", async () => {
  const base = { scheme: "exact", signer: {}, createPaymentPayload: async () => "from-base" };
  assert.equal(await mandatePayer(base, envelope).createPaymentPayload(2, { ...requirements, extra: { assetTransferMethod: "permit2" } }), "from-base");
  assert.throws(() => mandatePayer(base, { mandate: { v: "x" }, alg: "Ed25519", sig: "s" }), TypeError);
});

test("the wrapper keeps the wrapped scheme's other members (findDefaultAsset for spend controls)", () => {
  const base = { scheme: "exact", signer: {}, findDefaultAsset: () => "usdc", createPaymentPayload: async () => null };
  const w = mandatePayer(base, envelope);
  assert.equal(w.findDefaultAsset(), "usdc");
  assert.equal(w.scheme, "exact");
});
