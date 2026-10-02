// Searching the public x402 catalog (Coinbase's x402 Bazaar) for paid APIs, for the dashboard's
// search bar: the same catalog presign-guard-wallet-mcp's find_services searches. Listings are
// what sellers say about themselves, so everything here is shown as data, never as a
// recommendation, and only USDC prices on networks agents commonly pay on are kept.
export const DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const TTL_MS = 60 * 60 * 1000;
const PAGES = 20;

// USDC per network (CAIP-2), 6 decimals on each.
const USDC = {
  "eip155:8453": ["Base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  "eip155:42161": ["Arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
  "eip155:10": ["Optimism", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
  "eip155:137": ["Polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
  "eip155:1": ["Ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": ["Solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
};
const STOP = new Set(["the", "and", "for", "with", "api", "get", "data", "from", "that", "this", "http", "https", "www", "com", "json", "what", "how", "can", "want", "need"]);
export const words = (t) => String(t ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const text = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

export function createCatalog({ url = DISCOVERY_URL, fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let items = null, at = 0, loading = null;
  async function load() {
    if (items && now() - at < TTL_MS) return items;
    loading ??= (async () => {
      const all = [];
      for (let page = 0; page < PAGES; page++) {
        const res = await fetchImpl(`${url}?type=http&limit=500&offset=${page * 500}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`the x402 catalog answered HTTP ${res.status}`);
        const batch = (await res.json()).items ?? [];
        all.push(...batch);
        if (batch.length < 500) break;
      }
      items = all; at = now();
      return all;
    })().finally(() => { loading = null; });
    return loading;
  }

  return {
    // Best matches for a request: { results: [{ url, host, description, method, prices: [{ network, usd }], cheapest }] }.
    async search(query, { maxUsd = Infinity, limit = 12 } = {}) {
      const terms = words(query);
      if (!terms.length) return { query: String(query ?? ""), results: [] };
      const found = new Map(); // one result per URL
      for (const item of await load()) {
        let u;
        try { u = new URL(item.resource); } catch { continue; }
        if (u.protocol !== "https:") continue;
        const prices = [];
        for (const a of item.accepts ?? []) {
          const known = USDC[a?.network];
          if (!known || String(a.asset ?? "").toLowerCase() !== known[1].toLowerCase()) continue;
          const usd = Number(a.amount ?? a.maxAmountRequired ?? NaN) / 1e6;
          if (usd >= 0 && Number.isFinite(usd) && !prices.some((p) => p.network === known[0])) prices.push({ network: known[0], usd: Number(usd.toFixed(6)) });
        }
        if (!prices.length) continue;
        const cheapest = Math.min(...prices.map((p) => p.usd));
        if (cheapest > maxUsd) continue;
        const info = item.extensions?.bazaar?.info ?? {};
        const description = text(item.description, 400) || text(item.accepts?.[0]?.description, 400);
        const have = new Set(words(`${description} ${u.hostname} ${u.pathname} ${JSON.stringify(info.input ?? {})}`));
        const score = terms.filter((t) => have.has(t)).length;
        if (!score) continue;
        const key = `${u.origin}${u.pathname}`;
        if (found.has(key) && found.get(key).score >= score) continue;
        found.set(key, { score, url: u.href, host: u.hostname, description, method: text(String(info.input?.method ?? ""), 8).toUpperCase() || null, prices, cheapest });
      }
      const results = [...found.values()].sort((a, b) => b.score - a.score || a.cheapest - b.cheapest).slice(0, Math.min(30, Math.max(1, limit))).map(({ score, ...r }) => r);
      return { query: String(query), results };
    },
  };
}
