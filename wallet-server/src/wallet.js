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

export function createWallet({ store, now = () => Date.now(), notify = async () => {}, signers = PRESIGN_SIGNERS, authority = AUTHORITY, approvalTtlMs = APPROVAL_TTL_MS, onSettled = () => {} } = {}) {
  let queue = Promise.resolve();
  const locked = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const waiters = new Map(); // approval id -> Set of resolve functions (long polls)

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
  async function openPurchase(agent, { method, chainId, to, entries, verdict, purchase, approval = null }) {
    const p = {
      id: id("pu"), agent: agent.id, agentName: agent.name, method, chainId: chainId ?? null, to: to ?? null,
      amounts: entries.map((e) => `${fmt(e.amount)} ${e.budget}`), entries: entries.map((e) => e.id),
      what: purchase ?? null, verdict: verdict ?? null, approval, status: "signing", result: null, outcome: null,
      createdAt: now(), updatedAt: now(),
    };
    await store.putPurchase(p);
    return p;
  }
  async function updatePurchase(agent, purchaseId, change) {
    if (typeof purchaseId !== "string") return null;
    const p = await store.getPurchase(purchaseId);
    if (!p || p.agent !== agent.id) return null;
    const next = { ...p, ...change, updatedAt: now() };
    await store.putPurchase(next);
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

  const api = {
    // An agent asks before it signs. Returns { status: "ok", entries } | { status: "pending", approvalId, summary }
    // | { status: "denied", reasons, summary } | { status: "paused" }.
    reserve: (agent, { method, request, verdict, purchase: rawPurchase }) => locked(async () => {
      if (await store.getPaused()) return { status: "paused", summary: "all agents are paused" };
      if (agent.paused) return { status: "paused", summary: `${agent.name} is paused` };
      if (!request || typeof request !== "object" || !request.type) throw Object.assign(new Error("request is required"), { status: 400 });
      const { policy } = await policyNow();
      const trusted = trustedVerdict(verdict, request);
      const purchase = cleanPurchase(rawPurchase);
      const spend = spendFor(request, trusted);
      const used = await usedNow(policy);
      const result = evaluate(policy, spend, used);
      const charges = result.charges.map((c) => ({ budget: c.budget, amount: c.amount.toString() }));
      const info = { method, chainId: request.chainId, to: spend.items[0]?.to ?? request.to ?? null };
      agent.lastSeen = now();
      await store.putAgent(agent);
      if (!result.reasons.length) {
        const entries = await book(agent, charges, info);
        const p = await openPurchase(agent, { method, chainId: request.chainId, to: info.to, entries, verdict: verdictView(trusted), purchase });
        await log("signed", { agent: agent.name, method, amounts: p.amounts, to: info.to, verdict: trusted?.verdict ?? null, purchase: p.id, what: purchase?.description ?? purchase?.url ?? null });
        return { status: "ok", entries: entries.map((e) => e.id), purchaseId: p.id };
      }
      const summary = result.reasons.map((r) => r.message).join("; ");
      if (result.hardStop) {
        await log("blocked", { agent: agent.name, method, summary, what: purchase?.description ?? purchase?.url ?? null });
        return { status: "denied", reasons: result.reasons, summary };
      }
      const approval = {
        id: id("ap"), status: "pending", agent: agent.id, agentName: agent.name, method, chainId: request.chainId ?? null, to: info.to,
        summary, reasons: result.reasons, charges, verdict: verdictView(trusted), purchase,
        createdAt: now(), expiresAt: now() + approvalTtlMs, entries: [], purchaseId: null,
      };
      await store.putApproval(approval);
      await log("asked", { agent: agent.name, method, summary, approval: approval.id, what: purchase?.description ?? purchase?.url ?? null });
      notify(approval, await summarize(policy, used)).catch((err) => console.warn(`[notify] ${err.message}`));
      return { status: "pending", approvalId: approval.id, summary, expiresAt: approval.expiresAt };
    }),

    // The owner decides (dashboard or Telegram). Approved spending is booked now.
    decide: (approvalId, decision, by = "dashboard") => locked(async () => {
      const found = await store.getApproval(approvalId);
      if (!found) throw Object.assign(new Error("no such approval"), { status: 404 });
      const a = expire(found);
      if (a.status !== "pending") { if (a !== found) await store.putApproval(a); return a; }
      const approved = decision === "approve";
      let entries = [], purchaseId = null;
      if (approved) {
        const agent = (await store.getAgent(a.agent)) ?? { id: a.agent, name: a.agentName };
        const booked = await book(agent, a.charges, a);
        entries = booked.map((e) => e.id);
        const p = await openPurchase(agent, { method: a.method, chainId: a.chainId, to: a.to, entries: booked, verdict: a.verdict, purchase: a.purchase ?? null, approval: { id: a.id, summary: a.summary, by, at: now() } });
        purchaseId = p.id;
      }
      const next = { ...a, status: approved ? "approved" : "denied", decidedAt: now(), decidedBy: by, entries, purchaseId };
      await store.putApproval(next);
      await log(approved ? "approved" : "denied", { agent: a.agentName, method: a.method, summary: a.summary, by, ...(purchaseId ? { purchase: purchaseId } : {}), what: a.purchase?.description ?? a.purchase?.url ?? null });
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
        if (a !== found) { await store.putApproval(a); await log("expired", { agent: a.agentName, method: a.method, summary: a.summary }); Promise.resolve(onSettled(a)).catch(() => {}); }
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
      return { updated };
    },

    async purchase(purchaseId) {
      const p = typeof purchaseId === "string" ? await store.getPurchase(purchaseId) : null;
      if (!p) throw Object.assign(new Error("no such receipt (receipts are kept 90 days)"), { status: 404 });
      return p;
    },

    async spending() { const { policy } = await policyNow(); return summarize(policy, await usedNow(policy)); },

    async getPolicy() { return (await policyNow()).raw; },
    async setPolicy(raw, by = "dashboard") {
      normalizeLimits(raw); // throws a TypeError with a clear message when invalid
      await store.setPolicy(raw);
      await log("policy", { by, policy: raw });
      return raw;
    },

    async setPaused(v, by = "dashboard") { await store.setPaused(v); await log(v ? "paused" : "resumed", { by }); },

    async addAgent(name) {
      if (typeof name !== "string" || !/^[\w .-]{1,40}$/.test(name)) throw Object.assign(new Error("name: 1-40 letters, digits, spaces, . _ -"), { status: 400 });
      const key = `awk_${randomBytes(24).toString("base64url")}`;
      const agent = { id: id("ag"), name, keyHash: hashKey(key), createdAt: now(), paused: false, lastSeen: null };
      await store.putAgent(agent);
      await store.indexKey(agent.keyHash, agent.id);
      await log("agent_added", { agent: name });
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
    },
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
      const approvals = (await store.listApprovals()).map(expire).filter((a) => a.status === "pending" || now() - (a.decidedAt ?? a.createdAt) < 86_400_000).sort((x, y) => y.createdAt - x.createdAt).slice(0, 50);
      return { policy: raw, paused: await store.getPaused(), spending: await summarize(policy, used), agents, approvals, events: await store.listEvents(100), now: now() };
    },
  };
  return api;
}

const publicAgent = ({ keyHash, ...a }) => a;
