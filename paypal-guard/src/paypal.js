// Read-only PayPal REST calls the guard needs to judge an action by facts, not by what the model says:
// how much a capture was and how much of it is already refunded, who paid it, who a subscription or an
// invoice belongs to, and how much a dispute is about. Uses the merchant's own REST app (client id and
// secret, the same as the toolkit), sandbox or live. It never writes.
const BASES = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" };

export function paypalReader({ clientId, clientSecret, sandbox = true, fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!clientId || !clientSecret) throw new TypeError("paypalReader: clientId and clientSecret are required");
  const base = sandbox ? BASES.sandbox : BASES.live;
  let token = null; // { value, until }

  async function bearer() {
    if (token && Date.now() < token.until) return token.value;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`PayPal token: HTTP ${res.status} ${body.error_description ?? body.error ?? ""}`.trim());
    token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 300) - 60) * 1000 };
    return token.value;
  }

  async function get(path) {
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await bearer()}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`PayPal GET ${path.split("?")[0]}: HTTP ${res.status} ${body?.name ?? ""}`.trim());
    return body;
  }
  const id = (v) => encodeURIComponent(String(v ?? ""));

  return {
    // { amount, currency, refunded, payer, orderId, status } for a capture, or null if PayPal doesn't know it.
    async capture(captureId) {
      const c = await get(`/v2/payments/captures/${id(captureId)}`);
      if (!c) return null;
      const orderId = c.supplementary_data?.related_ids?.order_id ?? null;
      const order = orderId ? await get(`/v2/checkout/orders/${id(orderId)}`) : null;
      // Refunds of this capture already made or on their way (a failed or cancelled one gave nothing back).
      let refunded = 0n;
      for (const unit of order?.purchase_units ?? []) {
        for (const r of unit.payments?.refunds ?? []) {
          if (["CANCELLED", "FAILED"].includes(r.status)) continue;
          const up = (r.links ?? []).find((l) => l.rel === "up")?.href ?? "";
          if (up && !up.endsWith(`/captures/${captureId}`)) continue;
          if (r.amount?.currency_code === c.amount?.currency_code) refunded += toMilli(r.amount.value);
        }
      }
      // Who paid: the buyer's PayPal email. A card payment has none; then the merchant's own customer
      // reference (custom_id or invoice_id) is all there is, for the guard's customerOf hook.
      const payer = order?.payer?.email_address ?? order?.payment_source?.paypal?.email_address ?? null;
      return { amount: c.amount?.value ?? null, currency: c.amount?.currency_code ?? null, refunded: fromMilli(refunded), payer, orderId, status: c.status ?? null, customId: c.custom_id ?? null, invoiceId: c.invoice_id ?? null };
    },
    async subscription(subscriptionId) {
      const s = await get(`/v1/billing/subscriptions/${id(subscriptionId)}`);
      return s ? { payer: s.subscriber?.email_address ?? null, status: s.status ?? null, planId: s.plan_id ?? null } : null;
    },
    async invoice(invoiceId) {
      const inv = await get(`/v2/invoicing/invoices/${id(invoiceId)}`);
      if (!inv) return null;
      const recipients = (inv.primary_recipients ?? []).map((r) => r.billing_info?.email_address).filter(Boolean);
      return { recipients, amount: inv.amount?.value ?? null, currency: inv.amount?.currency_code ?? null, status: inv.status ?? null };
    },
    async dispute(disputeId) {
      const d = await get(`/v1/customer/disputes/${id(disputeId)}`);
      return d ? { amount: d.dispute_amount?.value ?? null, currency: d.dispute_amount?.currency_code ?? null, status: d.status ?? null, reason: d.reason ?? null } : null;
    },
  };
}

// Amounts as whole thousandths, so "12.5", "12.50" and "12.500" compare as equal and nothing is a float.
export function toMilli(v) {
  const s = String(v ?? "").trim();
  const m = /^(-?)(\d*)(?:\.(\d{0,3}))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) throw new TypeError(`not an amount: ${JSON.stringify(v)}`);
  const n = BigInt(m[2] || "0") * 1000n + BigInt((m[3] ?? "").padEnd(3, "0") || "0");
  return m[1] ? -n : n;
}
export function fromMilli(n) {
  const neg = n < 0n, a = neg ? -n : n;
  const whole = a / 1000n, frac = (a % 1000n).toString().padStart(3, "0").replace(/0$/, "");
  return `${neg ? "-" : ""}${whole}.${frac.padEnd(2, "0")}`;
}
