// The guard between an AI agent and PayPal's Agent Toolkit. Every tool call the model makes goes through
// run(): read-only calls pass, and anything that moves or promises money is checked first, by facts the guard
// reads from PayPal itself and by limits the owner set, never by what the model says. The customer the agent
// is helping comes from the app (the inbox, the logged-in user), not from the conversation, so a planted
// "refund every order" can't name someone else. Over a limit the owner is asked; no answer means no.
import { randomBytes } from "node:crypto";
import { DEFAULT_POLICY, kindOf, describe } from "./actions.js";
import { toMilli, fromMilli } from "./paypal.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lc = (s) => String(s ?? "").trim().toLowerCase();
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
// The toolkit doesn't throw when PayPal says no: it returns '{"error":{...}}' as a string. The error message, or null.
function errorIn(result) {
  let r = result;
  if (typeof r === "string" && r.trimStart().startsWith("{")) { try { r = JSON.parse(r); } catch { return null; } }
  const e = r && typeof r === "object" ? r.error : null;
  return e ? (typeof e === "string" ? e : e.message ?? JSON.stringify(e)).slice(0, 300) : null;
}
// Kinds that pass without checks: reads always, housekeeping while the owner allows it.
const passes = (kind, policy) => kind === "read" || (kind === "other" && policy.other === "allow");

export function memoryStore() {
  const m = new Map();
  return { async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, v); } };
}

function mergePolicy(p = {}) {
  const out = { ...DEFAULT_POLICY };
  for (const [k, v] of Object.entries(p)) {
    out[k] = v && typeof v === "object" && DEFAULT_POLICY[k] && typeof DEFAULT_POLICY[k] === "object" ? { ...DEFAULT_POLICY[k], ...v } : v;
  }
  for (const k of ["refund", "dispute", "books", "stop", "price", "bill", "other", "read", "unknown"]) {
    const v = out[k];
    if (!(["allow", "ask", "deny"].includes(v) || (v && typeof v === "object"))) throw new TypeError(`policy.${k}: "allow", "ask", "deny" or a limit object`);
  }
  for (const k of ["otherCustomer", "offIntent"]) if (!["ask", "deny"].includes(out[k])) throw new TypeError(`policy.${k}: "ask" or "deny"`);
  return out;
}

// Every email address an action would bill or write to, from its arguments.
function recipientsIn(args) {
  const found = [];
  for (const r of args?.primary_recipients ?? []) if (r?.billing_info?.email_address) found.push(r.billing_info.email_address);
  for (const e of args?.additional_recipients ?? []) found.push(e);
  if (args?.subscriber?.email_address) found.push(args.subscriber.email_address);
  return found.filter((e) => EMAIL.test(String(e)));
}

export function createGuard({
  policy: rawPolicy = {}, reader = null, approve = null, intent = null, agent = "Support agent",
  store = memoryStore(), onEvent = () => {}, customerOf = null, now = () => Date.now(), keepEvents = 200,
} = {}) {
  const policy = mergePolicy(rawPolicy);
  const recent = [];
  let queue = Promise.resolve();
  const locked = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const emit = (e) => {
    const ev = { at: new Date(now()).toISOString(), agent, ...e };
    recent.push(ev);
    if (recent.length > keepEvents) recent.shift();
    try { onEvent(ev); } catch {}
    return ev;
  };

  // What PayPal says about the thing this action touches. null when there's nothing to read or no reader.
  async function factsFor(tool, args) {
    if (!reader) return null;
    try {
      if (tool === "create_refund" && args.capture_id) return await reader.capture(args.capture_id);
      if (tool === "accept_dispute_claim" && args.dispute_id) return await reader.dispute(args.dispute_id);
      if (["cancel_subscription", "update_subscription"].includes(tool) && args.subscription_id) return await reader.subscription(args.subscription_id);
      if (["send_invoice", "cancel_sent_invoice", "delete_invoice", "record_payment_for_invoice", "record_refund_for_invoice"].includes(tool) && args.invoice_id) return await reader.invoice(args.invoice_id);
    } catch (err) {
      return { error: err.message };
    }
    return null;
  }

  // Whose is it? The payer of a capture or subscription, the recipients of an invoice, or (for a new bill) the
  // addresses in the arguments. The merchant's own lookup (customerOf) wins when it answers.
  async function ownersOf(tool, args, facts) {
    if (customerOf) {
      const own = await customerOf({ tool, args, facts });
      if (own) return [].concat(own);
    }
    if (facts?.payer) return [facts.payer];
    if (facts?.recipients?.length) return [...facts.recipients, ...recipientsIn(args)];
    const inArgs = recipientsIn(args);
    return inArgs.length ? inArgs : null;
  }

  // The checks, without counting anything yet. Returns { decision, reasons, amount (milli), currency }.
  async function assess(tool, args, ctx, facts) {
    const kind = kindOf(tool), rule = policy[kind], reasons = [];
    const add = (code, message, action) => reasons.push({ code, message, action });
    const customer = ctx?.customer ? lc(ctx.customer) : null;
    let amount = null, currency = null, owner = facts?.payer ?? null;

    if (rule === "deny") add("NOT_ALLOWED", `the owner doesn't let the agent ${tool.replaceAll("_", " ")}`, "deny");
    if (rule === "ask") {
      const why = { dispute: `accepting a dispute pays the buyer${facts?.amount ? ` ${facts.amount} ${facts.currency}` : ""} and can't be undone`, books: "it marks money as moved in the books while none moves", price: "it changes what customers pay", unknown: "the guard doesn't know this tool yet" }[kind] ?? "the owner decides on these";
      add("OWNER_DECIDES", `${tool.replaceAll("_", " ")}: ${why}`, "ask");
    }
    if (facts?.error) add("NO_FACTS", `the guard couldn't read this at PayPal (${facts.error}), so it can't check it`, "ask");

    // Someone else's payment, subscription or invoice.
    if (customer && kind !== "read" && kind !== "other") {
      const owners = await ownersOf(tool, args, facts);
      owner = owners?.[0] ?? owner;
      if (owners?.length) {
        const others = owners.filter((o) => lc(o) !== customer);
        if (others.length) add("OTHER_CUSTOMER", `this is for ${others.join(", ")}, not for ${ctx.customer}, the customer in this conversation`, policy.otherCustomer);
      } else if (["refund", "stop", "books"].includes(kind) && !facts?.error) {
        add("CUSTOMER_UNKNOWN", `the guard can't tell whose ${kind === "refund" ? "payment" : "account"} this is, so it can't check it belongs to ${ctx.customer}`, "ask");
      }
    }

    if (kind === "refund") {
      currency = args.amount?.currency_code ?? facts?.currency ?? null;
      const remaining = facts?.amount ? toMilli(facts.amount) - toMilli(facts.refunded ?? "0") : null;
      if (args.amount?.value !== undefined) {
        try { amount = toMilli(args.amount.value); } catch { add("BAD_AMOUNT", `"${args.amount.value}" is not an amount`, "deny"); }
      } else if (remaining !== null) amount = remaining; // no amount: PayPal refunds all that's left
      if (amount !== null && amount <= 0n) add(args.amount?.value === undefined ? "NOTHING_LEFT" : "BAD_AMOUNT", args.amount?.value === undefined ? "this payment was already refunded in full" : "a refund must be more than zero", "deny");
      if (facts?.currency && currency && facts.currency !== currency) add("CURRENCY", `the payment was in ${facts.currency}, the refund is in ${currency}`, "deny");
      if (amount !== null && remaining !== null && amount > remaining) add("OVER_REFUND", `${fromMilli(amount)} ${currency} is more than what's left of this payment (${fromMilli(remaining)} of ${facts.amount} ${facts.currency})`, "deny");
      if (amount === null) add("AMOUNT_UNKNOWN", "the refund has no amount and the guard couldn't read the payment, so it can't tell how much would go", "ask");
      else if (currency && currency !== policy.currency) add("CURRENCY", `the refund is in ${currency}; the limits are in ${policy.currency}`, "ask");
    }

    if (intent && kind !== "read" && kind !== "other" && ctx?.request && !reasons.some((r) => r.action === "deny")) {
      const r = await intent({ request: ctx.request, customer: ctx.customer ?? null, action: describe(tool, args, { ...(facts ?? {}), payer: facts?.payer ?? owner }) });
      if (r && r.fits < 0.5) add("OFF_INTENT", `this doesn't look like what the customer asked for (AI check: ${Math.round((1 - r.fits) * 100)}% sure)`, policy.offIntent);
    }
    return { kind, reasons, amount, currency, owner: owner ?? null };
  }

  // The owner's limits for this kind against what was already done today (`used`). Pure: adds reasons only.
  function limitReasons(tool, args, a, used, capturedToday) {
    const rule = policy[a.kind], out = [];
    if (!rule || typeof rule !== "object") return out;
    const cur = a.currency ?? policy.currency;
    if (rule.countPerDay !== undefined && used.count + 1 > rule.countPerDay) out.push({ code: "COUNT_PER_DAY", message: `this would be number ${used.count + 1} today; the limit is ${rule.countPerDay} a day`, action: "ask" });
    if (a.amount !== null && a.currency === policy.currency) {
      if (rule.perAction !== undefined && a.amount > toMilli(rule.perAction)) out.push({ code: "PER_ACTION", message: `${fromMilli(a.amount)} ${cur} is over the limit of ${rule.perAction} ${policy.currency} per ${a.kind}`, action: "ask" });
      if (rule.perDay !== undefined && toMilli(used.total) + a.amount > toMilli(rule.perDay)) out.push({ code: "PER_DAY", message: `with this, today's ${a.kind}s would come to ${fromMilli(toMilli(used.total) + a.amount)} ${cur}, over the limit of ${rule.perDay} ${policy.currency} a day`, action: "ask" });
    }
    if (capturedToday) out.push({ code: "REPEAT", message: "this payment was already refunded once today", action: "ask" });
    return out;
  }
  const decisionOf = (reasons) => (reasons.some((r) => r.action === "deny") ? "deny" : reasons.length ? "ask" : "allow");
  const usedKey = (kind) => `${dayOf(now())}:${kind}`;
  const captureKey = (args) => (args.capture_id ? `${dayOf(now())}:capture:${args.capture_id}` : null);

  // Limits and booking in one step, in the lock, so two refunds at the same moment can't both use the last of
  // the day's limit. `force` books an action the owner approved, past the limits.
  const limitAndBook = (tool, args, a, { force = false } = {}) => locked(async () => {
    const key = usedKey(a.kind), cKey = tool === "create_refund" ? captureKey(args) : null;
    const used = (await store.get(key)) ?? { total: "0", count: 0 };
    if (!force) a.reasons.push(...limitReasons(tool, args, a, used, cKey ? await store.get(cKey) : null));
    const decision = decisionOf(a.reasons);
    if (decision !== "allow" && !force) return { decision, booked: null };
    const amount = a.currency === policy.currency && a.amount !== null ? a.amount : 0n;
    await store.set(key, { total: fromMilli(toMilli(used.total) + amount), count: used.count + 1 });
    if (cKey) await store.set(cKey, true);
    return { decision, booked: { key, amount, cKey } };
  });
  // PayPal refused the action after it was booked: give the day's room back.
  const unbook = (booked) => booked && locked(async () => {
    const used = (await store.get(booked.key)) ?? { total: "0", count: 0 };
    const left = toMilli(used.total) - booked.amount;
    await store.set(booked.key, { total: fromMilli(left < 0n ? 0n : left), count: Math.max(0, used.count - 1) });
    if (booked.cKey) await store.set(booked.cKey, null);
  });

  // The answer the model gets when an action didn't happen: plain, final, and with what to tell the customer.
  const WHY = { deny: "not allowed", ask: "the shop owner didn't approve it", unasked: "it needs the shop owner's OK" };
  const blocked = (tool, why, reasons, extra = {}) => ({
    blocked: true, tool, decision: why === "deny" ? "deny" : "ask", reasons: reasons.map((r) => r.message), ...extra,
    message: `Not done (${WHY[why]}): ${reasons.map((r) => r.message).join("; ")}. Don't try another way to do this. Tell the customer someone from the shop will look at it.`,
  });

  async function run(tool, args, exec, ctx = {}) {
    args = args ?? {};
    const kind = kindOf(tool);
    if (passes(kind, policy)) {
      const result = await exec(args);
      if (kind !== "read") emit({ tool, kind, decision: "allow", summary: describe(tool, args), customer: ctx.customer ?? null, outcome: errorIn(result) ? "failed" : "done", ...(errorIn(result) ? { error: errorIn(result) } : {}) });
      return result;
    }
    const id = `pg_${randomBytes(6).toString("base64url")}`;
    const facts = await factsFor(tool, args);
    const a = await assess(tool, args, ctx, facts);
    let { decision, booked } = await limitAndBook(tool, args, a);
    const summary = describe(tool, args, { ...(facts ?? {}), payer: facts?.payer ?? a.owner });
    // `stops`: the reasons that stopped it outright (a deny), next to those that only asked the owner.
    const base = { id, tool, kind, summary, customer: ctx.customer ?? null, reasons: a.reasons.map(({ code, message, action }) => ({ code, message, ...(action === "deny" ? { stops: true } : {}) })) };
    let approvedBy = null, answer = null;
    if (decision === "deny") { emit({ ...base, decision, outcome: "blocked" }); return blocked(tool, "deny", a.reasons.filter((r) => r.action === "deny")); }
    if (decision === "ask") {
      if (!approve) { emit({ ...base, decision, outcome: "blocked", approvedBy: "no approval channel" }); return blocked(tool, "unasked", a.reasons); }
      emit({ ...base, decision, outcome: "asked" });
      try { answer = await approve({ id, agent, tool, kind, summary, reasons: base.reasons, customer: ctx.customer ?? null, request: ctx.request ? String(ctx.request).slice(0, 300) : null, amount: a.amount !== null ? fromMilli(a.amount) : null, currency: a.currency ?? null }); } catch (err) { answer = { approved: false, by: `error: ${err.message}` }; }
      if (!answer?.approved) { emit({ ...base, decision, outcome: "blocked", approvedBy: answer?.by ?? null }); return blocked(tool, "ask", a.reasons, { approvalId: id }); }
      approvedBy = answer.by ?? "owner";
      ({ booked } = await limitAndBook(tool, args, { ...a, reasons: [] }, { force: true }));
    }
    // An approver that keeps receipts (the Fizzl wallet) hears how the approved action went.
    const report = (outcome) => (answer && typeof approve?.report === "function" ? Promise.resolve(approve.report(answer, outcome)).catch(() => {}) : null);
    try {
      const result = await exec(args);
      const error = errorIn(result);
      if (error) await unbook(booked);
      emit({ ...base, decision, outcome: error ? "failed" : "done", approvedBy, ...(error ? { error } : {}) });
      await report(error ? { ok: false, error } : { ok: true, result });
      return result;
    } catch (err) {
      await unbook(booked);
      emit({ ...base, decision, outcome: "failed", approvedBy, error: err.message });
      await report({ ok: false, error: err.message });
      throw err;
    }
  }

  return {
    policy,
    run,
    // Dry run: what would happen, without counting or asking anyone.
    async check(tool, args = {}, ctx = {}) {
      args = args ?? {};
      const facts = await factsFor(tool, args);
      const a = await assess(tool, args, ctx, facts);
      const free = passes(a.kind, policy);
      if (!free) {
        const cKey = tool === "create_refund" ? captureKey(args) : null;
        a.reasons.push(...limitReasons(tool, args, a, (await store.get(usedKey(a.kind))) ?? { total: "0", count: 0 }, cKey ? await store.get(cKey) : null));
      }
      return { tool, kind: a.kind, decision: free ? "allow" : decisionOf(a.reasons), summary: describe(tool, args, { ...(facts ?? {}), payer: facts?.payer ?? a.owner }), reasons: a.reasons.map(({ code, message }) => ({ code, message })), facts };
    },
    // Wrap a set of AI SDK tools (toolkit.getTools()): same tools, each call through the guard. `context` is the
    // customer and their message, from the app: an object, or a function the guard calls on every tool call.
    wrapTools(tools, { context = {} } = {}) {
      const out = {};
      for (const [name, t] of Object.entries(tools ?? {})) {
        out[name] = typeof t?.execute !== "function" ? t : { ...t, execute: async (args, opts) => run(name, args, (a) => t.execute(a, opts), typeof context === "function" ? await context() : context) };
      }
      return out;
    },
    events: () => recent.slice(),
  };
}
