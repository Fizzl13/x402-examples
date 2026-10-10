// x402Checked (index.js): the payment requirements an x402 scheme pays go along with the presign-guard check of
// its EIP-3009 signature, so presign-guard can tell a signature that pays more or someone else than asked.
// Offline: presign-guard and the wallet are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardWallet, x402Checked, mandatePayer, checkRequestFor } from "../index.js";

const AGENT = "0x2222222222222222222222222222222222222222";
const SELLER = "0x6B0F4651eD42893ab58139938175E4a69f175F25";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const requirements = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000", payTo: SELLER, maxTimeoutSeconds: 60, resource: "https://api.test/x", description: "not sent", extra: { name: "USD Coin", version: "2", other: "dropped" } };

function setup() {
  const checks = [];
  const wallet = { chain: { id: 8453 }, account: { address: AGENT }, signTypedData: async () => "0xsig" };
  const pay = async (_url, init) => { checks.push(JSON.parse(init.body)); return Response.json({ version: "2", verdict: "green", reasons: [] }); };
  const guarded = guardWallet(wallet, { pay, verifyReceipts: "off" });
  const signer = { address: AGENT, signTypedData: (t) => guarded.signTypedData(t) };
  // A stand-in for ExactEvmScheme: signs one EIP-3009 payment for the requirements it is given.
  const scheme = { scheme: "exact", signer, findDefaultAsset: () => "usdc", async createPaymentPayload(v, r) {
    const signature = await signer.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: r.asset }, types: {}, primaryType: "TransferWithAuthorization", message: { from: AGENT, to: r.payTo, value: r.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } });
    return { x402Version: v, payload: { signature } };
  } };
  return { checks, guarded, scheme };
}

test("a payment through x402Checked sends the requirements it pays, trimmed to what the check reads", async () => {
  const { checks, scheme } = setup();
  const wrapped = x402Checked(scheme);
  assert.equal(wrapped.findDefaultAsset(), "usdc", "other members of the scheme stay");
  await wrapped.createPaymentPayload(2, requirements);
  assert.deepEqual(checks[0].x402, { accepted: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } } });
});

test("outside x402Checked (and for other signatures) nothing extra is sent; it nests with mandatePayer", async () => {
  const { checks, guarded, scheme } = setup();
  await scheme.createPaymentPayload(2, requirements);
  assert.equal(checks[0].x402, undefined);
  await guarded.signTypedData({ domain: { verifyingContract: USDC }, types: {}, primaryType: "Permit", message: {} }).catch(() => {});
  assert.equal(checkRequestFor("signTypedData", { domain: {}, types: {}, primaryType: "Permit", message: {} }, { chainId: 8453, x402: { amount: "1" } }).x402, undefined);
  assert.equal(typeof x402Checked(mandatePayer(scheme, { mandate: { v: "x402-mandate/1", issuer: "a".repeat(43), subject: AGENT, asset: USDC, cap: "1", recipients: [SELLER], accountant: "a".repeat(43), purpose: "p", notAfter: "2030-01-01T00:00:00Z", nonce: "n" }, alg: "Ed25519", sig: "a".repeat(86) })).createPaymentPayload, "function");
});
