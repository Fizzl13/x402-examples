// What a simulated seller needs: x402 v2 challenges, reading and verifying the payment the agent sends, and settling
// it in the run's ledger instead of on chain.

import { verifyTypedData, getAddress } from "viem";
import { json } from "./world.js";

export const BASE = "eip155:8453";
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

export const atomic = (usd) => String(Math.round(usd * 1e6));
export const usdOf = (amount) => Number(amount) / 1e6;

// One payment option: USDC on Base, the exact scheme.
export function option({ usd, payTo }) {
  return { scheme: "exact", network: BASE, amount: atomic(usd), asset: USDC_BASE, payTo, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } };
}

// The 402 answer: the challenge in the PAYMENT-REQUIRED header (base64 JSON) and in the body, as most sellers do.
export function paymentRequired(url, accepts, { description = "", error } = {}) {
  const challenge = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: resourceUrl(url), description, mimeType: "application/json" },
    accepts,
  };
  return json(402, challenge, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64") });
}

const resourceUrl = (url) => `${url.origin}${url.pathname}`;

function decodeHeader(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// The payment the agent sent with its request, checked like a facilitator's /verify would: a valid EIP-3009 signature
// from the payer for exactly one of the offered options. Returns null when the request carries no payment.
export async function readPayment(req, accepts) {
  const raw = req.headers.get("payment-signature") || req.headers.get("x-payment");
  if (!raw) return null;
  const payload = decodeHeader(raw);
  const auth = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (!auth || !signature) return { ok: false, reason: "malformed payment payload" };
  const offered = accepts.find((a) =>
    getAddress(a.payTo) === getAddress(auth.to) &&
    String(a.amount) === String(auth.value) &&
    (!payload.accepted || getAddress(payload.accepted.asset) === getAddress(a.asset)));
  if (!offered) return { ok: false, reason: "the payment does not match an offered option" };
  const valid = await verifyTypedData({
    address: auth.from,
    domain: { name: offered.extra.name, version: offered.extra.version, chainId: BASE_CHAIN_ID, verifyingContract: offered.asset },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
    signature,
  }).catch(() => false);
  if (!valid) return { ok: false, reason: "invalid signature" };
  return { ok: true, option: offered, authorization: auth };
}

// Settle a verified payment in the ledger and build the PAYMENT-RESPONSE header the client reads.
export function settle(ledger, payment, url) {
  const transaction = ledger.settle({ nonce: payment.authorization.nonce, url: url.href, payTo: payment.option.payTo, amount: payment.option.amount });
  const response = { success: true, transaction, network: BASE, payer: payment.authorization.from };
  return { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(response)).toString("base64") };
}

// A paid route: 402 until a valid payment for one of `accepts` arrives, then `deliver(payment)`'s answer.
export async function paidRoute(ctx, req, { accepts, description, deliver }) {
  const payment = await readPayment(req, accepts);
  if (!payment) return paymentRequired(req.url, accepts, { description });
  if (!payment.ok) return paymentRequired(req.url, accepts, { description, error: payment.reason });
  const headers = settle(ctx.ledger, payment, req.url);
  const res = await deliver(payment);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

// An OpenAPI document that advertises a price per route, as sellers do for the CDP Bazaar and x402 Doctor.
export function openapi(title, paths) {
  const spec = { openapi: "3.1.0", info: { title, version: "1.0.0" }, paths: {} };
  for (const [path, { method = "get", usd, summary }] of Object.entries(paths)) {
    spec.paths[path] = { [method]: { summary, "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: String(usd) } } } };
  }
  return json(200, spec);
}
