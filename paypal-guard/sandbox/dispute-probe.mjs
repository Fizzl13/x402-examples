// Can a card payment in the PayPal sandbox be disputed by API? A sandbox-only probe for the demo's dispute case:
// pay by card, raise a chargeback with PayPal's sandbox endpoint (/v2/customer-support/process-chargeback), see
// it in the Disputes API, and accept the claim. Test money only.
import { api, brief, cardPayment } from "./api.mjs";

const now = new Date();
const iso = (d) => d.toISOString();
const pay = await cardPayment({ email: "carol@example.com", value: "40.00", currency: "USD", description: "Dispute probe" });
if (!pay.ok) { console.log("card payment failed", pay.step, brief(pay.r)); process.exit(1); }
console.log("capture", pay.captureId);
const cap = await api("GET", `/v2/payments/captures/${pay.captureId}`);
const merchantId = cap.body?.payee?.merchant_id;
console.log("capture read", brief(cap), "merchant id known:", Boolean(merchantId));

const cb = await api("POST", "/v2/customer-support/process-chargeback", {
  adjacency: "PAYPAL", file_layout: "ATCK_CB", merchant_id: merchantId, financial_institution: { processor: "FDMS" },
  transaction: { id_enc: pay.captureId, amount: { currency_code: "USD", value: "40.00" } },
  instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: String(Date.now()).padEnd(16, "7"), external: false },
  dispute: {
    id: null, stage: "CHARGEBACK", status: "2", amount: { currency_code: "USD", value: "40.00" },
    receive_date: iso(now), money_movement_date: iso(now), response_date: iso(new Date(now.getTime() + 10 * 864e5)),
    event_code: "CHARGEBACK_INITIATED", event_type: "DEBIT", chargeback_type: "REPORTED_TO_PROCESSOR",
    processor_info: { reference_number: String(Date.now()).padEnd(23, "3"), reason_code: "1330", notes: "TEST_MEMO" },
  },
});
console.log("process-chargeback", brief(cb), JSON.stringify(cb.body).slice(0, 300));

let dispute = null;
for (let i = 0; i < 12 && !dispute; i++) {
  const list = await api("GET", `/v1/customer/disputes?disputed_transaction_id=${pay.captureId}`);
  dispute = list.body?.items?.[0] ?? null;
  if (!dispute) { console.log("list", brief(list), "items", list.body?.items?.length ?? 0); await new Promise((r) => setTimeout(r, 10_000)); }
}
if (!dispute) {
  const any = await api("GET", "/v1/customer/disputes?page_size=5");
  console.log("no dispute for the capture; recent disputes on the account:", brief(any), JSON.stringify((any.body?.items ?? []).map((d) => [d.dispute_id, d.status, d.reason, d.dispute_amount?.value])));
  process.exit(0);
}
const d = await api("GET", `/v1/customer/disputes/${dispute.dispute_id}`);
console.log("dispute", dispute.dispute_id, d.body?.status, d.body?.reason, d.body?.dispute_life_cycle_stage, d.body?.dispute_amount?.value, "links", (d.body?.links ?? []).map((l) => l.rel).join(","));
console.log("disputed transaction", JSON.stringify(d.body?.disputed_transactions?.[0] ?? {}).slice(0, 300));
console.log("disputes listed for the capture after", Math.round((Date.now() - now.getTime()) / 1000), "s");
// Does PayPal itself stop a refund of a payment under an open chargeback? If not, the shop pays twice.
const refund = await api("POST", `/v2/payments/captures/${pay.captureId}/refund`, { amount: { currency_code: "USD", value: "40.00" }, note_to_payer: "Sandbox probe" });
console.log("refund while the chargeback is open", brief(refund), refund.body?.status ?? "", JSON.stringify(refund.body?.details ?? "").slice(0, 200));
const after = await api("GET", `/v2/payments/captures/${pay.captureId}`);
console.log("capture after", after.body?.status, JSON.stringify(after.body?.status_details ?? {}));
