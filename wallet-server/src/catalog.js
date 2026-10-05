// Searching the public x402 catalog (Coinbase's x402 Bazaar) for paid APIs, for the dashboard's
// search bar: the same catalog presign-guard-wallet-mcp's find_services searches. Listings are
// what sellers say about themselves, so everything here is shown as data, never as a
// recommendation, and only USDC prices on networks agents commonly pay on are kept.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const TTL_MS = 60 * 60 * 1000;
const PAGES = 20;
// Fizzl's own services moved from onrender.com to fizzl.eu; the Bazaar still lists some old addresses.
// An old host is left out of the catalog once its new host is listed too, so Find shows each service once.
export const MOVED_HOSTS = {
  "x402-doctor.onrender.com": "x402-doctor.fizzl.eu",
  "presign-guard.onrender.com": "presign-guard.fizzl.eu",
  "ichimoku-signal.onrender.com": "ichimoku-signal.fizzl.eu",
  "smartcontractexplainer.onrender.com": "plaintext.fizzl.eu",
};
export function withoutMovedHosts(all, moved = MOVED_HOSTS) {
  const hostOf = (item) => { try { return new URL(item.resource).hostname; } catch { return ""; } };
  const listed = new Set(all.map(hostOf));
  return all.filter((item) => { const to = moved[hostOf(item)]; return !to || !listed.has(to); });
}

// USDC per network (CAIP-2), 6 decimals on each.
const USDC = {
  "eip155:8453": ["Base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  "eip155:42161": ["Arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
  "eip155:10": ["Optimism", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
  "eip155:137": ["Polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
  "eip155:1": ["Ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": ["Solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
};
// The catalog has no categories, so listings are sorted into these by the words in their
// description and URL (the category with the most matching words; "other" when none match).
export const CATEGORIES = [
  { id: "crypto", name: "Crypto & trading", icon: "📈", words: ["crypto", "bitcoin", "btc", "eth", "ethereum", "solana", "token", "price", "prices", "trading", "trade", "signal", "signals", "market", "markets", "dex", "swap", "defi", "ohlc", "candles", "ichimoku", "coin", "coins", "memecoin", "yield"] },
  { id: "security", name: "Security & safety", icon: "🛡️", words: ["security", "safety", "safe", "scam", "rug", "honeypot", "drainer", "phishing", "risk", "audit", "sanction", "sanctions", "approval", "approvals", "verify", "verdict", "fraud", "malicious"] },
  { id: "onchain", name: "Wallets & on-chain data", icon: "⛓️", words: ["wallet", "wallets", "address", "onchain", "chain", "blockchain", "transaction", "transactions", "balance", "balances", "nft", "nfts", "contract", "contracts", "holders", "explorer", "gas", "x402"] },
  { id: "ai", name: "AI & language models", icon: "🤖", words: ["llm", "gpt", "claude", "model", "models", "inference", "prompt", "chat", "completion", "agent", "agents", "embedding", "embeddings", "summarize", "summary", "classify", "sentiment"] },
  { id: "search", name: "Search & web", icon: "🔎", words: ["search", "web", "scrape", "scraping", "crawl", "crawler", "browse", "browser", "page", "pages", "url", "urls", "news", "serp", "google", "extract"] },
  { id: "finance", name: "Stocks & finance", icon: "💹", words: ["stock", "stocks", "equity", "equities", "forex", "fx", "finance", "financial", "earnings", "nasdaq", "nyse", "commodity", "commodities", "gold", "interest", "economic", "macro"] },
  { id: "media", name: "Images, audio & video", icon: "🎨", words: ["image", "images", "photo", "picture", "video", "videos", "audio", "voice", "speech", "tts", "music", "transcribe", "transcription", "generate", "art", "ocr", "pdf"] },
  { id: "language", name: "Translation & text", icon: "🌐", words: ["translate", "translation", "language", "languages", "text", "grammar", "rewrite", "writing", "words", "dictionary"] },
  { id: "weather", name: "Weather & places", icon: "🌦️", words: ["weather", "forecast", "temperature", "climate", "rain", "geo", "geocode", "location", "map", "maps", "places", "city", "country", "timezone", "ip"] },
  { id: "social", name: "Social & people", icon: "💬", words: ["twitter", "tweet", "tweets", "social", "reddit", "farcaster", "telegram", "discord", "profile", "profiles", "followers", "email", "people", "linkedin"] },
  { id: "dev", name: "Developer tools", icon: "🛠️", words: ["api", "code", "github", "deploy", "test", "testing", "monitor", "monitoring", "uptime", "dns", "ssl", "json", "convert", "validate", "debug", "diagnose", "endpoint", "endpoints", "webhook"] },
];
export function categorize(textOf) {
  const have = new Set(String(textOf ?? "").toLowerCase().split(/[^a-z0-9]+/));
  let best = "other", top = 0;
  for (const c of CATEGORIES) {
    const n = c.words.filter((w) => have.has(w)).length;
    if (n > top) { top = n; best = c.id; }
  }
  return best;
}

const STOP = new Set(["the", "and", "for", "with", "api", "get", "data", "from", "that", "this", "http", "https", "www", "com", "json", "what", "how", "can", "want", "need", "please", "tell", "give", "show", "does", "are", "you", "your", "about", "wat", "het", "een", "van", "voor", "met", "mij", "mijn", "kan", "wil", "graag", "zijn", "deze", "dit", "die", "komende", "hoe", "welke", "waar", "wanneer", "geef", "ook", "naar", "over", "niet", "wel", "nog", "maar", "dat", "wordt", "worden", "bij", "als", "uit", "doet", "zoek"]);
// Everyday Dutch words to the English words catalog listings use, so a plain question works too
// ("wat is het weer de komende dagen in Amsterdam?" finds weather forecasts).
const NL = { weer: "weather", weerbericht: "weather", voorspelling: "forecast", temperatuur: "temperature", regen: "rain", koers: "price", koersen: "price", prijs: "price", prijzen: "price", nieuws: "news", aandeel: "stock", aandelen: "stocks", munt: "coin", munten: "coins", veilig: "safe", veiligheid: "safety", vertaal: "translate", vertaling: "translation", samenvatting: "summary", samenvatten: "summarize", adres: "address", beurs: "market", markt: "market", vandaag: "today", morgen: "tomorrow", dagen: "days", wisselkoers: "exchange", uitleg: "explain", leg: "explain", controleer: "check", afbeelding: "image", plaatje: "image", foto: "image", tekst: "text", vlucht: "flight", vluchten: "flights", bedrijf: "company", portemonnee: "wallet", signaal: "signal" };
export const words = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).map((w) => NL[w] ?? w).filter((w) => w.length >= 3 && !STOP.has(w));
// ---------- skill.md: does a seller publish instructions agents can follow? ----------
// Checked for the sellers in search results only, from the server, so carefully: https on the
// standard port, a public hostname (no IP literals, nothing resolving to a private address), no
// redirects, 3 seconds, and only a small text answer that looks like markdown. Cached per origin.
const PRIVATE = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^::$/, /^f[cd]/i, /^fe80/i, /^::ffff:(0|10|127|169\.254|192\.168)\./i];
export const isPrivateAddress = (a) => PRIVATE.some((r) => r.test(a));
export function createSkillChecker({ fetch: fetchImpl = globalThis.fetch, lookup = (h) => dnsLookup(h, { all: true }), now = () => Date.now() } = {}) {
  const cache = new Map(); // origin -> { has, at }
  const pending = new Map(); // origins being checked right now
  async function probe(origin) {
    const u = new URL(origin);
    if (u.protocol !== "https:" || u.port || isIP(u.hostname) || !u.hostname.includes(".") || /(^|\.)(localhost|local|internal)$/i.test(u.hostname)) return false;
    const addrs = await lookup(u.hostname).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address ?? a))) return false;
    const res = await fetchImpl(`${u.origin}/skill.md`, { redirect: "manual", signal: AbortSignal.timeout(3000), headers: { accept: "text/markdown, text/plain" } }).catch(() => null);
    if (!res || res.status !== 200 || !/^text\/(markdown|plain|x-markdown)/i.test(res.headers.get("content-type") ?? "")) return false;
    const reader = res.body?.getReader?.();
    let text = "";
    if (reader) {
      for (let total = 0; total < 65536;) { const { done, value } = await reader.read(); if (done) break; total += value.length; text += new TextDecoder().decode(value, { stream: true }); if (text.length > 512) break; }
      reader.cancel().catch(() => {});
    } else text = (await res.text()).slice(0, 512);
    return /^\s*(---|#)/.test(text);
  }
  return {
    known: (origin) => cache.get(origin)?.has ?? null,
    // Check these origins (in parallel, waiting at most `waitMs`); later calls use the cache.
    // At most 16 sellers are asked at once, and one that is being asked isn't asked again.
    async check(origins, { waitMs = 3500 } = {}) {
      const todo = [...new Set(origins)].filter((o) => { const c = cache.get(o); return !pending.has(o) && (!c || now() - c.at > (c.has ? 86_400_000 : 6 * 3_600_000)); });
      for (const o of todo) pending.set(o, null);
      const one = (o) => probe(o).catch(() => false).then((has) => { cache.set(o, { has, at: now() }); pending.delete(o); if (cache.size > 5000) cache.delete(cache.keys().next().value); });
      const queue = [...todo];
      const worker = async () => { while (queue.length) await one(queue.shift()); };
      const runs = Array.from({ length: Math.min(16, queue.length) }, worker);
      await Promise.race([Promise.all(runs), new Promise((ok) => setTimeout(ok, waitMs))]);
    },
  };
}

// The USDC prices of a listing, one per network we know (checked against that network's USDC).
function pricesOf(item) {
  const prices = [];
  for (const a of item.accepts ?? []) {
    const known = USDC[a?.network];
    if (!known || String(a.asset ?? "").toLowerCase() !== known[1].toLowerCase()) continue;
    const usd = Number(a.amount ?? a.maxAmountRequired ?? NaN) / 1e6;
    if (usd >= 0 && Number.isFinite(usd) && !prices.some((p) => p.network === known[0])) prices.push({ network: known[0], usd: Number(usd.toFixed(6)) });
  }
  return prices;
}
const text = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// `seen` keeps when each seller (origin) first appeared ({ getSeen, addSeen }, e.g. store.global), so
// new providers can be marked and listed. The first catalog ever loaded is the baseline: none of it is new.
// `onNew(providers)` is called once with the sellers that appeared since the last load (never for the baseline).
// `trust` (src/trust.js): x402 Doctor's daily track records per seller, to rank and label results.
export function createCatalog({ url = DISCOVERY_URL, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), seen = null, skills = null, onNew = null, trust = null, ranker = null } = {}) {
  let items = null, at = 0, loading = null, firstSeen = {};
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
      items = withoutMovedHosts(all); at = now();
      const fresh = await track(items).catch((err) => { console.warn(`[catalog] tracking new providers: ${err.message}`); return []; });
      if (fresh.length && onNew) announce(items, new Set(fresh)).catch((err) => console.warn(`[catalog] new providers: ${err.message}`));
      return items;
    })().finally(() => { loading = null; });
    return loading;
  }

  async function track(all) {
    const origins = new Set();
    for (const item of all) { try { const u = new URL(item.resource); if (u.protocol === "https:") origins.add(u.origin); } catch {} }
    const known = seen ? await seen.getSeen() : firstSeen;
    const baseline = !Object.keys(known).length;
    const fresh = {};
    for (const o of origins) if (!(o in known)) fresh[o] = baseline ? 0 : now();
    if (seen && Object.keys(fresh).length) await seen.addSeen(fresh);
    firstSeen = { ...known, ...fresh };
    return baseline ? [] : Object.keys(fresh);
  }
  // What each new seller offers, for onNew: one summary per origin (sellers without a USDC price are left out).
  function summarize(all, origins) {
    const by = new Map();
    for (const item of all) {
      let u; try { u = new URL(item.resource); } catch { continue; }
      if (!origins.has(u.origin)) continue;
      const prices = pricesOf(item);
      if (!prices.length) continue;
      const p = by.get(u.origin) ?? { origin: u.origin, host: u.hostname, firstSeen: firstSeen[u.origin], listings: 0, cheapest: Infinity, networks: new Set(), description: "", cats: new Map() };
      p.listings++;
      p.cheapest = Math.min(p.cheapest, ...prices.map((x) => x.usd));
      prices.forEach((x) => p.networks.add(x.network));
      if (!p.description) p.description = text(item.description, 300) || text(item.accepts?.[0]?.description, 300);
      const c = categoryOf(item, u);
      p.cats.set(c, (p.cats.get(c) ?? 0) + 1);
      by.set(u.origin, p);
    }
    // A seller's category: the one most of its listings fall in.
    return [...by.values()].map(({ cats, networks, ...p }) => ({ ...p, networks: [...networks], category: [...cats].sort((a, b) => b[1] - a[1])[0][0] }));
  }
  async function announce(all, origins) {
    const providers = summarize(all, origins);
    if (!providers.length) return;
    if (skills) { await skills.check(providers.map((p) => p.origin)); for (const p of providers) p.skill = skills.known(p.origin) ? `${p.origin}/skill.md` : null; }
    await onNew(providers);
  }
  const categoryOf = (item, u) => categorize(`${item.description ?? ""} ${item.accepts?.[0]?.description ?? ""} ${u.hostname.replace(/\./g, " ")} ${u.pathname.replace(/[/_-]/g, " ")}`);
  const isNew = (origin, days = 7) => (firstSeen[origin] ?? 0) > now() - days * 86_400_000;

  return {
    // Load the catalog now if the cached copy is old (the server does this hourly, so new sellers are noticed).
    async refresh() { await load(); await trust?.ready({ waitMs: 30_000 }); },
    // Sellers that appeared in the last `days` days, newest first, with what they offer.
    async newProviders({ days = 7, limit = 30 } = {}) {
      const list = await load();
      const by = new Map();
      for (const item of list) {
        let u; try { u = new URL(item.resource); } catch { continue; }
        if (u.protocol !== "https:" || !isNew(u.origin, days)) continue;
        const prices = pricesOf(item);
        if (!prices.length) continue;
        const p = by.get(u.origin) ?? { origin: u.origin, host: u.hostname, firstSeen: firstSeen[u.origin], listings: 0, cheapest: Infinity, networks: new Set(), description: "", example: u.href };
        p.listings++;
        p.cheapest = Math.min(p.cheapest, ...prices.map((x) => x.usd));
        prices.forEach((x) => p.networks.add(x.network));
        if (!p.description) p.description = text(item.description, 300);
        by.set(u.origin, p);
      }
      const providers = [...by.values()].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, limit).map((p) => ({ ...p, networks: [...p.networks] }));
      if (skills && providers.length) {
        await skills.check(providers.map((p) => p.origin));
        for (const p of providers) p.skill = skills.known(p.origin) ? `${p.origin}/skill.md` : null;
      }
      return { days, providers, trackingSince: Math.min(...Object.values(firstSeen).filter((v) => v > 0), now()) };
    },
    // Best matches for a request: { results: [{ url, host, description, method, prices: [{ network, usd }], cheapest }] }.
    // Listing counts per category (and how many from new providers), for the category tiles.
    async categories({ maxUsd = Infinity } = {}) {
      const counts = new Map([...CATEGORIES.map((c) => [c.id, { ...c, count: 0, fresh: 0, sellers: new Set() }]), ["other", { id: "other", name: "Other", icon: "✨", count: 0, fresh: 0, sellers: new Set() }]]);
      const seenUrl = new Set();
      for (const item of await load()) {
        let u; try { u = new URL(item.resource); } catch { continue; }
        if (u.protocol !== "https:" || seenUrl.has(`${u.origin}${u.pathname}`)) continue;
        const prices = pricesOf(item);
        if (!prices.length || Math.min(...prices.map((p) => p.usd)) > maxUsd) continue;
        seenUrl.add(`${u.origin}${u.pathname}`);
        const c = counts.get(categoryOf(item, u));
        c.count++;
        c.sellers.add(u.origin);
        if (isNew(u.origin)) c.fresh++;
      }
      // count: listings; providers: sellers (browsing a category shows one card per seller).
      return { categories: [...counts.values()].map(({ words: _w, sellers, ...c }) => ({ ...c, providers: sellers.size })).filter((c) => c.count > 0) };
    },
    // Results come in pages of `limit` (like a search engine): { results, total, page, pages }.
    // Filters: `networks` (names, e.g. ["Base", "Solana"]: only listings payable there, prices shown for those),
    // `fresh` (new providers only), `skill` (only sellers with a skill.md), `reliable` (only sellers x402 Doctor
    // has seen paying out on 90%+ of checks over 5+ days). `sort`: "best" (default), "cheap" or "record".
    async search(query, { maxUsd = Infinity, limit = 20, category = null, page = 1, networks = null, fresh = false, skill = false, reliable = false, sort = "best" } = {}) {
      const terms = words(query);
      const nets = networks?.length ? new Set(networks) : null;
      if (!terms.length && !category && !fresh && !skill && !reliable) return { query: String(query ?? ""), results: [], total: 0, page: 1, pages: 0 };
      const found = new Map(); // one result per URL
      for (const item of await load()) {
        let u;
        try { u = new URL(item.resource); } catch { continue; }
        if (u.protocol !== "https:") continue;
        if (fresh && !isNew(u.origin)) continue;
        const prices = pricesOf(item).filter((p) => !nets || nets.has(p.network));
        if (!prices.length) continue;
        const cheapest = Math.min(...prices.map((p) => p.usd));
        if (cheapest > maxUsd) continue;
        const info = item.extensions?.bazaar?.info ?? {};
        const description = text(item.description, 400) || text(item.accepts?.[0]?.description, 400);
        const cat = categoryOf(item, u);
        if (category && cat !== category) continue;
        const have = new Set(words(`${description} ${u.hostname} ${u.pathname} ${JSON.stringify(info.input ?? {})}`));
        // Without words, everything that passes the filters counts; new providers first, then cheapest.
        const score = terms.length ? terms.filter((t) => have.has(t)).length : 1 + (isNew(u.origin) ? 1 : 0);
        if (!score) continue;
        const key = `${u.origin}${u.pathname}`;
        if (found.has(key) && found.get(key).score >= score) continue;
        found.set(key, { score, url: u.href, host: u.hostname, description, method: text(String(info.input?.method ?? ""), 8).toUpperCase() || null, prices, cheapest, isNew: isNew(u.origin), category: cat });
      }
      let all = [...found.values()].sort((a, b) => b.score - a.score || a.cheapest - b.cheapest);
      const origin = (r) => new URL(r.url).origin;
      // Filters on the seller: its skill.md (checked now for up to 300 sellers, briefly) and its track record.
      if (skill || reliable) {
        await Promise.all([skill && skills ? skills.check([...new Set(all.map(origin))].slice(0, 300)) : null, reliable ? trust?.ready() : null]);
        all = all.filter((r) => (!skill || skills?.known(origin(r))) && (!reliable || trust?.tier(origin(r)) === 2));
      }
      // Browsing (no words): one card per seller, so a seller with fifty near-identical endpoints
      // doesn't fill the page. Sellers with a skill.md first (an agent can connect to them at once), then new
      // ones, then the cheapest.
      const browse = !terms.length;
      if (browse) {
        const by = new Map();
        for (const r of all) {
          const o = origin(r), seller = by.get(o);
          if (!seller) { by.set(o, { ...r, endpoints: 1, prices: [...r.prices] }); continue; }
          seller.endpoints++;
          for (const p of r.prices) { const have = seller.prices.find((x) => x.network === p.network); if (!have) seller.prices.push({ ...p }); else if (p.usd < have.usd) have.usd = p.usd; }
          if (!seller.description && r.description) seller.description = r.description;
        }
        all = [...by.values()];
        await Promise.all([skills?.check(all.slice(0, 300).map(origin)), trust?.ready()]);
      }
      // Within the same skill.md group: sellers x402 Doctor has seen paying out day after day first (a longer
      // record first), then unknown ones, then sellers that often fail; then new ones, then the cheapest.
      const has = (r) => (skills?.known(origin(r)) ? 1 : 0);
      const tier = (r) => trust?.tier(origin(r)) ?? 1;
      const record = (r) => (tier(r) === 2 ? trust.seller(origin(r)).payableDays : 0);
      if (sort === "cheap") all.sort((a, b) => a.cheapest - b.cheapest || (b.score ?? 0) - (a.score ?? 0));
      else if (sort === "record") { await trust?.ready(); all.sort((a, b) => tier(b) - tier(a) || record(b) - record(a) || (b.score ?? 0) - (a.score ?? 0) || a.cheapest - b.cheapest); }
      else if (browse) all.sort((a, b) => has(b) - has(a) || tier(b) - tier(a) || record(b) - record(a) || Number(b.isNew) - Number(a.isNew) || a.cheapest - b.cheapest);
      // "best" with words: the best keyword matches ranked by meaning (src/jev-rank.js); keyword order if off or failing.
      else if (ranker?.enabled) all = await ranker.rank(String(query), all);
      const per = Math.min(50, Math.max(1, Math.floor(limit) || 20)), pages = Math.ceil(all.length / per);
      const at = Math.min(Math.max(1, Math.floor(page) || 1), Math.max(1, pages));
      const results = all.slice((at - 1) * per, at * per).map(({ score, ...r }) => r);
      // Which of these sellers publish a skill.md (cached; unknown ones are checked now, briefly).
      if (skills && results.length) {
        const origins = results.map((r) => new URL(r.url).origin);
        await skills.check(origins);
        for (const r of results) r.skill = skills.known(new URL(r.url).origin) ? `${new URL(r.url).origin}/skill.md` : null;
      }
      // The seller's track record, shown on the card ("paid out 30 of 30 days").
      if (trust) { await trust.ready({ waitMs: 0 }); for (const r of results) r.record = trust.seller(new URL(r.url).origin); }
      return { query: String(query ?? ""), category, results, total: all.length, page: at, pages };
    },
  };
}
