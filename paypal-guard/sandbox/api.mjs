// A small PayPal REST client for the sandbox scripts (seed, probe, end-to-end): a token, then JSON calls.
// Reads PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_SECRET. Never prints them or the token.
import { randomUUID } from "node:crypto";

export const BASE = "https://api-m.sandbox.paypal.com";
export const creds = () => {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID, clientSecret = process.env.PAYPAL_SANDBOX_SECRET;
  if (!clientId || !clientSecret) throw new Error("PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_SECRET are required");
  return { clientId, clientSecret };
};

let token = null;
export async function auth() {
  if (token) return token;
  const { clientId, clientSecret } = creds();
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token: HTTP ${res.status} ${body.error_description ?? body.error}`);
  token = { value: body.access_token, scopes: String(body.scope ?? "").split(" ").filter(Boolean), appId: body.app_id ?? null };
  return token;
}

// { status, body } for one call; never throws on a PayPal error, so the scripts can show it.
export async function api(method, path, body, headers = {}) {
  const t = await auth();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.value}`, "content-type": "application/json", accept: "application/json", "paypal-request-id": randomUUID(), prefer: "return=representation", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json ?? text };
}

// The shortest useful line about a PayPal answer: status, name, first issue.
export const brief = (r) => {
  const b = r.body ?? {};
  const issue = b.details?.[0] ? `${b.details[0].issue}${b.details[0].field ? ` (${b.details[0].field})` : ""}` : "";
  return `HTTP ${r.status}${b.status ? ` ${b.status}` : ""}${b.name ? ` ${b.name}` : ""}${issue ? `: ${issue}` : ""}`;
};

// A card payment from a customer, paid at once: create the order with a sandbox test card, capture it.
// The customer's email goes in custom_id (a card payment has no payer email at PayPal).
export async function cardPayment({ email, value, currency, description }) {
  const card = { name: email.split("@")[0], number: "4012888888881881", security_code: "123", expiry: "2030-12", billing_address: { address_line_1: "Damrak 1", admin_area_2: "Amsterdam", postal_code: "1012 LG", country_code: "NL" } };
  const created = await api("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: currency, value }, description, custom_id: email, invoice_id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }],
    payment_source: { card },
  });
  if (created.status >= 300) return { ok: false, step: "create", r: created };
  let order = created.body;
  let capture = order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
  if (!capture) {
    const captured = await api("POST", `/v2/checkout/orders/${order.id}/capture`, {});
    if (captured.status >= 300) return { ok: false, step: "capture", r: captured, orderStatus: order.status };
    order = captured.body;
    capture = order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
  }
  return { ok: !!capture, orderId: order.id, orderStatus: order.status, captureId: capture?.id ?? null, captureStatus: capture?.status ?? null, reason: capture?.status_details?.reason ?? null };
}
