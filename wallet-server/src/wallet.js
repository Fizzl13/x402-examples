// The wallet server's logic, shared by every agent of one owner: one policy
// (limits), one budget, approval requests, an activity log. Agents sign and
// pay themselves; this only counts, asks and records. It never holds keys or
// funds.
//
// Checks run one at a time in this process (run a single instance), so two
// agents can never both fit in the last of a budget.
import { randomBytes, createHash } from "node:crypto";
import { normalizeLimits, spendFor, evaluate } from "presign-guard-wallet/limits";
import { PRESIGN_SIGNERS } from "presign-guard-wallet";
import { verifyReceipt, AUTHORITY } from "x402-safe-fetch";
import { formatUnits } from "viem";
import { hostOf } from "./usage.js";
import { cleanRule, ruleOutcome } from "./jev-rule.js";
import { cleanTerms, mandateCheck, signedMandate, publicTerms } from "./mandate.js";

export const DEFAULT_POLICY = { tokens: { USDC: { perTx: "5", perDay: "20" } }, unknownTokens: "ask", window: "24h" };
export const APPROVAL_TTL_MS = 10 * 60_000;
const SCALE = 18;
const fmt = (x) => formatUnits(BigInt(x), SCALE);
export const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
const id = (p) => `${p}_${randomBytes(9).toString("base64url")}`;

// What an agent says it is buying (presign-guard-wallet withPurchase): short, plain text.
function cleanPurchase(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  if (typeof p.url === "string" && /^https?:\/\//.test(p.url)) out.url = p.url.slice(0, 500);
  if (typeof p.description === "string" && p.description.trim()) out.description = p.description.trim().slice(0, 300);
  return Object.keys(out).length ? out : null;
}
const cleanText = (v, n = 300) => (typeof v === "string" && v ? v.slice(0, n) : null);
const CONTENT_LIMIT = 16_000;
function cleanOutcome(o) {
  if (!o || typeof o !== "object") return null;
  const out = {};
  if (Number.isInteger(o.httpStatus) && o.httpStatus >= 100 && o.httpStatus < 600) out.httpStatus = o.httpStatus;
  if (o.settlement && typeof o.settlement === "object") {
    const tx = cleanText(o.settlement.transaction, 100), net = cleanText(o.settlement.network, 60);
    if (tx || net) out.settlement = { ...(tx ? { transaction: tx } : {}), ...(net ? { network: net } : {}) };
  }
  const err = cleanText(o.error);
  if (err) out.error = err;
  // What the agent got back (the paid API's answer), shown on the receipt. Kept to 16,000 characters.
  if (o.content && typeof o.content === "object" && typeof o.content.body === "string" && o.content.body.length) {
    const body = o.content.body.length > CONTENT_LIMIT ? `${o.content.body.slice(0, CONTENT_LIMIT)}\n… (cut)` : o.content.body;
    out.content = { contentType: cleanText(o.content.contentType, 100), body };
  }
  return Object.keys(out).length ? out : null;
}
// The parts of a verified presign-guard verdict a receipt shows.
const verdictView = (v) => (v ? {
  verdict: v.verdict,
  reasons: (v.reasons ?? []).filter((r) => r.severity !== "info").map((r) => r.code),
  receiptId: v.receipt?.request_id ?? null,
  signer: v.receipt?.signer ?? null,
  signedAt: v.receipt?.signed_at ?? null,
} : null);

// plan(): what this account may use; null fields mean unlimited (a self-hosted server, or Pro).
const UNLIMITED = { name: "unlimited", maxAgents: null, receiptDays: 90 };

// track(route, { input, result, usd }): anonymous usage statistics (src/usage.js): the seller's host and
// the amount of a purchase, never who, what for, or to which address.
export function createWallet({ store, now = () => Date.now(), notify = async () => {}, signers = PRESIGN_SIGNERS, authority = AUTHORITY, approvalTtlMs = APPROVAL_TTL_MS, onSettled = () => {}, plan = async () => UNLIMITED, track = () => {}, ruleChecker = null, answerChecker = null, onAlert = async () => {}, mandateIssuer = null } = {}) {
  let queue = Promise.resolve();
  const locked = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const waiters = new Map(); // approval id -> Set of resolve functions (long polls)
  const usdcOf = (charges) => { const u = charges.filter((c) => c.budget === "USDC").reduce((n, c) => n + BigInt(c.amount), 0n); return u ? Number(fmt(u)) : undefined; };
  const bought = (method, purchase) => hostOf(purchase?.url) ?? (method === "signTypedData" ? "x402 (no url)" : "transfer");
  const safeTrack = (...a) => { try { track(...a); } catch {} };

  async function policyNow() {
    const raw = (await store.getPolicy()) ?? DEFAULT_POLICY;
    return { raw, policy: normalizeLimits(raw) };
  }
  async function usedNow(policy) {
    const used = new Map();
    for (const e of await store.listEntries(now() - policy.windowMs + 1)) used.set(e.budget, (used.get(e.budget) ?? 0n) + BigInt(e.amount));
    return used;
  }
  async function log(type, fields) { await store.addEvent({ at: now(), type, ...fields }); }

  // A verdict counts only with presign-guard's valid signature over exactly this request.
  function trustedVerdict(verdict, request) {
    if (!verdict) return null;
    const ok = verifyReceipt(verdict, { signers, route: "POST /v1/check", input: request, authority, service: "presign-guard" });
    return ok.valid ? verdict : null;
  }

  async function book(agent, charges, info) {
    const entries = charges.filter((c) => BigInt(c.amount) > 0n).map((c) => ({ id: id("sp"), at: now(), budget: c.budget, amount: String(c.amount), agent: agent.id, method: info.method, chainId: info.chainId ?? null, to: info.to ?? null }));
    await store.addEntries(entries);
    return entries;
  }

  // A receipt for one signature: what, how much, to whom, the verdict, the approval, and later the result.
  async function openPurchase(agent, { method, chainId, to, entries, verdict, purchase, approval = null, mandate = null }) {
    const p = {
      id: id("pu"), agent: agent.id, agentName: agent.name, method, chainId: chainId ?? null, to: to ?? null,
      amounts: entries.map((e) => `${fmt(e.amount)} ${e.budget}`), entries: entries.map((e) => e.id),
      what: purchase ?? null, verdict: verdict ?? null, approval, status: "signing", result: null, outcome: null,
      createdAt: now(), updatedAt: now(), ...(mandate ? { mandate } : {}),
    };
    await store.putPurchase(p, (await plan()).receiptDays);
    return p;
  }
  async function updatePurchase(agent, purchaseId, change) {
    if (typeof purchaseId !== "string") return null;
    const p = await store.getPurchase(purchaseId);
    if (!p || p.agent !== agent.id) return null;
    const next = { ...p, ...change, updatedAt: now() };
    await store.putPurchase(next, (await plan()).receiptDays);
    return next;
  }

  async function summarize(policy, used) {
    return [...policy.budgets.values()].map((b) => {
      const u = used.get(b.name) ?? 0n;
      return { token: b.name, perTx: b.perTx === null ? null : fmt(b.perTx), perDay: b.perDay === null ? null : fmt(b.perDay), used: fmt(u), left: b.perDay === null ? null : fmt(b.perDay > u ? b.perDay - u : 0n) };
    });
  }

  function expire(a) {
    if (a.status === "pending" && now() > a.expiresAt) return { ...a, status: "expired", decidedAt: a.expiresAt };
    return a;
  }

  function wake(a) {
    for (const resolve of waiters.get(a.id) ?? []) resolve(a);
    waiters.delete(a.id);
  }

  // Count a spend toward the agent's mandate; returns what the receipt keeps (to give it back on release).
  function countMandate(agent, amount) {
    if (!agent.mandate || amount === null || amount === undefined) return null;
    agent.mandate.spent = (BigInt(agent.mandate.spent ?? "0") + BigInt(amount)).toString();
    return { nonce: agent.mandate.nonce, amount: BigInt(amount).toString() };
  }
  function uncountMandate(agent, m) {
    if (!m || !agent?.mandate || agent.mandate.nonce !== m.nonce) return false;
    const left = BigInt(agent.mandate.spent ?? "0") - BigInt(m.amount);
    agent.mandate.spent = (left > 0n ? left : 0n).toString();
    return true;
  }

  const reserveLocked = (agent, { method, request, verdict, purchase: rawPurchase }, ruleHit = null) => locked(async () => {
      // The stored agent, read inside the lock: its mandate total must not be counted from a stale copy.
      const stored = await store.getAgent(agent.id);
      if (stored) Object.assign(agent, stored);
      if (await store.getPaused()) { safeTrack("purchase", { input: { host: bought(method, cleanPurchase(rawPurchase)), method }, result: { outcome: "paused" } }); return { status: "paused", summary: "all agents are paused" }; }
      if (agent.paused) { safeTrack("purchase", { input: { host: bought(method, cleanPurchase(rawPurchase)), method }, result: { outcome: "paused" } }); return { status: "paused", summary: `${agent.name} is paused` }; }
      const { maxAgents } = await plan();
      if (maxAgents) {
        const first = (await store.listAgents()).sort((x, y) => x.createdAt - y.createdAt).slice(0, maxAgents).map((a) => a.id);
        if (!first.includes(agent.id)) return { status: "paused", summary: `${agent.name} is paused: the free plan has ${maxAgents} agent${maxAgents === 1 ? "" : "s"} (upgrade to Pro on the dashboard)` };
      }
      if (!request || typeof request !== "object" || !request.type) throw Object.assign(new Error("request is required"), { status: 400 });
      const { policy } = await policyNow();
      const trusted = trustedVerdict(verdict, request);
      const purchase = cleanPurchase(rawPurchase);
      const spend = spendFor(request, trusted);
      const used = await usedNow(policy);
      const result = evaluate(policy, spend, used);
      for (const hit of [].concat(ruleHit ?? [])) { if (!hit) continue; result.reasons.push(hit.reason); if (hit.hardStop) result.hardStop = true; }
      // The agent's mandate (src/mandate.js): every spend inside its terms, the running total included.
      let mandateAmount = null;
      if (agent.mandate) {
        const m = mandateCheck(agent.mandate, spend.items, { now: now() });
        if (m.reason) { result.reasons.push(m.reason); result.hardStop = true; } else mandateAmount = m.amount;
      }
      const charges = result.charges.map((c) => ({ budget: c.budget, amount: c.amount.toString() }));
      const info = { method, chainId: request.chainId, to: spend.items[0]?.to ?? request.to ?? null };
      agent.lastSeen = now();
      const from = request.type === "signature" ? request.typedData?.message?.from : null;
      if (typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from)) agent.address = from; // its wallet, learned from what it signs
      await store.putAgent(agent);
      if (!result.reasons.length) {
        const entries = await book(agent, charges, info);
        const p = await openPurchase(agent, { method, chainId: request.chainId, to: info.to, entries, verdict: verdictView(trusted), purchase, mandate: countMandate(agent, mandateAmount) });
        await store.putAgent(agent);
        await log("signed", { agent: agent.name, method, amounts: p.amounts, to: info.to, verdict: trusted?.verdict ?? null, purchase: p.id, what: purchase?.description ?? purchase?.url ?? null });
        safeTrack("purchase", { usd: usdcOf(charges), input: { host: bought(method, purchase), method }, result: { outcome: "ok", verdict: trusted?.verdict ?? "none" } });
        return { status: "ok", entries: entries.map((e) => e.id), purchaseId: p.id };
      }
      const summary = result.reasons.map((r) => r.message).join("; ");
      if (result.hardStop) {
        await log("blocked", { agent: agent.name, method, summary, what: purchase?.description ?? purchase?.url ?? null });
        safeTrack("purchase", { usd: usdcOf(charges), input: { host: bought(method, purchase), method }, result: { outcome: "blocked", verdict: trusted?.verdict ?? "none", why: result.reasons.map((r) => r.code).filter(Boolean).join(",") || undefined } });
        return { status: "denied", reasons: result.reasons, summary };
      }
      const approval = {
        id: id("ap"), status: "pending", agent: agent.id, agentName: agent.name, method, chainId: request.chainId ?? null, to: info.to,
        summary, reasons: result.reasons, charges, verdict: verdictView(trusted), purchase,
        createdAt: now(), expiresAt: now() + approvalTtlMs, entries: [], purchaseId: null,
        ...(mandateAmount !== null ? { mandate: { nonce: agent.mandate.nonce, amount: mandateAmount.toString() } } : {}),
      };
      await store.putApproval(approval);
      await log("asked", { agent: agent.name, method, summary, approval: approval.id, what: purchase?.description ?? purchase?.url ?? null });
      safeTrack("purchase", { usd: usdcOf(charges), input: { host: bought(method, purchase), method }, result: { outcome: "asked", verdict: trusted?.verdict ?? "none" } });
      notify(approval, await summarize(policy, used)).catch((err) => console.warn(`[notify] ${err.message}`));
      return { status: "pending", approvalId: approval.id, summary, expiresAt: approval.expiresAt };
    });

  const api = {
    // An agent asks before it signs. Returns { status: "ok", entries } | { status: "pending", approvalId, summary }
    // | { status: "denied", reasons, summary } | { status: "paused" }.
    // The owner's plain-words rule (src/jev-rule.js) is checked before the lock, so the AI call never holds up other agents.
    reserve: async (agent, args = {}) => {
      const raw = await store.getPolicy();
      const rule = raw?.rule ? cleanRule(raw.rule) : null;
      const ruleResult = rule && ruleChecker?.enabled ? await ruleChecker.check(rule.text, cleanPurchase(args.purchase)) : null;
      // The mandate's purpose, judged the same way: outside it or unsure, the owner is asked (never stopped on a guess).
      const purpose = agent.mandate ? { text: agent.mandate.purpose, mode: "ask" } : null;
      const purposeResult = purpose && ruleChecker?.enabled ? await ruleChecker.check(purpose.text, cleanPurchase(args.purchase)) : null;
      const purposeHit = ruleOutcome(purpose, purposeResult);
      if (purposeHit) purposeHit.reason = { ...purposeHit.reason, message: `mandate purpose ("${purpose.text}"): ${purposeHit.reason.message}` };
      return reserveLocked(agent, args, [ruleOutcome(rule, ruleResult), purposeHit]);
    },

    // The owner decides (dashboard or Telegram). Approved spending is booked now.
    decide: (approvalId, decision, by = "dashboard") => locked(async () => {
      const found = await store.getApproval(approvalId);
      if (!found) throw Object.assign(new Error("no such approval"), { status: 404 });
      const a = expire(found);
      if (a.status !== "pending") { if (a !== found) await store.putApproval(a); return a; }
      let approved = decision === "approve";
      let entries = [], purchaseId = null;
      // Two approvals waiting under one mandate can't both be approved past its total.
      if (approved && a.mandate) {
        const ag = await store.getAgent(a.agent);
        if (ag?.mandate?.nonce === a.mandate.nonce && BigInt(ag.mandate.spent ?? "0") + BigInt(a.mandate.amount) > BigInt(ag.mandate.cap)) {
          approved = false;
          a.summary = `${a.summary}; not approved: it would go over the agent's mandate total`;
        }
      }
      if (approved) {
        const agent = (await store.getAgent(a.agent)) ?? { id: a.agent, name: a.agentName };
        const booked = await book(agent, a.charges, a);
        entries = booked.map((e) => e.id);
        const counted = a.mandate && agent.mandate?.nonce === a.mandate.nonce ? countMandate(agent, a.mandate.amount) : null;
        if (counted) await store.putAgent(agent);
        const p = await openPurchase(agent, { method: a.method, chainId: a.chainId, to: a.to, entries: booked, verdict: a.verdict, purchase: a.purchase ?? null, approval: { id: a.id, summary: a.summary, by, at: now() }, mandate: counted });
        purchaseId = p.id;
      }
      const next = { ...a, status: approved ? "approved" : "denied", decidedAt: now(), decidedBy: by, entries, purchaseId };
      await store.putApproval(next);
      await log(approved ? "approved" : "denied", { agent: a.agentName, method: a.method, summary: a.summary, by, ...(purchaseId ? { purchase: purchaseId } : {}), what: a.purchase?.description ?? a.purchase?.url ?? null });
      safeTrack("approval", { usd: usdcOf(a.charges ?? []), input: { host: bought(a.method, a.purchase) }, result: { decision: approved ? "approved" : "denied", via: by === "dashboard" ? "dashboard" : "telegram", seconds: Math.round((now() - a.createdAt) / 1000) } });
      wake(next);
      Promise.resolve(onSettled(next)).catch(() => {});
      return next;
    }),

    // An agent waits for the owner's decision (long poll, up to waitMs).
    async waitForApproval(agent, approvalId, waitMs = 25_000) {
      const read = async () => {
        const found = await store.getApproval(approvalId);
        if (!found || found.agent !== agent.id) throw Object.assign(new Error("no such approval"), { status: 404 });
        const a = expire(found);
        if (a !== found) { await store.putApproval(a); await log("expired", { agent: a.agentName, method: a.method, summary: a.summary }); safeTrack("approval", { usd: usdcOf(a.charges ?? []), input: { host: bought(a.method, a.purchase) }, result: { decision: "expired" } }); Promise.resolve(onSettled(a)).catch(() => {}); }
        return a;
      };
      let a = await read();
      if (a.status === "pending" && waitMs > 0) {
        const remaining = Math.min(waitMs, Math.max(0, a.expiresAt - now()) + 50);
        a = await new Promise((resolve) => {
          const set = waiters.get(approvalId) ?? new Set();
          const done = (v) => { clearTimeout(t); set.delete(done); resolve(v); };
          const t = setTimeout(() => { set.delete(done); read().then(resolve, () => resolve(a)); }, remaining);
          set.add(done);
          waiters.set(approvalId, set);
        });
      }
      return { status: a.status, entries: a.status === "approved" ? a.entries : [], purchaseId: a.status === "approved" ? a.purchaseId ?? null : null, summary: a.summary, expiresAt: a.expiresAt };
    },

    // Signing failed: give the spending back. Only an agent's own entries.
    release: (agent, ids, { purchaseId, error } = {}) => locked(async () => {
      const mine = (await store.listEntries(0)).filter((e) => ids.includes(e.id) && e.agent === agent.id).map((e) => e.id);
      await store.removeEntries(mine);
      const p = await updatePurchase(agent, purchaseId, { status: "failed", outcome: { error: cleanText(error) ?? "signing failed" } });
      if (p?.mandate && mine.length) { const fresh = await store.getAgent(agent.id); if (uncountMandate(fresh, p.mandate)) await store.putAgent(fresh); }
      if (mine.length) await log("released", { agent: agent.name, count: mine.length, ...(p ? { purchase: p.id } : {}) });
      return { released: mine.length };
    }),

    async spent(agent, ids, result, { purchaseId } = {}) {
      const mine = (await store.listEntries(0)).filter((e) => ids.includes(e.id) && e.agent === agent.id);
      const res = typeof result === "string" ? result.slice(0, 200) : null;
      const p = await updatePurchase(agent, purchaseId, { status: "signed", result: res });
      if (mine.length) await log("spent", { agent: agent.name, amounts: mine.map((e) => `${fmt(e.amount)} ${e.budget}`), result: res ? res.slice(0, 80) : null, ...(p ? { purchase: p.id, what: p.what?.description ?? p.what?.url ?? null } : {}) });
      return { ok: true };
    },

    // What happened after signing (the API's answer, the x402 settlement, an error), on the agent's own receipts.
    async annotate(agent, ids, outcome) {
      const o = cleanOutcome(outcome);
      if (!o || !Array.isArray(ids)) return { updated: 0 };
      let updated = 0;
      for (const pid of ids.slice(0, 20)) {
        const p = await store.getPurchase(String(pid));
        if (!p || p.agent !== agent.id) continue;
        await updatePurchase(agent, p.id, { outcome: { ...(p.outcome ?? {}), ...o } });
        updated++;
      }
      // What came back, checked once per report (src/jev-answer.js): on the receipt, and returned so the
      // agent's wallet can warn the agent before it reads an answer with instructions aimed at it.
      if (!updated || !answerChecker?.enabled || (!o.content && !o.httpStatus)) return { updated };
      const first = await store.getPurchase(String(ids[0]));
      const check = await answerChecker.check({ url: first?.what?.url ?? null, description: first?.what?.description ?? null, httpStatus: o.httpStatus ?? null, contentType: o.content?.contentType ?? null, body: o.content?.body ?? "" }).catch(() => null);
      if (!check) return { updated };
      for (const pid of ids.slice(0, 20)) {
        const p = await store.getPurchase(String(pid));
        if (p && p.agent === agent.id) await updatePurchase(agent, p.id, { outcome: { ...(p.outcome ?? {}), check } });
      }
      const host = hostOf(first?.what?.url) ?? null;
      safeTrack("answer_check", { input: { host }, result: { delivered: check.delivered?.verdict ?? null, injection: check.injection?.flagged ?? null, decidedBy: [check.delivered?.decidedBy, check.injection?.decidedBy].filter(Boolean).join(",") || null } });
      const amount = first?.amounts?.join(" + ") || "a payment";
      if (check.injection?.flagged) onAlert({ kind: "injection", agentName: agent.name, purchaseId: first?.id, host, text: `⚠️ The answer ${agent.name} got from ${host ?? "a paid API"} contains instructions aimed at your agent (${check.injection.why}). Your agent was told to treat it as data only. Check the receipt.` }).catch(() => {});
      else if (check.delivered?.verdict === "no") onAlert({ kind: "not_delivered", agentName: agent.name, purchaseId: first?.id, host, text: `${agent.name} paid ${amount} to ${host ?? "a paid API"} but didn't get what it paid for (${check.delivered.why}). See the receipt.` }).catch(() => {});
      return { updated, check };
    },

    async purchase(purchaseId) {
      const p = typeof purchaseId === "string" ? await store.getPurchase(purchaseId) : null;
      if (!p) throw Object.assign(new Error("no such receipt (receipts are kept 90 days)"), { status: 404 });
      return p;
    },

    // What the agents bought: the newest receipts, for the Purchases screen. Receipts made before the list
    // existed are found through the activity log.
    async purchases({ agent = null, limit = 100 } = {}) {
      const n = Math.min(200, Math.max(1, Number(limit) || 100));
      const list = await store.listPurchases(n);
      const seen = new Set(list.map((p) => p.id));
      for (const e of await store.listEvents(500)) {
        if (!e.purchase || seen.has(e.purchase)) continue;
        seen.add(e.purchase);
        const p = await store.getPurchase(e.purchase);
        if (p) list.push(p);
      }
      return list.filter((p) => !agent || p.agent === agent).sort((x, y) => y.createdAt - x.createdAt).slice(0, n)
        .map(({ id, agent, agentName, method, chainId, to, amounts, what, verdict, approval, status, outcome, createdAt }) => ({ id, agent, agentName, method, chainId, to, amounts, what, verdict: verdict?.verdict ?? null, approvedBy: approval?.by ?? null, status, error: outcome?.error ?? null, httpStatus: outcome?.httpStatus ?? null, createdAt }));
    },

    async spending() { const { policy } = await policyNow(); return summarize(policy, await usedNow(policy)); },

    async getPolicy() { return (await policyNow()).raw; },
    async setPolicy(raw, by = "dashboard") {
      normalizeLimits(raw); // throws a TypeError with a clear message when invalid
      if (raw && "rule" in raw) { const rule = cleanRule(raw.rule); if (rule) raw.rule = rule; else delete raw.rule; }
      await store.setPolicy(raw);
      await log("policy", { by, policy: raw });
      return raw;
    },

    async setPaused(v, by = "dashboard") { await store.setPaused(v); await log(v ? "paused" : "resumed", { by }); },

    async addAgent(name, site = null) {
      if (typeof name !== "string" || !/^[\w .-]{1,40}$/.test(name)) throw Object.assign(new Error("name: 1-40 letters, digits, spaces, . _ -"), { status: 400 });
      const { maxAgents } = await plan();
      const count = (await store.listAgents()).length;
      if (maxAgents && count >= maxAgents) throw Object.assign(new Error(`The free plan has ${maxAgents} agent${maxAgents === 1 ? "" : "s"}. Upgrade to Pro for more.`), { status: 403 });
      if (count >= 50) throw Object.assign(new Error("50 agents is the most one account can have."), { status: 403 });
      const key = `awk_${randomBytes(24).toString("base64url")}`;
      const agent = { id: id("ag"), name, keyHash: hashKey(key), createdAt: now(), paused: false, lastSeen: null, site: cleanSite(site, { lenient: true }) };
      await store.putAgent(agent);
      await store.indexKey(agent.keyHash, agent.id);
      await log("agent_added", { agent: name });
      safeTrack("agent_added", { result: { agents: count + 1 } });
      return { agent: publicAgent(agent), key };
    },
    async setAgentPaused(agentId, v) {
      const a = await store.getAgent(agentId);
      if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
      a.paused = !!v; await store.putAgent(a);
      await log(v ? "agent_paused" : "agent_resumed", { agent: a.name });
      return publicAgent(a);
    },
    async removeAgent(agentId) {
      const a = await store.getAgent(agentId);
      if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
      await store.deleteAgent(agentId);
      await log("agent_removed", { agent: a.name });
      safeTrack("agent_removed", {});
    },
    // Any call from an agent counts as contact (written at most once a minute).
    async seen(agent) {
      if (agent.lastSeen && now() - agent.lastSeen < 60_000) return;
      await locked(async () => { const a = await store.getAgent(agent.id); if (a) { a.lastSeen = now(); await store.putAgent(a); } });
    },
    // The agent's own wallet address (public), so the setup check can look at its balance. Null clears it.
    async setAgentAddress(agentId, address) {
      if (address !== null && !(typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address))) throw Object.assign(new Error("address must be an 0x… address"), { status: 400 });
      return locked(async () => {
        const a = await store.getAgent(agentId);
        if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
        a.address = address; await store.putAgent(a);
        return publicAgent(a);
      });
    },
    // The owner sets (terms) or ends (null) an agent's mandate. New terms start a new mandate (new nonce, spent 0).
    async setAgentMandate(agentId, terms) {
      if (terms !== null && !mandateIssuer) throw Object.assign(new Error("Mandates aren't set up on this server (MANDATE_SECRET)."), { status: 503 });
      const clean = terms === null ? null : cleanTerms(terms, { now: now() });
      return locked(async () => {
        const a = await store.getAgent(agentId);
        if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
        a.mandate = clean;
        await store.putAgent(a);
        await log(clean ? "mandate_set" : "mandate_ended", { agent: a.name, ...(clean ? { cap: publicTerms(clean).cap, purpose: clean.purpose } : {}) });
        safeTrack(clean ? "mandate_set" : "mandate_ended", {});
        return publicAgent(a);
      });
    },
    // For the agent (GET /v1/mandate): its signed mandate, for the wallet that pays (its own address).
    async mandateFor(agent, address) {
      const a = (await store.getAgent(agent.id)) ?? agent;
      if (!a.mandate || !mandateIssuer) return null;
      const subject = typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : a.address;
      if (!subject) throw Object.assign(new Error("address: the agent's wallet address (0x…) is needed for its mandate"), { status: 400 });
      if (a.address && a.address.toLowerCase() !== subject.toLowerCase()) throw Object.assign(new Error("that is not this agent's wallet"), { status: 403 });
      return { ...signedMandate(a.mandate, mandateIssuer, subject), terms: publicTerms(a.mandate) };
    },
    // Where the agent lives (its site or app page), shown as a link on its card. Null clears it.
    async setAgentSite(agentId, site) {
      const clean = cleanSite(site);
      return locked(async () => {
        const a = await store.getAgent(agentId);
        if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
        a.site = clean; await store.putAgent(a);
        return publicAgent(a);
      });
    },
    async agents() { return (await store.listAgents()).map(publicAgent).sort((x, y) => x.createdAt - y.createdAt); },
    async agentForKey(key) { return typeof key === "string" && key.startsWith("awk_") ? store.agentByKeyHash(hashKey(key)) : null; },

    // Everything the dashboard shows.
    async state() {
      const { raw, policy } = await policyNow();
      const used = await usedNow(policy);
      const entries = await store.listEntries(now() - policy.windowMs + 1);
      const agents = (await store.listAgents()).map((a) => {
        const mine = entries.filter((e) => e.agent === a.id);
        const per = {};
        for (const e of mine) per[e.budget] = (per[e.budget] ?? 0n) + BigInt(e.amount);
        return { ...publicAgent(a), spent: Object.fromEntries(Object.entries(per).map(([b, v]) => [b, fmt(v)])) };
      }).sort((x, y) => x.createdAt - y.createdAt);
      const all = (await store.listApprovals()).map(expire);
      // Decided requests are shown for a day and deleted after 7 (see the privacy statement).
      for (const a of all) if (a.status !== "pending" && now() - (a.decidedAt ?? a.createdAt) > 7 * 86_400_000) await store.deleteApproval(a.id);
      const approvals = all.filter((a) => a.status === "pending" || now() - (a.decidedAt ?? a.createdAt) < 86_400_000).sort((x, y) => y.createdAt - x.createdAt).slice(0, 50);
      return { policy: raw, ruleCheck: Boolean(ruleChecker?.enabled), mandates: Boolean(mandateIssuer), paused: await store.getPaused(), spending: await summarize(policy, used), agents, approvals, events: await store.listEvents(100), now: now() };
    },
  };
  return api;
}

const publicAgent = ({ keyHash, mandate, ...a }) => ({ ...a, mandate: publicTerms(mandate) });
// An agent's site: an https address (at most 200 characters, no user:password), or null.
// lenient: a bad value is dropped instead of refused (a guess made while adding an agent).
function cleanSite(site, { lenient = false } = {}) {
  if (site === null || site === undefined || site === "") return null;
  let u = null;
  try { u = new URL(String(site).trim()); } catch {}
  if (!u || u.protocol !== "https:" || u.href.length > 200 || u.username || u.password) {
    if (lenient) return null;
    throw Object.assign(new Error("site must be an https:// address"), { status: 400 });
  }
  return u.href;
}
