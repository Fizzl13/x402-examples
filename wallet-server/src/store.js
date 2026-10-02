// Where the wallet server keeps its state: the policy (limits), the agents and
// their key hashes, booked spending, approval requests and an activity log.
// memoryStore for tests and local runs; redisStore for production (one
// persistent Redis, e.g. Upstash). Agent keys are stored only as SHA-256.
// Every method is async so both stores share one interface.

const EVENTS_KEPT = 500;
const ENTRIES_KEPT_MS = 31 * 86_400_000;
const PURCHASES_KEPT_S = 90 * 86_400; // receipts are kept 90 days

export function memoryStore() {
  let policy = null, paused = false;
  const agents = new Map(), keyIndex = new Map(), approvals = new Map(), purchases = new Map();
  let entries = [], events = [];
  return {
    async getPolicy() { return policy; },
    async setPolicy(p) { policy = p; },
    async getPaused() { return paused; },
    async setPaused(v) { paused = !!v; },
    async listAgents() { return [...agents.values()]; },
    async getAgent(id) { return agents.get(id) ?? null; },
    async putAgent(a) { agents.set(a.id, a); },
    async deleteAgent(id) { const a = agents.get(id); agents.delete(id); if (a) keyIndex.delete(a.keyHash); },
    async agentByKeyHash(h) { const id = keyIndex.get(h); return id ? agents.get(id) ?? null : null; },
    async indexKey(h, id) { keyIndex.set(h, id); },
    async addEntries(list) { entries.push(...list); },
    async removeEntries(ids) { const s = new Set(ids); entries = entries.filter((e) => !s.has(e.id)); },
    async listEntries(since) { entries = entries.filter((e) => e.at >= Date.now() - ENTRIES_KEPT_MS); return entries.filter((e) => e.at >= since); },
    async getApproval(id) { return approvals.get(id) ?? null; },
    async putApproval(a) { approvals.set(a.id, a); },
    async listApprovals() { return [...approvals.values()]; },
    async addEvent(e) { events.unshift(e); events = events.slice(0, EVENTS_KEPT); },
    async listEvents(n = 100) { return events.slice(0, n); },
    async getPurchase(id) { return purchases.get(id) ?? null; },
    async putPurchase(p) { purchases.set(p.id, p); },
  };
}

export async function redisStore(url, { prefix = "aw:" } = {}) {
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { reconnectStrategy: (tries) => Math.min(tries * 200, 5000) } });
  client.on("error", (err) => console.warn(`[store] redis: ${err.message}`));
  let timer;
  await Promise.race([client.connect(), new Promise((_, no) => { timer = setTimeout(() => no(new Error("no Redis connection within 10s")), 10_000); })]).finally(() => clearTimeout(timer));
  await client.ping();
  const k = (s) => prefix + s;
  const json = (v) => (v == null ? null : JSON.parse(v));
  return {
    async getPolicy() { return json(await client.get(k("policy"))); },
    async setPolicy(p) { await client.set(k("policy"), JSON.stringify(p)); },
    async getPaused() { return (await client.get(k("paused"))) === "1"; },
    async setPaused(v) { await client.set(k("paused"), v ? "1" : "0"); },
    async listAgents() { return Object.values(await client.hGetAll(k("agents"))).map(json); },
    async getAgent(id) { return json(await client.hGet(k("agents"), id)); },
    async putAgent(a) { await client.hSet(k("agents"), a.id, JSON.stringify(a)); },
    async deleteAgent(id) { const a = json(await client.hGet(k("agents"), id)); await client.hDel(k("agents"), id); if (a) await client.del(k(`key:${a.keyHash}`)); },
    async agentByKeyHash(h) { const id = await client.get(k(`key:${h}`)); return id ? json(await client.hGet(k("agents"), id)) : null; },
    async indexKey(h, id) { await client.set(k(`key:${h}`), id); },
    async addEntries(list) { if (list.length) await client.zAdd(k("entries"), list.map((e) => ({ score: e.at, value: JSON.stringify(e) }))); },
    async removeEntries(ids) {
      const s = new Set(ids);
      const all = await client.zRange(k("entries"), 0, -1);
      const gone = all.filter((v) => s.has(json(v).id));
      if (gone.length) await client.zRem(k("entries"), gone);
    },
    async listEntries(since) {
      await client.zRemRangeByScore(k("entries"), "-inf", Date.now() - ENTRIES_KEPT_MS);
      return (await client.zRangeByScore(k("entries"), since, "+inf")).map(json);
    },
    async getApproval(id) { return json(await client.hGet(k("approvals"), id)); },
    async putApproval(a) { await client.hSet(k("approvals"), a.id, JSON.stringify(a)); },
    async listApprovals() { return Object.values(await client.hGetAll(k("approvals"))).map(json); },
    async addEvent(e) { await client.lPush(k("events"), JSON.stringify(e)); await client.lTrim(k("events"), 0, EVENTS_KEPT - 1); },
    async listEvents(n = 100) { return (await client.lRange(k("events"), 0, n - 1)).map(json); },
    async getPurchase(id) { return json(await client.get(k(`purchase:${id}`))); },
    async putPurchase(p) { await client.set(k(`purchase:${p.id}`), JSON.stringify(p), { EX: PURCHASES_KEPT_S }); },
    close: () => client.quit(),
  };
}
