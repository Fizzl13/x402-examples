// Where the wallet server keeps its state. Every account (the owner of a
// self-hosted server, "admin", or a customer signed in with their wallet) has
// its own scope: its policy (limits), agents and their key hashes, booked
// spending, approval requests, receipts and activity log. Next to the scopes,
// a small global part: accounts, which account an agent key or approval
// belongs to, one-time codes (sign-in nonces, Telegram links) and claimed
// payments.
//
// memoryStore for tests and local runs; redisStore for production (one
// persistent Redis, e.g. Upstash). The admin scope keeps the original "aw:"
// keys, so an existing server keeps its state. Agent keys are stored only as
// SHA-256. Every method is async so both stores share one interface.

const EVENTS_KEPT = 500;
const ENTRIES_KEPT_MS = 31 * 86_400_000;
export const RECEIPT_DAYS = 90; // default receipt lifetime
export const ADMIN = "admin";

export function memoryStore() {
  const scopes = new Map();
  const accounts = new Map(), keyOwners = new Map(), approvalOwners = new Map(), claimed = new Set(), seen = new Map();
  const once = new Map(); // `${kind}:${id}` -> { value, until }
  const outreach = new Map(), contacted = new Set(), stopped = new Set(), sentPerDay = new Map();
  const likes = new Map(), likedBy = new Map(); // site -> count; visitor-hash -> expiry (ms)

  const global = {
    // Outreach (src/outreach.js): drafts, who was mailed (once), who said stop, sends per UTC day.
    async putOutreach(d) { outreach.set(d.id, structuredClone(d)); },
    async getOutreach(id) { const d = outreach.get(id); return d ? structuredClone(d) : null; },
    async listOutreach() { return [...outreach.values()].map((d) => structuredClone(d)); },
    async markContacted(email) { if (contacted.has(email)) return false; contacted.add(email); return true; },
    async isContacted(email) { return contacted.has(email); },
    async unmarkContacted(email) { contacted.delete(email); },
    async stopOutreach(email) { stopped.add(email); },
    async isStopped(email) { return stopped.has(email); },
    async countSent(day, add = 0) { const n = (sentPerDay.get(day) ?? 0) + add; sentPerDay.set(day, n); return n; },
    // Likes on the Fizzl websites: a count per site, and a short-lived mark per visitor so one visitor counts once.
    async likeCount(site) { return likes.get(site) ?? 0; },
    async like(site, mark, ttlSeconds) {
      const now = Date.now();
      if ((likedBy.get(mark) ?? 0) > now) return { counted: false, count: likes.get(site) ?? 0 };
      likedBy.set(mark, now + ttlSeconds * 1000); if (likedBy.size > 50_000) likedBy.clear();
      const n = (likes.get(site) ?? 0) + 1; likes.set(site, n); return { counted: true, count: n };
    },
    async unlike(site, mark) {
      if (!((likedBy.get(mark) ?? 0) > Date.now())) return { counted: false, count: likes.get(site) ?? 0 };
      likedBy.delete(mark);
      const n = Math.max(0, (likes.get(site) ?? 0) - 1); likes.set(site, n); return { counted: true, count: n };
    },
    async getAccount(id) { return accounts.get(id) ?? null; },
    async putAccount(a) { accounts.set(a.id, a); },
    async listAccounts() { return [...accounts.values()]; },
    async getKeyOwner(h) { return keyOwners.get(h) ?? null; },
    async setKeyOwner(h, account) { keyOwners.set(h, account); },
    async delKeyOwner(h) { keyOwners.delete(h); },
    async getApprovalOwner(id) { return approvalOwners.get(id) ?? null; },
    async setApprovalOwner(id, account) { approvalOwners.set(id, account); },
    async putOnce(kind, id, value, ttlS) { once.set(`${kind}:${id}`, { value, until: Date.now() + ttlS * 1000 }); },
    async takeOnce(kind, id) {
      const k = `${kind}:${id}`, v = once.get(k);
      once.delete(k);
      return v && v.until > Date.now() ? v.value : null;
    },
    async claimTx(hash) { if (claimed.has(hash)) return false; claimed.add(hash); return true; },
    // When each seller (origin) was first seen in the x402 catalog: { origin: ms }, 0 = before tracking began.
    async getSeen() { return Object.fromEntries(seen); },
    async addSeen(entries) { for (const [k, v] of Object.entries(entries)) if (!seen.has(k)) seen.set(k, v); },
  };

  function scope(account) {
    if (scopes.has(account)) return scopes.get(account);
    let policy = null, paused = false;
    const agents = new Map(), keyIndex = new Map(), approvals = new Map(), purchases = new Map();
    let entries = [], events = [];
    const s = {
      account,
      async getPolicy() { return policy; },
      async setPolicy(p) { policy = p; },
      async getPaused() { return paused; },
      async setPaused(v) { paused = !!v; },
      async listAgents() { return [...agents.values()]; },
      async getAgent(id) { return agents.get(id) ?? null; },
      async putAgent(a) { agents.set(a.id, a); },
      async deleteAgent(id) {
        const a = agents.get(id); agents.delete(id);
        if (a) { keyIndex.delete(a.keyHash); if (account !== ADMIN) await global.delKeyOwner(a.keyHash); }
      },
      async agentByKeyHash(h) { const id = keyIndex.get(h); return id ? agents.get(id) ?? null : null; },
      async indexKey(h, id) { keyIndex.set(h, id); if (account !== ADMIN) await global.setKeyOwner(h, account); },
      async addEntries(list) { entries.push(...list); },
      async removeEntries(ids) { const set = new Set(ids); entries = entries.filter((e) => !set.has(e.id)); },
      async listEntries(since) { entries = entries.filter((e) => e.at >= Date.now() - ENTRIES_KEPT_MS); return entries.filter((e) => e.at >= since); },
      async getApproval(id) { return approvals.get(id) ?? null; },
      async putApproval(a) { approvals.set(a.id, a); if (account !== ADMIN) await global.setApprovalOwner(a.id, account); },
      async listApprovals() { return [...approvals.values()]; },
      async deleteApproval(id) { approvals.delete(id); },
      async addEvent(e) { events.unshift(e); events = events.slice(0, EVENTS_KEPT); },
      async listEvents(n = 100) { return events.slice(0, n); },
      async getPurchase(id) { const p = purchases.get(id); return p && p.until > Date.now() ? p.value : null; },
      async putPurchase(p, ttlDays = RECEIPT_DAYS) { purchases.set(p.id, { value: p, until: Date.now() + ttlDays * 86_400_000 }); },
      // The newest receipts first (expired ones left out).
      async listPurchases(n = 100) {
        for (const [id, p] of purchases) if (p.until <= Date.now()) purchases.delete(id);
        return [...purchases.values()].map((p) => p.value).sort((x, y) => y.createdAt - x.createdAt).slice(0, n);
      },
    };
    scopes.set(account, s);
    return s;
  }

  // Remove everything in one account's scope (its agents' keys included).
  async function wipe(account) {
    if (account === ADMIN) throw new Error("the owner's scope can't be wiped");
    const s = scopes.get(account);
    if (s) for (const a of await s.listAgents()) await global.delKeyOwner(a.keyHash);
    scopes.delete(account);
  }

  const admin = scope(ADMIN);
  return Object.assign(admin, { scope, global, wipe });
}

export async function redisStore(url, { prefix = "aw:" } = {}) {
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { reconnectStrategy: (tries) => Math.min(tries * 200, 5000) } });
  client.on("error", (err) => console.warn(`[store] redis: ${err.message}`));
  let timer;
  await Promise.race([client.connect(), new Promise((_, no) => { timer = setTimeout(() => no(new Error("no Redis connection within 10s")), 10_000); })]).finally(() => clearTimeout(timer));
  await client.ping();
  const json = (v) => (v == null ? null : JSON.parse(v));
  const g = (s) => `${prefix}g:${s}`;

  const global = {
    async putOutreach(d) { await client.hSet(g("outreach"), d.id, JSON.stringify(d)); },
    async getOutreach(id) { return json(await client.hGet(g("outreach"), id)); },
    async listOutreach() { return Object.values(await client.hGetAll(g("outreach"))).map(json); },
    async markContacted(email) { return (await client.sAdd(g("outreach:contacted"), email)) === 1; },
    async isContacted(email) { return Boolean(await client.sIsMember(g("outreach:contacted"), email)); },
    async unmarkContacted(email) { await client.sRem(g("outreach:contacted"), email); },
    async stopOutreach(email) { await client.sAdd(g("outreach:stop"), email); },
    async isStopped(email) { return Boolean(await client.sIsMember(g("outreach:stop"), email)); },
    async countSent(day, add = 0) {
      const key = g(`outreach:day:${day}`);
      if (!add) return Number((await client.get(key)) ?? 0);
      const n = await client.incrBy(key, add); await client.expire(key, 3 * 86_400); return n;
    },
    async likeCount(site) { return Math.max(0, Number((await client.get(g(`likes:${site}`))) ?? 0)); },
    async like(site, mark, ttlSeconds) {
      const fresh = await client.set(g(`likes:by:${mark}`), "1", { NX: true, EX: ttlSeconds });
      if (!fresh) return { counted: false, count: await this.likeCount(site) };
      return { counted: true, count: await client.incr(g(`likes:${site}`)) };
    },
    async unlike(site, mark) {
      if (!(await client.del(g(`likes:by:${mark}`)))) return { counted: false, count: await this.likeCount(site) };
      const n = await client.decr(g(`likes:${site}`));
      if (n < 0) { await client.set(g(`likes:${site}`), "0"); return { counted: true, count: 0 }; }
      return { counted: true, count: n };
    },
    async getAccount(id) { return json(await client.hGet(g("accounts"), id)); },
    async putAccount(a) { await client.hSet(g("accounts"), a.id, JSON.stringify(a)); },
    async listAccounts() { return Object.values(await client.hGetAll(g("accounts"))).map(json); },
    async getKeyOwner(h) { return client.get(g(`key:${h}`)); },
    async setKeyOwner(h, account) { await client.set(g(`key:${h}`), account); },
    async delKeyOwner(h) { await client.del(g(`key:${h}`)); },
    async getApprovalOwner(id) { return client.get(g(`approval:${id}`)); },
    async setApprovalOwner(id, account) { await client.set(g(`approval:${id}`), account, { EX: 2 * 86_400 }); },
    async putOnce(kind, id, value, ttlS) { await client.set(g(`once:${kind}:${id}`), JSON.stringify(value), { EX: ttlS }); },
    async takeOnce(kind, id) { return json(await client.getDel(g(`once:${kind}:${id}`))); },
    async claimTx(hash) { return (await client.set(g(`tx:${hash}`), "1", { NX: true })) === "OK"; },
    async getSeen() { return Object.fromEntries(Object.entries(await client.hGetAll(g("seen"))).map(([k, v]) => [k, Number(v)])); },
    async addSeen(entries) { for (const [k, v] of Object.entries(entries)) await client.hSetNX(g("seen"), k, String(v)); },
  };

  const scopes = new Map();
  function scope(account) {
    if (scopes.has(account)) return scopes.get(account);
    const base = account === ADMIN ? prefix : `${prefix}u:${account}:`;
    const k = (s) => base + s;
    const s = {
      account,
      async getPolicy() { return json(await client.get(k("policy"))); },
      async setPolicy(p) { await client.set(k("policy"), JSON.stringify(p)); },
      async getPaused() { return (await client.get(k("paused"))) === "1"; },
      async setPaused(v) { await client.set(k("paused"), v ? "1" : "0"); },
      async listAgents() { return Object.values(await client.hGetAll(k("agents"))).map(json); },
      async getAgent(id) { return json(await client.hGet(k("agents"), id)); },
      async putAgent(a) { await client.hSet(k("agents"), a.id, JSON.stringify(a)); },
      async deleteAgent(id) {
        const a = json(await client.hGet(k("agents"), id));
        await client.hDel(k("agents"), id);
        if (a) { await client.del(k(`key:${a.keyHash}`)); if (account !== ADMIN) await global.delKeyOwner(a.keyHash); }
      },
      async agentByKeyHash(h) { const id = await client.get(k(`key:${h}`)); return id ? json(await client.hGet(k("agents"), id)) : null; },
      async indexKey(h, id) { await client.set(k(`key:${h}`), id); if (account !== ADMIN) await global.setKeyOwner(h, account); },
      async addEntries(list) { if (list.length) await client.zAdd(k("entries"), list.map((e) => ({ score: e.at, value: JSON.stringify(e) }))); },
      async removeEntries(ids) {
        const set = new Set(ids);
        const all = await client.zRange(k("entries"), 0, -1);
        const gone = all.filter((v) => set.has(json(v).id));
        if (gone.length) await client.zRem(k("entries"), gone);
      },
      async listEntries(since) {
        await client.zRemRangeByScore(k("entries"), "-inf", Date.now() - ENTRIES_KEPT_MS);
        return (await client.zRangeByScore(k("entries"), since, "+inf")).map(json);
      },
      async getApproval(id) { return json(await client.hGet(k("approvals"), id)); },
      async putApproval(a) { await client.hSet(k("approvals"), a.id, JSON.stringify(a)); if (account !== ADMIN) await global.setApprovalOwner(a.id, account); },
      async listApprovals() { return Object.values(await client.hGetAll(k("approvals"))).map(json); },
      async deleteApproval(id) { await client.hDel(k("approvals"), id); },
      async addEvent(e) { await client.lPush(k("events"), JSON.stringify(e)); await client.lTrim(k("events"), 0, EVENTS_KEPT - 1); },
      async listEvents(n = 100) { return (await client.lRange(k("events"), 0, n - 1)).map(json); },
      async getPurchase(id) { return json(await client.get(k(`purchase:${id}`))); },
      async putPurchase(p, ttlDays = RECEIPT_DAYS) {
        await client.set(k(`purchase:${p.id}`), JSON.stringify(p), { EX: ttlDays * 86_400 });
        await client.zAdd(k("purchases"), { score: p.createdAt, value: p.id });
      },
      // The newest receipts first. The index outlives expired receipts, so those are dropped from it here.
      async listPurchases(n = 100) {
        const ids = await client.zRange(k("purchases"), 0, n - 1, { REV: true });
        if (!ids.length) return [];
        const vals = await client.mGet(ids.map((id) => k(`purchase:${id}`)));
        const gone = ids.filter((_, i) => vals[i] == null);
        if (gone.length) await client.zRem(k("purchases"), gone);
        return vals.filter((v) => v != null).map(json);
      },
    };
    scopes.set(account, s);
    return s;
  }

  async function wipe(account) {
    if (account === ADMIN) throw new Error("the owner's scope can't be wiped");
    for (const a of await scope(account).listAgents()) await global.delKeyOwner(a.keyHash);
    const keys = [];
    for await (const batch of client.scanIterator({ MATCH: `${prefix}u:${account}:*`, COUNT: 200 })) keys.push(...(Array.isArray(batch) ? batch : [batch]));
    if (keys.length) await client.del(keys);
  }

  const admin = scope(ADMIN);
  return Object.assign(admin, { scope, global, wipe, close: () => client.quit() });
}
