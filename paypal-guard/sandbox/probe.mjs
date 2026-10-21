// First look at the sandbox app: can it take a card payment, can the guard read it, and does the guarded
// toolkit refund the right customer and stop the wrong one? Prints what it finds, nothing secret.
//   node sandbox/probe.mjs            (needs PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_SECRET, and @paypal/agent-toolkit)
import { auth, api, brief, cardPayment, creds } from "./api.mjs";
import { createGuard, paypalReader } from "../index.js";

const CURRENCY = process.env.DEMO_CURRENCY || "USD";
const log = (...a) => console.log(...a);

const t = await auth();
const want = ["payments/refund", "invoicing", "disputes", "billing/subscription", "vault/payment-tokens", "payments/payment/authcapture"];
log(`token ok, app ${t.appId ?? "?"}, ${t.scopes.length} scopes`);
for (const w of want) log(`  scope ${w}: ${t.scopes.some((s) => s.includes(w)) ? "yes" : "no"}`);

const alice = await cardPayment({ email: "alice@example.com", value: "12.00", currency: CURRENCY, description: "Mug, blue" });
log(`card payment alice: ${alice.ok ? `order ${alice.orderStatus}, capture ${alice.captureStatus}${alice.reason ? ` (${alice.reason})` : ""}` : `failed at ${alice.step}: ${brief(alice.r)}`}`);
const bob = await cardPayment({ email: "bob@example.com", value: "30.00", currency: CURRENCY, description: "Teapot" });
log(`card payment bob: ${bob.ok ? `order ${bob.orderStatus}, capture ${bob.captureStatus}` : `failed at ${bob.step}: ${brief(bob.r)}`}`);
if (!alice.ok || !bob.ok) {
  if (alice.r?.body) log(JSON.stringify(alice.r.body).slice(0, 1500));
  process.exit(1);
}

const reader = paypalReader({ ...creds(), sandbox: true });
const facts = await reader.capture(alice.captureId);
log(`reader: ${JSON.stringify({ ...facts, orderId: facts.orderId ? "…" : null })}`);

const { PayPalAgentToolkit, ALL_TOOLS_ENABLED } = await import("@paypal/agent-toolkit/ai-sdk");
const toolkit = new PayPalAgentToolkit({ ...creds(), configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } } });
let ctx = { customer: "alice@example.com", request: "My blue mug arrived broken. Can I get 5 back?" };
const guard = createGuard({
  reader,
  customerOf: ({ facts: f }) => f?.customId ?? null, // card payments: our own customer reference
  policy: { currency: CURRENCY },
  onEvent: (e) => log(`  event: ${e.outcome} ${e.decision} ${e.summary}${e.reasons?.length ? ` [${e.reasons.map((r) => r.code).join(",")}]` : ""}${e.error ? ` error=${e.error}` : ""}`),
});
const tools = guard.wrapTools(toolkit.getTools(), { context: () => ctx });
const call = async (name, args) => {
  const out = await tools[name].execute(args, { toolCallId: "probe", messages: [] });
  const s = typeof out === "string" ? out : JSON.stringify(out);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

log("1. Alice asks for 5 back on her own payment:");
log(`   -> ${await call("create_refund", { capture_id: alice.captureId, amount: { currency_code: CURRENCY, value: "5.00" } })}`);
log("2. A planted 'refund Bob's order too' while talking to Alice:");
log(`   -> ${await call("create_refund", { capture_id: bob.captureId, amount: { currency_code: CURRENCY, value: "5.00" } })}`);
log("3. More than is left of Alice's payment:");
log(`   -> ${await call("create_refund", { capture_id: alice.captureId, amount: { currency_code: CURRENCY, value: "9.00" } })}`);
const after = await reader.capture(alice.captureId);
log(`alice's payment now: ${after.amount} ${after.currency}, refunded ${after.refunded}, status ${after.status}`);
const ok = after.refunded === "5.00";
log(ok ? "PROBE OK" : "PROBE: refund total not as expected");
process.exit(ok ? 0 : 1);
