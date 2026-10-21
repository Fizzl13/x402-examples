// Every tool of PayPal's Agent Toolkit (@paypal/agent-toolkit 1.11), sorted by what it can do to the merchant's
// money. The toolkit itself only switches tools on or off; the guard decides per call, by kind:
//   read    looks only                                         -> allowed
//   refund  money leaves the merchant (create_refund)          -> limits, the customer's own order only
//   dispute money leaves the merchant (accept_dispute_claim)   -> the owner is asked
//   books   the books say money moved, while none did          -> the owner is asked
//   stop    stops or removes something a customer pays for     -> a few a day, then the owner is asked
//   price   changes what customers pay                         -> the owner is asked
//   bill    asks a customer for money                          -> a number a day, then the owner is asked
//   other   housekeeping                                       -> allowed
// A tool not listed here (a newer toolkit) is "unknown": the owner is asked.
export const ACTIONS = Object.freeze({
  // read
  list_invoices: "read", get_invoice: "read", search_invoicing: "read", generate_invoice_qr_code: "read",
  generate_invoice_number: "read", get_recurring_series: "read", list_products: "read", show_product_details: "read",
  list_subscription_plans: "read", show_subscription_plan_details: "read", show_subscription_details: "read",
  get_shipment_tracking: "read", get_order: "read", list_disputes: "read", get_dispute: "read",
  list_transactions: "read", get_refund: "read", get_merchant_insights: "read",
  // money out
  create_refund: "refund",
  accept_dispute_claim: "dispute",
  // the books only
  record_payment_for_invoice: "books", record_refund_for_invoice: "books",
  // stops something a customer pays for
  cancel_subscription: "stop", cancel_sent_invoice: "stop", delete_invoice: "stop",
  cancel_recurring_series: "stop", delete_recurring_series: "stop", cancel_invoice_auto_reminder: "stop",
  // prices and terms
  update_plan: "price", update_subscription: "price", update_product: "price", update_invoicing: "price",
  create_subscription_plan: "price",
  // bills a customer
  create_invoice: "bill", send_invoice: "bill", create_recurring_series: "bill", activate_recurring_series: "bill",
  create_subscription: "bill",
  // housekeeping
  create_order: "other", pay_order: "other", send_invoice_reminder: "other", create_product: "other",
  create_shipment_tracking: "other", update_shipment_tracking: "other", setup_invoice_auto_reminders: "other",
  update_invoice_auto_reminder: "other", create_conditional_rules_for_invoice: "other",
});

export const kindOf = (name) => ACTIONS[name] ?? "unknown";

// What the owner gets unless they set otherwise. Amounts are in `currency`; "ask" means the owner decides,
// "deny" means never, "allow" means always. A limit object asks the owner once the limit would be passed.
export const DEFAULT_POLICY = Object.freeze({
  currency: "USD",
  refund: { perAction: "25.00", perDay: "100.00", countPerDay: 10 },
  dispute: "ask",
  books: "ask",
  stop: { countPerDay: 3 },
  price: "ask",
  bill: { countPerDay: 20 },
  other: "allow",
  read: "allow",
  unknown: "ask",
  // A refund, cancellation or bill for someone other than the customer in this conversation.
  otherCustomer: "deny",
  // TypeSafe's Jev says the action doesn't follow from what the customer asked (when an intent checker is set).
  offIntent: "ask",
});

import { toMilli, fromMilli } from "./paypal.js";

// One line for the owner's phone and the log: what the agent wants to do, in plain words.
export function describe(name, args = {}, facts = {}) {
  const amt = (a) => (a?.value ? `${a.value} ${a.currency_code ?? ""}`.trim() : null);
  switch (name) {
    case "create_refund": {
      // Without an amount PayPal refunds what's left of the payment, so that is what the line says.
      const left = facts.amount ? fromMilli(toMilli(facts.amount) - toMilli(facts.refunded ?? "0")) : null;
      const what = amt(args.amount) ?? (left === null ? "the full payment" : left === facts.amount ? `${left} ${facts.currency} (the full payment)` : toMilli(left) <= 0n ? `a payment of ${facts.amount} ${facts.currency} that was already refunded in full` : `${left} ${facts.currency} (what's left of ${facts.amount})`);
      return `refund ${what}${facts.payer ? ` to ${facts.payer}` : ""} (capture ${args.capture_id})`;
    }
    case "accept_dispute_claim": return `accept dispute ${args.dispute_id}${facts.amount ? ` and pay ${facts.amount} ${facts.currency}` : ""}`;
    case "record_payment_for_invoice": return `mark invoice ${args.invoice_id} as paid${amt(args.amount) ? ` (${amt(args.amount)})` : ""}, without money moving`;
    case "record_refund_for_invoice": return `mark invoice ${args.invoice_id} as refunded${amt(args.amount) ? ` (${amt(args.amount)})` : ""}, without money moving`;
    case "cancel_subscription": return `cancel subscription ${args.subscription_id}${facts.payer ? ` of ${facts.payer}` : ""}`;
    case "send_invoice": return `send invoice ${args.invoice_id}${facts.recipients?.length ? ` to ${facts.recipients.join(", ")}` : ""}`;
    default: return `${name.replaceAll("_", " ")}${args && Object.keys(args).length ? ` ${JSON.stringify(args).slice(0, 160)}` : ""}`;
  }
}
