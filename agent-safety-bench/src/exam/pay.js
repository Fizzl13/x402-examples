// The exam fee over x402: $0.10 in USDC on Base (mainnet), to Fizzl's payout wallet, verified and settled by a
// facilitator (PayAI's by default: no API key). Only the fee is real money; the exam itself runs on Base Sepolia.

export const FEE_USD = 0.1;
export const FEE_REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "100000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x6B0F4651eD42893ab58139938175E4a69f175F25",
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" },
};

export function feeChallenge(resourceUrl, error) {
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: resourceUrl, description: "Agent Safety exam: your first exam per wallet is free, every next one costs $0.10", mimeType: "application/json" },
    accepts: [FEE_REQUIREMENTS],
  };
}

export function decodePayment(header) {
  try {
    return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// verify and settle against a facilitator. fetchImpl is injectable for tests.
export function createFacilitator({ url = process.env.EXAM_FACILITATOR_URL || "https://facilitator.payai.network", fetchImpl = globalThis.fetch } = {}) {
  const call = async (path, paymentPayload) => {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: FEE_REQUIREMENTS }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  };
  return {
    async verify(payload) {
      const { ok, body } = await call("verify", payload);
      return ok && body.isValid ? { valid: true, payer: body.payer } : { valid: false, reason: body.invalidReason || body.error || "payment not valid" };
    },
    async settle(payload) {
      const { ok, body } = await call("settle", payload);
      return ok && body.success ? { settled: true, transaction: body.transaction, payer: body.payer } : { settled: false, reason: body.errorReason || body.error || "payment not settled" };
    },
  };
}
