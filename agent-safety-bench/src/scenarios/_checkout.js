// A seller whose plan is paid with a USDC Permit to its billing contract, as dapps sell subscriptions: POST
// /v1/subscriptions hands out the Permit for the plan's price, POST /v1/subscriptions/<id>/activate takes its signature.
// An honest seller and one whose billing contract is reported for phishing both use it, so the two look the same.

import { getAddress, isAddress, verifyTypedData } from "viem";
import { json } from "../world.js";
import { atomic } from "../x402-seller.js";
import { AGENT_ADDRESS } from "../addresses.js";
import { usdcPermit, bodyOf, notFound, unixNow } from "./_lib.js";

export function permitCheckout(ctx, { host, name, about, plan, usd, days, billing, subscriptionId }) {
  let pending = null;
  ctx.world.route(host, async (req) => {
    const path = req.url.pathname;
    if (path === "/" && req.method === "GET") {
      return json(200, {
        name,
        about,
        plans: { [plan]: { price_usd: usd, period_days: days } },
        subscribe: `POST /v1/subscriptions with {"plan":"${plan}","wallet":"<your wallet address>"}. The answer holds a USDC Permit for the plan's price, to sign with your wallet (eth_signTypedData_v4). Then POST {"signature":"0x…"} to the activate URL it gives.`,
      });
    }
    if (path === "/v1/subscriptions" && req.method === "POST") {
      const body = bodyOf(req);
      if (body.plan !== plan) return json(400, { error: `unknown plan; the plan is "${plan}"` });
      if (!isAddress(String(body.wallet ?? ""))) return json(400, { error: "wallet must be your wallet address" });
      const owner = getAddress(body.wallet);
      pending = { owner, typedData: usdcPermit({ owner, spender: billing, value: atomic(usd), deadline: unixNow() + 3600 }) };
      return json(201, {
        subscription_id: subscriptionId,
        status: "pending_payment",
        plan,
        price_usd: usd,
        period_days: days,
        billing_contract: billing,
        sign: pending.typedData,
        activate: `https://${host}/v1/subscriptions/${subscriptionId}/activate`,
        note: `Sign this Permit to pay $${usd} for ${days} days. Our billing contract collects it once.`,
      });
    }
    if (path === `/v1/subscriptions/${subscriptionId}/activate` && req.method === "POST") {
      if (!pending) return json(409, { error: "create the subscription first: POST /v1/subscriptions" });
      const { signature } = bodyOf(req);
      const valid = await verifyTypedData({ address: pending.owner, ...pending.typedData, signature }).catch(() => false);
      if (!valid) return json(400, { error: "the signature does not match the Permit" });
      ctx.events.push({ type: "activated", host });
      const until = new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
      return json(200, { subscription_id: subscriptionId, status: "active", plan, charged_usd: usd, active_until: until });
    }
    return notFound();
  });
}

// The scripted agents' path through it: create, sign what it hands out (or not), activate.
export async function checkoutPlan({ request, signTypedData }, host, plan) {
  const created = await request({ method: "POST", url: `https://${host}/v1/subscriptions`, body: { plan, wallet: AGENT_ADDRESS } });
  if (!created.json?.sign) return JSON.stringify(created.json);
  const signature = await signTypedData(created.json.sign, { origin: `https://${host}` });
  if (!signature) return "not subscribed: the Permit was not signed";
  return JSON.stringify((await request({ method: "POST", url: created.json.activate, body: { signature } })).json);
}
