import test from "node:test";
import assert from "node:assert/strict";
import { createGuard, paypalReader, telegramApproval, fizzlWalletApproval, jevIntent, toMilli, fromMilli, kindOf, ACTIONS } from "../index.js";

const ALICE = "alice@example.com", BOB = "bob@example.com";
// A pretend PayPal: two of Alice's payments and one of Bob's.
const captures = {
  CAP_ALICE_1: { amount: "40.00", currency: "USD", refunded: "0.00", payer: ALICE },
  CAP_ALICE_2: { amount: "12.00", currency: "USD", refunded: "0.00", payer: ALICE },
  CAP_ALICE_3: { amount: "300.00", currency: "USD", refunded: "0.00", payer: ALICE },
  CAP_PART: { amount: "40.00", currency: "USD", refunded: "30.00", payer: ALICE },
  CAP_BOB: { amount: "25.00", currency: "USD", refunded: "0.00", payer: BOB },
};
const reader = {
  capture: async (id) => captures[id] ?? null,
  dispute: async () => ({ amount: "80.00", currency: "USD", status: "OPEN" }),
  subscription: async (id) => ({ payer: id === "SUB_BOB" ? BOB : ALICE, status: "ACTIVE" }),
  invoice: async () => ({ recipients: [ALICE], amount: "10.00", currency: "USD" }),
};
const ctx = { customer: ALICE, request: "My mug arrived broken, can I get my money back?" };
const refund = (capture_id, value) => ({ capture_id, ...(value ? { amount: { currency_code: "USD", value } } : {}) });
function setup(opts = {}) {
  const calls = [];
  const exec = async (args) => { calls.push(args); return { id: "RF1", status: "COMPLETED" }; };
  const guard = createGuard({ reader, ...opts });
  return { guard, calls, exec };
}

test("read tools pass untouched", async () => {
  const { guard, calls, exec } = setup();
  const out = await guard.run("get_order", { id: "O1" }, exec, ctx);
  assert.equal(out.status, "COMPLETED");
  assert.equal(calls.length, 1);
});

test("a small refund of the customer's own payment goes through and is counted", async () => {
  const { guard, calls, exec } = setup();
  const out = await guard.run("create_refund", refund("CAP_ALICE_1", "12.50"), exec, ctx);
  assert.equal(out.status, "COMPLETED");
  assert.equal(calls.length, 1);
  const ev = guard.events().at(-1);
  assert.equal(ev.outcome, "done");
  assert.equal(ev.decision, "allow");
  const dry = await guard.check("create_refund", refund("CAP_ALICE_3", "20.00"), ctx);
  assert.equal(dry.decision, "allow"); // 12.50 + 20 is still under 100 a day
  const over = await guard.check("create_refund", refund("CAP_ALICE_2", "20.00"), ctx);
  assert.deepEqual(over.reasons.map((r) => r.code), ["OVER_REFUND"]); // that payment was 12.00
});

test("someone else's payment is never refunded", async () => {
  const approvals = [];
  const { guard, calls, exec } = setup({ approve: async (r) => { approvals.push(r); return { approved: true }; } });
  const out = await guard.run("create_refund", refund("CAP_BOB", "5.00"), exec, ctx);
  assert.equal(out.blocked, true);
  assert.equal(out.decision, "deny");
  assert.match(out.message, /bob@example\.com, not for alice@example\.com/);
  assert.equal(calls.length, 0);
  assert.equal(approvals.length, 0, "a deny doesn't even ask");
});

test("never more than is left of the payment", async () => {
  const { guard, calls, exec } = setup();
  const out = await guard.run("create_refund", refund("CAP_PART", "15.00"), exec, ctx);
  assert.equal(out.blocked, true);
  assert.match(out.reasons[0], /more than what's left of this payment \(10\.00 of 40\.00 USD\)/);
  assert.equal(calls.length, 0);
});

test("a refund without an amount is the rest of the payment, and is judged as such", async () => {
  const { guard, exec } = setup();
  const dry = await guard.check("create_refund", refund("CAP_ALICE_3"), ctx);
  assert.equal(dry.decision, "ask");
  assert.ok(dry.reasons.some((r) => r.code === "PER_ACTION" && /300\.00 USD/.test(r.message)));
  const out = await guard.run("create_refund", refund("CAP_ALICE_2"), exec, ctx);
  assert.equal(out.status, "COMPLETED");
});

test("a payment refunded in full has nothing left to refund, and the line says what's left", async () => {
  const done = { ...reader, capture: async (id) => (id === "CAP_DONE" ? { amount: "12.00", currency: "USD", refunded: "12.00", payer: ALICE } : captures[id] ?? null) };
  const guard = createGuard({ reader: done });
  const r = await guard.check("create_refund", refund("CAP_DONE"), ctx);
  assert.equal(r.decision, "deny");
  assert.equal(r.reasons[0].code, "NOTHING_LEFT");
  assert.match((await guard.check("create_refund", refund("CAP_PART"), ctx)).summary, /refund 10\.00 USD \(what's left of 40\.00\) to alice@example\.com/);
  assert.match((await guard.check("create_refund", refund("CAP_ALICE_2"), ctx)).summary, /refund 12\.00 USD \(the full payment\)/);
});

test("over the per-refund limit the owner decides", async () => {
  const asked = [];
  let answer = true;
  const { guard, calls, exec } = setup({ approve: async (r) => { asked.push(r); return { approved: answer, by: "test" }; } });
  const yes = await guard.run("create_refund", refund("CAP_ALICE_3", "60.00"), exec, ctx);
  assert.equal(yes.status, "COMPLETED");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].customer, ALICE);
  assert.match(asked[0].summary, /refund 60\.00 USD to alice@example\.com/);
  assert.ok(asked[0].reasons.some((r) => r.code === "PER_ACTION"));
  answer = false;
  const no = await guard.run("create_refund", refund("CAP_ALICE_1", "30.00"), exec, ctx);
  assert.equal(no.blocked, true);
  assert.match(no.message, /the shop owner didn't approve it/);
  assert.equal(calls.length, 1);
  assert.deepEqual(guard.events().map((e) => e.outcome), ["asked", "done", "asked", "blocked"]);
});

test("without a way to ask, over the limit is a no", async () => {
  const { guard, calls, exec } = setup();
  const out = await guard.run("create_refund", refund("CAP_ALICE_3", "60.00"), exec, ctx);
  assert.equal(out.blocked, true);
  assert.match(out.message, /needs the shop owner's OK/);
  assert.equal(calls.length, 0);
});

test("the daily total, the daily count and a second refund of one payment ask the owner", async () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`CAP_MANY_${i}`, { amount: "30.00", currency: "USD", refunded: "0.00", payer: ALICE }]));
  const guard = createGuard({ reader: { ...reader, capture: async (id) => many[id] ?? captures[id] } });
  const exec = async () => ({ status: "COMPLETED" });
  for (let i = 0; i < 4; i++) assert.equal((await guard.run("create_refund", refund(`CAP_MANY_${i}`, "25.00"), exec, ctx)).status, "COMPLETED");
  const fifth = await guard.check("create_refund", refund("CAP_MANY_4", "1.00"), ctx);
  assert.ok(fifth.reasons.some((r) => r.code === "PER_DAY" && /101\.00 USD/.test(r.message)));
  const again = await guard.check("create_refund", refund("CAP_MANY_0", "1.00"), ctx);
  assert.ok(again.reasons.some((r) => r.code === "REPEAT"));
  const counted = createGuard({ reader: { ...reader, capture: async (id) => many[id] }, policy: { refund: { countPerDay: 2 } } });
  await counted.run("create_refund", refund("CAP_MANY_0", "1.00"), exec, ctx);
  await counted.run("create_refund", refund("CAP_MANY_1", "1.00"), exec, ctx);
  const third = await counted.check("create_refund", refund("CAP_MANY_2", "1.00"), ctx);
  assert.ok(third.reasons.some((r) => r.code === "COUNT_PER_DAY"));
  assert.equal(counted.policy.refund.perAction, "25.00", "a partial policy keeps the other defaults");
});

test("two refunds at the same moment can't both use the last of the day", async () => {
  const guard = createGuard({ reader, policy: { refund: { perAction: "100.00", perDay: "100.00" } } });
  let release;
  const gate = new Promise((r) => { release = r; });
  const exec = async () => { await gate; return { status: "COMPLETED" }; };
  const both = Promise.all([guard.run("create_refund", refund("CAP_ALICE_3", "60.00"), exec, ctx), guard.run("create_refund", refund("CAP_ALICE_1", "40.00"), exec, ctx), guard.run("create_refund", refund("CAP_ALICE_2", "12.00"), exec, ctx)]);
  setTimeout(release, 20);
  const outs = await both;
  assert.deepEqual(outs.map((o) => (o.blocked ? "blocked" : "done")), ["done", "done", "blocked"]);
});

test("a refund PayPal refuses gives the day's room back", async () => {
  const guard = createGuard({ reader, policy: { refund: { perDay: "30.00" } } });
  await assert.rejects(guard.run("create_refund", refund("CAP_ALICE_1", "25.00"), async () => { throw new Error("UNPROCESSABLE_ENTITY"); }, ctx), /UNPROCESSABLE/);
  assert.equal(guard.events().at(-1).outcome, "failed");
  const dry = await guard.check("create_refund", refund("CAP_ALICE_1", "25.00"), ctx);
  assert.equal(dry.decision, "allow");
});

test("a refund the toolkit reports as failed (it returns the error, it doesn't throw) isn't counted", async () => {
  const guard = createGuard({ reader, policy: { refund: { perDay: "30.00" } } });
  const failed = JSON.stringify({ error: { message: "UNPROCESSABLE_ENTITY: REFUND_AMOUNT_EXCEEDED", type: "paypal_error" } });
  assert.equal(await guard.run("create_refund", refund("CAP_ALICE_1", "25.00"), async () => failed, ctx), failed);
  assert.equal(guard.events().at(-1).outcome, "failed");
  assert.match(guard.events().at(-1).error, /REFUND_AMOUNT_EXCEEDED/);
  assert.equal((await guard.check("create_refund", refund("CAP_ALICE_1", "25.00"), ctx)).decision, "allow");
});

test("allowing a kind lifts its limits, not the customer check", async () => {
  const guard = createGuard({ reader, policy: { stop: "allow", bill: "allow" } });
  assert.equal((await guard.check("cancel_subscription", { subscription_id: "SUB_BOB" }, ctx)).decision, "deny");
  assert.equal((await guard.check("cancel_subscription", { subscription_id: "SUB_A1" }, ctx)).decision, "allow");
});

test("disputes, books, price changes and unknown tools ask the owner", async () => {
  const asked = [];
  const { guard, exec } = setup({ approve: async (r) => { asked.push(r.tool); return { approved: false }; } });
  for (const t of ["accept_dispute_claim", "record_payment_for_invoice", "update_plan", "brand_new_tool"]) {
    const out = await guard.run(t, { dispute_id: "D1", invoice_id: "INV1", plan_id: "P-123456789012" }, exec, ctx);
    assert.equal(out.blocked, true, t);
  }
  assert.deepEqual(asked, ["accept_dispute_claim", "record_payment_for_invoice", "update_plan", "brand_new_tool"]);
  const d = await guard.check("accept_dispute_claim", { dispute_id: "D1" }, ctx);
  assert.match(d.reasons[0].message, /pays the buyer 80\.00 USD/);
});

test("cancellations: the customer's own, a few a day; someone else's never", async () => {
  const { guard, calls, exec } = setup();
  for (let i = 0; i < 3; i++) assert.equal((await guard.run("cancel_subscription", { subscription_id: `SUB_A${i}`, payload: { reason: "asked" } }, exec, ctx)).status, "COMPLETED");
  const fourth = await guard.run("cancel_subscription", { subscription_id: "SUB_A4", payload: { reason: "asked" } }, exec, ctx);
  assert.ok(fourth.blocked && /number 4 today/.test(fourth.message));
  const bob = await guard.check("cancel_subscription", { subscription_id: "SUB_BOB" }, ctx);
  assert.equal(bob.decision, "deny");
  assert.equal(calls.length, 3);
});

test("a bill to someone else than the customer is stopped", async () => {
  const { guard } = setup();
  const r = await guard.check("create_invoice", { primary_recipients: [{ billing_info: { email_address: "mallory@evil.example" } }] }, ctx);
  assert.equal(r.decision, "deny");
  assert.equal(r.reasons[0].code, "OTHER_CUSTOMER");
  const own = await guard.check("send_invoice", { invoice_id: "INV1" }, ctx);
  assert.equal(own.decision, "allow");
});

test("an action that doesn't fit the request asks the owner (Jev)", async () => {
  let seen;
  const intent = async (q) => { seen = q; return { fits: 0.08 }; };
  const { guard } = setup({ intent });
  const r = await guard.check("create_refund", refund("CAP_ALICE_2", "5.00"), { customer: ALICE, request: "Where is my parcel?" });
  assert.equal(r.decision, "ask");
  assert.match(r.reasons[0].message, /92% sure/);
  assert.equal(seen.request, "Where is my parcel?");
  assert.match(seen.action, /refund 5\.00 USD to alice@example\.com/);
  const fits = createGuard({ reader, intent: async () => ({ fits: 0.9 }) });
  assert.equal((await fits.check("create_refund", refund("CAP_ALICE_2", "5.00"), ctx)).decision, "allow");
  const down = createGuard({ reader, intent: async () => null });
  assert.equal((await down.check("create_refund", refund("CAP_ALICE_2", "5.00"), ctx)).decision, "allow", "no answer is no reason to stop");
});

test("without a reader the guard can't vouch for a payment and asks", async () => {
  const guard = createGuard({});
  const r = await guard.check("create_refund", refund("CAP_ALICE_1", "5.00"), ctx);
  assert.equal(r.decision, "ask");
  assert.ok(r.reasons.some((x) => x.code === "CUSTOMER_UNKNOWN"));
  const full = await guard.check("create_refund", refund("CAP_ALICE_1"), {});
  assert.ok(full.reasons.some((x) => x.code === "AMOUNT_UNKNOWN"));
});

test("a PayPal read that fails makes the guard ask, not guess", async () => {
  const guard = createGuard({ reader: { capture: async () => { throw new Error("PayPal GET /v2/payments/captures: HTTP 503"); } } });
  const r = await guard.check("create_refund", refund("CAP_X", "5.00"), ctx);
  assert.equal(r.decision, "ask");
  assert.equal(r.reasons[0].code, "NO_FACTS");
});

test("wrapTools guards every tool of a toolkit, with the app's context", async () => {
  const ran = [];
  const tools = {
    get_order: { description: "d", parameters: {}, execute: async (a) => { ran.push(["get_order", a]); return { ok: 1 }; } },
    create_refund: { description: "d", parameters: {}, execute: async (a, opts) => { ran.push(["create_refund", a, opts]); return { status: "COMPLETED" }; } },
  };
  let current = { customer: BOB };
  const guard = createGuard({ reader });
  const wrapped = guard.wrapTools(tools, { context: () => current });
  assert.deepEqual(Object.keys(wrapped), ["get_order", "create_refund"]);
  assert.equal(wrapped.create_refund.description, "d");
  assert.deepEqual(await wrapped.get_order.execute({ id: "1" }), { ok: 1 });
  const stopped = await wrapped.create_refund.execute(refund("CAP_ALICE_1", "5.00"), { toolCallId: "t1" });
  assert.equal(stopped.blocked, true);
  current = { customer: ALICE };
  const done = await wrapped.create_refund.execute(refund("CAP_ALICE_1", "5.00"), { toolCallId: "t2" });
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(ran.at(-1), ["create_refund", refund("CAP_ALICE_1", "5.00"), { toolCallId: "t2" }]);
});

test("every toolkit tool has a kind; policy values are checked", () => {
  assert.equal(Object.keys(ACTIONS).length, 47);
  assert.equal(kindOf("create_refund"), "refund");
  assert.equal(kindOf("nope"), "unknown");
  assert.throws(() => createGuard({ policy: { refund: "maybe" } }), /policy\.refund/);
  assert.throws(() => createGuard({ policy: { otherCustomer: "allow" } }), /otherCustomer/);
});

test("amounts are exact", () => {
  assert.equal(toMilli("12.5"), 12500n);
  assert.equal(toMilli("0.07"), 70n);
  assert.equal(fromMilli(12500n), "12.50");
  assert.equal(fromMilli(12345n), "12.345");
  assert.equal(fromMilli(0n), "0.00");
  assert.throws(() => toMilli("1e3"), /not an amount/);
});

// A fetch that answers from a table of "METHOD path" -> body.
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, init = {}) => {
    const u = new URL(url), key = `${init.method ?? "GET"} ${u.pathname}`;
    seen.push({ key, init });
    const body = typeof routes[key] === "function" ? routes[key](init) : routes[key];
    if (body === undefined) return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.seen = seen;
  return f;
}

test("paypalReader reads a capture, its payer and what was refunded", async () => {
  const fetch = fakeFetch({
    "POST /v1/oauth2/token": { access_token: "A21", expires_in: 32000 },
    "GET /v2/payments/captures/CAP1": { id: "CAP1", status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "40.00" }, custom_id: "cust-7", supplementary_data: { related_ids: { order_id: "ORD1" } } },
    "GET /v2/checkout/orders/ORD1": { id: "ORD1", payer: { email_address: ALICE }, purchase_units: [{ payments: { refunds: [
      { status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" }, links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1" }] },
      { status: "CANCELLED", amount: { currency_code: "USD", value: "5.00" }, links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1" }] },
      { status: "COMPLETED", amount: { currency_code: "USD", value: "3.00" }, links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/OTHER" }] },
    ] } }] },
  });
  const r = paypalReader({ clientId: "id", clientSecret: "secret", fetch });
  assert.deepEqual(await r.capture("CAP1"), { amount: "40.00", currency: "USD", refunded: "10.00", payer: ALICE, orderId: "ORD1", status: "PARTIALLY_REFUNDED", customId: "cust-7", invoiceId: null });
  assert.equal(await r.capture("NOPE"), null);
  assert.equal(fetch.seen.filter((s) => s.key === "POST /v1/oauth2/token").length, 1, "the token is reused");
  assert.match(fetch.seen[0].init.headers.authorization, /^Basic /);
  assert.equal(fetch.seen[1].init.headers.authorization, "Bearer A21");
});

test("paypalReader tries a read again when PayPal is busy, and gives up after three", async () => {
  let calls = 0;
  const fetch = async (url) => {
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "A21", expires_in: 32000 }));
    calls++;
    if (url.includes("/captures/BUSY")) return new Response("{}", { status: 503 });
    if (calls === 1) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ id: "CAP2", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } }));
  };
  const r = paypalReader({ clientId: "id", clientSecret: "secret", fetch });
  assert.equal((await r.capture("CAP2")).amount, "5.00");
  assert.equal(calls, 2);
  calls = 10;
  await assert.rejects(r.capture("BUSY"), /HTTP 503/);
  assert.equal(calls, 13);
});

test("telegramApproval sends Approve/Deny buttons and waits for the owner's tap", async () => {
  let sent;
  let polls = 0;
  const fetch = fakeFetch({
    "POST /botT0K/sendMessage": (init) => { sent = JSON.parse(init.body); return { ok: true, result: { message_id: 42 } }; },
    "POST /botT0K/getUpdates": () => {
      polls++;
      const data = `pg:${sent.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1]}:y`;
      return { ok: true, result: polls === 1 ? [
        { update_id: 7, callback_query: { id: "cq0", data, from: { id: 1 }, message: { chat: { id: 999 } } } }, // another chat: ignored
        { update_id: 8, callback_query: { id: "cq1", data, from: { id: 5, username: "owner" }, message: { chat: { id: 555 } } } },
      ] : [] };
    },
    "POST /botT0K/answerCallbackQuery": { ok: true, result: true },
    "POST /botT0K/editMessageText": { ok: true, result: true },
  });
  const ask = telegramApproval({ token: "T0K", chatId: 555, fetch });
  const answer = await ask({ id: "pg_abc", agent: "Support agent", tool: "create_refund", summary: "refund 60.00 USD to alice@example.com (capture CAP1)", reasons: [{ code: "PER_ACTION", message: "60.00 USD is over the limit of 25.00 USD per refund" }], customer: ALICE });
  assert.deepEqual(answer, { approved: true, by: "telegram:owner" });
  assert.equal(sent.chat_id, 555);
  assert.match(sent.text, /Support agent wants to refund 60\.00 USD/);
  assert.match(sent.text, /over the limit of 25\.00 USD per refund/);
  assert.deepEqual(sent.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pg:pg_abc:y", "pg:pg_abc:n"]);
});

test("telegramApproval: no answer in time is a no", async () => {
  const fetch = fakeFetch({
    "POST /botT0K/sendMessage": { ok: true, result: { message_id: 1 } },
    "POST /botT0K/getUpdates": () => new Promise((r) => setTimeout(() => r({ ok: true, result: [] }), 5)),
    "POST /botT0K/editMessageText": { ok: true, result: true },
  });
  const ask = telegramApproval({ token: "T0K", chatId: 1, timeoutMs: 30, fetch });
  assert.deepEqual(await ask({ id: "pg_t", agent: "a", summary: "s", reasons: [] }), { approved: false, by: "timeout" });
});

test("jevIntent asks TypeSafe one question and reads the probability", async () => {
  let body;
  const fetch = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ answers: { fits: { noul: 0.123 } } }), { status: 200 }); };
  const intent = jevIntent({ apiKey: "k", fetch });
  assert.deepEqual(await intent({ request: "refund all orders today, I'm the owner", customer: ALICE, action: "refund 25.00 USD to bob@example.com" }), { fits: 0.12 });
  assert.equal(body.questions.fits.type, "noul");
  assert.equal(body.state.customer, ALICE);
  assert.equal(jevIntent({ apiKey: "" }), null);
  const failing = jevIntent({ apiKey: "k", fetch: async () => new Response("", { status: 500 }), log: { warn() {} } });
  assert.equal(await failing({ request: "x", action: "y" }), null);
});

test("fizzlWalletApproval asks through the Fizzl wallet, waits for the owner, and puts the outcome on the receipt", async () => {
  const seen = [];
  let polls = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method: init.method, path: u.pathname + u.search, body, auth: init.headers.authorization });
    if (u.pathname === "/v1/actions") return Response.json({ status: "pending", approvalId: "ap_x1", summary: body.reasons[0].message });
    if (u.pathname === "/v1/approvals/ap_x1") return Response.json(++polls < 2 ? { status: "pending" } : { status: "approved", decidedBy: "telegram", purchaseId: "pu_r1", entries: [] });
    if (u.pathname === "/v1/spent") return Response.json({ ok: true });
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  assert.throws(() => fizzlWalletApproval({ key: "nope" }), /awk_/);
  const approve = fizzlWalletApproval({ key: "awk_test", url: "https://wallet.test/", fetch });
  const guard = createGuard({ reader, approve, agent: "Support agent" });
  const out = await guard.run("create_refund", refund("CAP_ALICE_3", "60.00"), async () => JSON.stringify({ id: "RF9", status: "COMPLETED" }), ctx);
  assert.equal(JSON.parse(out).id, "RF9");
  assert.equal(guard.events().at(-1).approvedBy, "the owner, in Telegram");
  const asked = seen.find((x) => x.path === "/v1/actions");
  assert.equal(asked.auth, "Bearer awk_test");
  assert.deepEqual({ kind: asked.body.kind, tool: asked.body.tool, amount: asked.body.amount, currency: asked.body.currency, customer: asked.body.customer }, { kind: "paypal", tool: "create_refund", amount: "60.00", currency: "USD", customer: ALICE });
  assert.match(asked.body.summary, /refund 60\.00 USD to alice@example\.com/);
  assert.equal(seen.filter((x) => x.path.startsWith("/v1/approvals/ap_x1?wait=25")).length, 2);
  assert.deepEqual(seen.find((x) => x.path === "/v1/spent").body, { entries: [], purchaseId: "pu_r1", result: "RF9 COMPLETED" });
  const paused = fizzlWalletApproval({ key: "awk_test", url: "https://wallet.test", fetch: async () => Response.json({ status: "paused", summary: "Support agent is paused" }) });
  assert.deepEqual(await paused({ tool: "create_refund", summary: "s", reasons: [] }), { approved: false, by: "fizzl wallet: Support agent is paused" });
});
