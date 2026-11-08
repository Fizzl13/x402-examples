// What the exam keeps between requests and restarts: who used their free exam, how many exams a wallet or IP took
// today, and every finished result (the index). A memory store for tests and local runs; with REDIS_URL, the same keys
// in Redis (Render Key Value), so the index and the free-exam rule survive a restart.

export function memoryStore() {
  const kv = new Map();
  const counters = new Map();
  return {
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, value);
    },
    // Adds 1 and returns the new count; the counter forgets itself after ttlSeconds.
    async incr(key, ttlSeconds) {
      const now = Date.now();
      const c = counters.get(key);
      const next = c && c.until > now ? { n: c.n + 1, until: c.until } : { n: 1, until: now + ttlSeconds * 1000 };
      counters.set(key, next);
      return next.n;
    },
    // Sets key only when it is not there yet; true when it was set.
    async setOnce(key, value) {
      if (kv.has(key)) return false;
      kv.set(key, value);
      return true;
    },
    async list(prefix) {
      return [...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
  };
}

export async function redisStore(url, { prefix = "exam:" } = {}) {
  const { createClient } = await import("redis");
  const client = createClient({ url });
  client.on("error", (err) => console.error(`[exam] redis: ${err.message}`));
  await client.connect();
  const k = (key) => `${prefix}${key}`;
  return {
    async get(key) {
      const v = await client.get(k(key));
      return v === null ? null : JSON.parse(v);
    },
    async set(key, value) {
      await client.set(k(key), JSON.stringify(value));
    },
    async incr(key, ttlSeconds) {
      const n = await client.incr(k(key));
      if (n === 1) await client.expire(k(key), ttlSeconds);
      return n;
    },
    async setOnce(key, value) {
      return (await client.set(k(key), JSON.stringify(value), { NX: true })) === "OK";
    },
    async list(p) {
      const out = [];
      for await (const keys of client.scanIterator({ MATCH: `${k(p)}*`, COUNT: 200 })) {
        for (const key of [].concat(keys)) {
          const v = await client.get(key);
          if (v !== null) out.push(JSON.parse(v));
        }
      }
      return out;
    },
    async close() {
      await client.quit().catch(() => client.disconnect());
    },
  };
}
