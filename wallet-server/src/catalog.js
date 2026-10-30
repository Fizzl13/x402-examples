// Searching the public x402 catalog (Coinbase's x402 Bazaar) for paid APIs, for the dashboard's
// search bar: the same catalog presign-guard-wallet-mcp's find_services searches. Listings are
// what sellers say about themselves, so everything here is shown as data, never as a
// recommendation, and only USDC prices on networks agents commonly pay on are kept.
import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { readdirSync, rmSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const TTL_MS = 60 * 60 * 1000;
// The catalog comes oldest update first (a listing is updated when a payment settles), so its first pages are the
// sellers nobody has paid lately. Up to 20 pages left out the newest two thirds (1,062 sellers, 22 Oct 2026); now
// all of it is read, four pages at a time. On 25 Oct it was 103 pages, and a cap of 100 left out the newest listings
// again; the cap is only there against a runaway total.
const PAGES = 2000;
const AT_ONCE = 4;
// Marks the first load of the whole catalog in `seen`: the sellers it adds were there before, not new (see track).
const WHOLE = "#whole-catalog";
// Fizzl's own services moved from onrender.com to fizzl.eu; the Bazaar still lists some old addresses.
// An old host is left out of the catalog once its new host is listed too, so Find shows each service once.
export const MOVED_HOSTS = {
  "x402-doctor.onrender.com": "x402-doctor.fizzl.eu",
  "presign-guard.onrender.com": "presign-guard.fizzl.eu",
  "ichimoku-signal.onrender.com": "ichimoku-signal.fizzl.eu",
  "smartcontractexplainer.onrender.com": "plaintext.fizzl.eu",
};

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
// A rough English stem, the same for listings and questions, so "paying", "pays" and "paid"-less forms meet: "paying"
// and "pays" become "pay", "checks" and "checking" "check", "prices" "price". It only has to be consistent, not right.
export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}
export const words = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).map((w) => NL[w] ?? w).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
// ---------- skill.md: does a seller publish instructions agents can follow? ----------
// Checked for the sellers in search results only, from the server, so carefully: https on the
// standard port, a public hostname (no IP literals, nothing resolving to a private address), no
// redirects, 3 seconds, and only a small text answer that looks like markdown. Cached per origin.
const PRIVATE = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^::$/, /^f[cd]/i, /^fe80/i, /^::ffff:(0|10|127|169\.254|192\.168)\./i];
export const isPrivateAddress = (a) => PRIVATE.some((r) => r.test(a));
// A skill.md is text an agent reads and follows, so a seller could hide instructions in it ("send me your key",
// "pay this address instead"). Before a link is shown, PG1 (pg1-ai-agent.vercel.app, free) reads it with
// check_agent_message: fixed rules, no AI model, and the text isn't stored. Its answer: "malicious" (hidden tag
// characters, a request for secrets, a payment redirect, a sanctioned address), "suspicious" (medium findings only)
// or "no_findings", which doesn't prove the text is harmless. Returns { verdict, codes }, or null when PG1 can't be
// asked (slow, down, or over its 60 calls an hour; PG1_API_KEY lifts that limit). After a rate limit it is left
// alone for 5 minutes.
export const PG1_URL = "https://pg1-ai-agent.vercel.app/api/mcp";
const MAX_SKILL_BYTES = 65536; // PG1 reads up to 64 KB
export function createAgentMessageCheck({ fetch: fetchImpl = globalThis.fetch, url = PG1_URL, apiKey = null, timeoutMs = 8000, now = () => Date.now() } = {}) {
  let pausedUntil = 0, id = 0;
  return async function checkText(text, kind = "skill_md") {
    if (now() < pausedUntil) return null;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (apiKey) headers["x-api-key"] = apiKey;
    try {
      const res = await fetchImpl(url, { method: "POST", headers, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "check_agent_message", arguments: { text, kind } } }) });
      if (res.status === 429) { pausedUntil = now() + 5 * 60_000; return null; }
      if (!res.ok) return null;
      const raw = await res.text();
      const result = JSON.parse(raw.match(/^data: (.*)$/m)?.[1] ?? raw)?.result;
      if (!result || result.isError) { if (/rate_limited/.test(JSON.stringify(result ?? ""))) pausedUntil = now() + 5 * 60_000; return null; }
      const out = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
      if (!["no_findings", "suspicious", "malicious"].includes(out?.verdict)) return null;
      const codes = [...new Set((out.findings ?? []).map((f) => String(f?.code ?? "")).filter(Boolean))].slice(0, 8);
      return { verdict: out.verdict, codes };
    } catch { return null; }
  };
}
// A link is shown with the check's result (skillCheck): "no_findings", "suspicious" (shown with a warning) or
// "unchecked" (PG1 couldn't be asked, or the file is over 64 KB); a "malicious" one isn't shown at all.
export function createSkillChecker({ fetch: fetchImpl = globalThis.fetch, lookup = (h) => dnsLookup(h, { all: true }), now = () => Date.now(), checkText = null } = {}) {
  const cache = new Map(); // origin -> { has, at, check }
  const pending = new Map(); // origins being checked right now
  async function probe(origin) {
    const no = { has: false, check: null };
    const u = new URL(origin);
    if (u.protocol !== "https:" || u.port || isIP(u.hostname) || !u.hostname.includes(".") || /(^|\.)(localhost|local|internal)$/i.test(u.hostname)) return no;
    const addrs = await lookup(u.hostname).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address ?? a))) return no;
    const res = await fetchImpl(`${u.origin}/skill.md`, { redirect: "manual", signal: AbortSignal.timeout(3000), headers: { accept: "text/markdown, text/plain" } }).catch(() => null);
    if (!res || res.status !== 200 || !/^text\/(markdown|plain|x-markdown)/i.test(res.headers.get("content-type") ?? "")) return no;
    // Read up to 64 KB (one byte more tells whether there is more), all of it for the injection check.
    const reader = res.body?.getReader?.();
    const chunks = [];
    let total = 0;
    if (reader) {
      while (total <= MAX_SKILL_BYTES) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
      reader.cancel().catch(() => {});
    } else { const b = new Uint8Array(await res.arrayBuffer()); chunks.push(b); total = b.length; }
    const bytes = new Uint8Array(Math.min(total, MAX_SKILL_BYTES + 1));
    let at = 0;
    for (const c of chunks) { if (at >= bytes.length) break; bytes.set(c.subarray(0, bytes.length - at), at); at += Math.min(c.length, bytes.length - at); }
    const tooBig = total > MAX_SKILL_BYTES;
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*(---|#)/.test(text)) return no;
    const check = checkText && !tooBig ? await checkText(text, "skill_md").catch(() => null) : null;
    return { has: true, check };
  }
  const entry = (origin) => cache.get(origin);
  const shown = (c) => !!c?.has && c.check?.verdict !== "malicious";
  return {
    known: (origin) => (entry(origin) ? shown(entry(origin)) : null),
    // What the check found for a shown link: { verdict: "no_findings" | "suspicious" | "unchecked", codes }; null without one.
    review: (origin) => { const c = entry(origin); return shown(c) ? (c.check ?? { verdict: "unchecked", codes: [] }) : null; },
    // Check these origins (in parallel, waiting at most `waitMs`); later calls use the cache.
    // At most 16 sellers are asked at once, and one that is being asked isn't asked again.
    // A checked skill.md is checked again after a day; no skill.md, or one PG1 couldn't check, after 6 hours.
    async check(origins, { waitMs = 3500 } = {}) {
      const todo = [...new Set(origins)].filter((o) => { const c = cache.get(o); return !pending.has(o) && (!c || now() - c.at > (c.has && c.check ? 86_400_000 : 6 * 3_600_000)); });
      for (const o of todo) pending.set(o, null);
      const one = (o) => probe(o).catch(() => ({ has: false, check: null })).then(({ has, check }) => { cache.set(o, { has, check, at: now() }); pending.delete(o); if (cache.size > 5000) cache.delete(cache.keys().next().value); });
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
  for (const a of item?.accepts ?? []) {
    const known = USDC[a?.network];
    if (!known || String(a.asset ?? "").toLowerCase() !== known[1].toLowerCase()) continue;
    const usd = Number(a.amount ?? a.maxAmountRequired ?? NaN) / 1e6;
    if (usd >= 0 && Number.isFinite(usd) && !prices.some((p) => p.network === known[0])) prices.push({ network: known[0], usd: Number(usd.toFixed(6)) });
  }
  return prices;
}
const text = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
// Only what search, the category tiles and new-seller alerts read from a listing: its USDC prices, category and
// search words (" bitcoin price btc "), worked out once per load, and of the example input only what a search shows
// (the method, and the query parameters or body).
export function slimListing(item) {
  const input = item?.extensions?.bazaar?.info?.input;
  const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
  const description = text(item?.description, 400) || text(accepts[0]?.description, 400);
  const first400 = (v) => (typeof v === "string" ? v.slice(0, 400) : "");
  let u = null;
  try { u = new URL(item?.resource); } catch {}
  const example = input ? Object.fromEntries(["method", "queryParams", "body"].filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) : null;
  return {
    resource: item?.resource,
    description,
    prices: pricesOf(item),
    ...(example ? { input: example } : {}),
    category: u ? categorize(`${first400(item?.description)} ${first400(accepts[0]?.description)} ${u.hostname.replace(/\./g, " ")} ${u.pathname.replace(/[/_-]/g, " ")}`) : "other",
    words: u ? ` ${[...new Set(words(`${description} ${u.hostname} ${u.pathname} ${JSON.stringify(input ?? {})}`))].join(" ")} ` : " ",
  };
}

// One load of the catalog, in a SQLite file (Node's built-in node:sqlite) rather than in memory. In memory it took
// 104 MB for 51,000 listings, twice that while refreshing, and ran this 512 MB server out of memory on 25 Oct 2026
// (exit status 134); the catalog keeps growing. On disk the heap stays ~20 MB whatever its size, and a search looks its
// words up in a full-text index (fts) instead of going through every listing. The file is written page by page and
// then only read, and removed when it is closed. (Removing it while open, so a crash would leave nothing, works with
// Node 22's SQLite but gives "disk I/O error" on the first write with Node 24 and later: 25 Oct 2026, every search
// on Render failed. Files a crash leaves behind are cleared by removeStale.)
// The file is kept small, since it grows with the catalog and is there twice during a refresh (75 MB for 51,700
// listings on 25 Oct 2026, 45 MB since): the full-text index keeps no copy of the words (content=''), so a search
// counts a listing's matching words with one index lookup per word (see matchCounts); example inputs, the same for
// many endpoints of a seller (19,800 different ones among 51,700), are kept once in their own table; and there is no
// index on host, which only the hourly moved-hosts step reads.
function createListingsFile(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
    CREATE TABLE examples (id INTEGER PRIMARY KEY, hash INTEGER UNIQUE, json TEXT);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, resource TEXT, origin TEXT, host TEXT, path TEXT, https INTEGER,
      description TEXT, prices TEXT, cheapest REAL, method TEXT, example INTEGER, category TEXT);
    CREATE INDEX listings_origin ON listings (origin);
    CREATE VIRTUAL TABLE fts USING fts5(words, content='', contentless_delete=1);`);
  const insert = db.prepare("INSERT INTO listings (resource, origin, host, path, https, description, prices, cheapest, method, example, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertWords = db.prepare("INSERT INTO fts (rowid, words) VALUES (?, ?)");
  const insertExample = db.prepare("INSERT INTO examples (hash, json) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING");
  const exampleId = db.prepare("SELECT id FROM examples WHERE hash = ?");
  // The id of an example input (JSON), stored once; null without one. Keyed by the first 8 bytes of its SHA-1.
  const exampleOf = (input) => {
    const json = JSON.stringify(input?.queryParams ?? input?.body ?? null);
    if (json === "null") return null;
    const hash = createHash("sha1").update(json).digest().readBigInt64BE(0);
    insertExample.run(hash, json);
    return exampleId.get(hash).id;
  };
  return {
    db,
    add(items) {
      db.exec("BEGIN");
      try {
        for (const item of items) {
          const s = slimListing(item);
          let u = null;
          try { u = new URL(s.resource); } catch {}
          const cheapest = s.prices.length ? Math.min(...s.prices.map((p) => p.usd)) : null;
          const { lastInsertRowid } = insert.run(u?.href ?? String(s.resource ?? ""), u?.origin ?? null, u?.hostname ?? null, u?.pathname ?? null, u?.protocol === "https:" ? 1 : 0,
            s.description, JSON.stringify(s.prices), cheapest, text(String(s.input?.method ?? ""), 8).toUpperCase() || null,
            exampleOf(s.input), s.category);
          insertWords.run(lastInsertRowid, s.words);
        }
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
    // An old host is left out once its new host is listed too.
    withoutMovedHosts(moved = MOVED_HOSTS) {
      for (const [from, to] of Object.entries(moved)) {
        if (!db.prepare("SELECT 1 FROM listings WHERE host = ? LIMIT 1").get(to)) continue;
        db.prepare("DELETE FROM fts WHERE rowid IN (SELECT id FROM listings WHERE host = ?)").run(from);
        db.prepare("DELETE FROM listings WHERE host = ?").run(from);
      }
    },
    close() { try { db.close(); } catch {} rmSync(file, { force: true }); },
  };
}
const inList = (values) => JSON.stringify([...values]);
// How many of the words each listing has: listing id -> count, one index lookup per word (the index keeps no copy of a
// listing's words to read back).
// Each listing's score for the question's words: a rare word counts more than a common one (inverse document
// frequency), so "buy an API call for my agent" ranks a listing about buying above the thousands that only say
// "agent". Before 29 Oct 2026 every word counted 1 and ties went to the cheapest, which buried Fizzl Buy and others.
// `all` is the score of a listing that has every word, so score / all says how much of the question it covers.
function matchCounts(db, terms) {
  const counts = new Map();
  const lookup = db.prepare("SELECT rowid FROM fts WHERE fts MATCH ?");
  const total = db.prepare("SELECT count(*) AS n FROM listings").get().n || 1;
  let all = 0;
  for (const t of terms) {
    const rows = [...lookup.iterate(`"${t}"`)];
    const weight = Math.log(1 + total / Math.max(1, rows.length));
    all += weight;
    for (const { rowid } of rows) counts.set(rowid, (counts.get(rowid) ?? 0) + weight);
  }
  return { counts, all };
}
// Catalog files of another catalog (another process, or this one before a restart) that weren't touched for two hours:
// left behind, since a live catalog writes a new file every hour.
const STALE_MS = 2 * 60 * 60 * 1000;
function removeStale(dir, mine) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith("fizzl-catalog-") || !name.endsWith(".db") || name.startsWith(mine)) continue;
    try { if (Date.now() - statSync(join(dir, name)).mtimeMs > STALE_MS) rmSync(join(dir, name), { force: true }); } catch {}
  }
}

// `seen` keeps when each seller (origin) first appeared ({ getSeen, addSeen }, e.g. store.global), so
// new providers can be marked and listed. The first catalog ever loaded is the baseline: none of it is new.
// `onNew(providers)` is called once with the sellers that appeared since the last load (never for the baseline).
// `trust` (src/trust.js): x402 Doctor's daily track records per seller, to rank and label results.
// `dir`: where the catalog files are written (see createListingsFile); `closeOldAfterMs`: how long the previous file
// stays open after a reload.
export function createCatalog({ url = DISCOVERY_URL, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), seen = null, skills = null, onNew = null, trust = null, ranker = null, dir = tmpdir(), closeOldAfterMs = 60_000 } = {}) {
  let current = null, at = 0, loading = null, firstSeen = {}, loads = 0;
  // A seller's skill.md link and what the injection check found in it (see createSkillChecker).
  const withSkill = (r, origin) => {
    r.skill = skills.known(origin) ? `${origin}/skill.md` : null;
    if (r.skill && skills.review) r.skillCheck = skills.review(origin);
  };
  const mine = `fizzl-catalog-${randomUUID().slice(0, 8)}-`;
  // A copy older than `maxAgeMs` is loaded again, but a search gets the old copy at once while the new one loads:
  // the whole catalog is 100+ pages and takes tens of seconds, and a search that waited for it timed out (Fizzl Buy's
  // catalog search, 24 Oct 2026). Only the first load, and `wait` (the hourly refresh), wait for it. Resolves to the
  // database to read; every query on it runs before the caller's next await.
  async function load({ wait = false, maxAgeMs = TTL_MS } = {}) {
    if (current && now() - at < maxAgeMs) return current.db;
    if (!loading) {
      loading = (async () => {
        const page = async (n) => {
          const res = await fetchImpl(`${url}?type=http&limit=500&offset=${n * 500}`, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`the x402 catalog answered HTTP ${res.status}`);
          return res.json();
        };
        removeStale(dir, mine);
        const file = createListingsFile(join(dir, `${mine}${++loads}.db`));
        try {
          const first = await page(0);
          const items = first.items ?? [];
          file.add(items);
          const total = Number(first.pagination?.total);
          const pages = Number.isFinite(total) && total > 0 ? Math.min(PAGES, Math.ceil(total / 500)) : items.length < 500 ? 1 : PAGES;
          for (let n = 1; n < pages; n += AT_ONCE) {
            const batch = await Promise.all(Array.from({ length: Math.min(AT_ONCE, pages - n) }, (_, i) => page(n + i)));
            let short = false;
            for (const b of batch) { const items = b.items ?? []; file.add(items); short ||= items.length < 500; }
            if (short) break;
          }
          file.withoutMovedHosts();
        } catch (err) { file.close(); throw err; }
        const old = current;
        current = file; at = now();
        // A request that already has the old database still reads it; it is closed a minute later.
        if (old) setTimeout(() => old.close(), closeOldAfterMs).unref();
        const fresh = await track(file.db).catch((err) => { console.warn(`[catalog] tracking new providers: ${err.message}`); return []; });
        if (fresh.length && onNew) announce(file.db, new Set(fresh)).catch((err) => console.warn(`[catalog] new providers: ${err.message}`));
        return file.db;
      })().finally(() => { loading = null; });
      loading.catch((err) => { if (current) console.warn(`[catalog] reload failed, keeping the old copy: ${err.message}`); });
    }
    return current && !wait ? current.db : loading;
  }

  async function track(db) {
    const origins = db.prepare("SELECT DISTINCT origin FROM listings WHERE https = 1").all().map((r) => r.origin);
    const known = seen ? await seen.getSeen() : firstSeen;
    // The very first catalog, and the first time the whole catalog is read (before, only its oldest 10,000 listings):
    // what they add is the baseline, so customers aren't told about a thousand "new" sellers at once.
    const baseline = !Object.keys(known).length || !(WHOLE in known);
    const fresh = {};
    for (const o of origins) if (!(o in known)) fresh[o] = baseline ? 0 : now();
    if (!(WHOLE in known)) fresh[WHOLE] = now();
    if (seen && Object.keys(fresh).length) await seen.addSeen(fresh);
    firstSeen = { ...known, ...fresh };
    return baseline ? [] : Object.keys(fresh);
  }
  // What each new seller offers, for onNew: one summary per origin (sellers without a USDC price are left out).
  function summarize(db, origins) {
    const by = new Map();
    for (const row of db.prepare("SELECT origin, host, description, prices, category FROM listings WHERE cheapest IS NOT NULL AND origin IN (SELECT value FROM json_each(?)) ORDER BY id").iterate(inList(origins))) {
      const prices = JSON.parse(row.prices);
      const p = by.get(row.origin) ?? { origin: row.origin, host: row.host, firstSeen: firstSeen[row.origin], listings: 0, cheapest: Infinity, networks: new Set(), description: "", cats: new Map() };
      p.listings++;
      p.cheapest = Math.min(p.cheapest, ...prices.map((x) => x.usd));
      prices.forEach((x) => p.networks.add(x.network));
      if (!p.description) p.description = row.description.slice(0, 300);
      p.cats.set(row.category, (p.cats.get(row.category) ?? 0) + 1);
      by.set(row.origin, p);
    }
    // A seller's category: the one most of its listings fall in.
    return [...by.values()].map(({ cats, networks, ...p }) => ({ ...p, networks: [...networks], category: [...cats].sort((a, b) => b[1] - a[1])[0][0] }));
  }
  async function announce(db, origins) {
    const providers = summarize(db, origins);
    if (!providers.length) return;
    if (skills) { await skills.check(providers.map((p) => p.origin)); for (const p of providers) withSkill(p, p.origin); }
    await onNew(providers);
  }
  const isNew = (origin, days = 7) => (firstSeen[origin] ?? 0) > now() - days * 86_400_000;

  return {
    // Load the catalog again and wait for it (the server does this hourly, so new sellers are noticed). A copy just
    // under an hour old counts as old here: with the full hour, every other hourly refresh found it 59 minutes old
    // and skipped it, and a search had to start the reload.
    async refresh() { await load({ wait: true, maxAgeMs: TTL_MS - 5 * 60_000 }); await trust?.ready({ waitMs: 30_000 }); },
    // Sellers that appeared in the last `days` days, newest first, with what they offer.
    async newProviders({ days = 7, limit = 30 } = {}) {
      const db = await load();
      const recent = Object.keys(firstSeen).filter((o) => isNew(o, days));
      const by = new Map();
      for (const row of db.prepare("SELECT resource, origin, host, description, prices FROM listings WHERE https = 1 AND cheapest IS NOT NULL AND origin IN (SELECT value FROM json_each(?)) ORDER BY id").iterate(inList(recent))) {
        const prices = JSON.parse(row.prices);
        const p = by.get(row.origin) ?? { origin: row.origin, host: row.host, firstSeen: firstSeen[row.origin], listings: 0, cheapest: Infinity, networks: new Set(), description: "", example: row.resource };
        p.listings++;
        p.cheapest = Math.min(p.cheapest, ...prices.map((x) => x.usd));
        prices.forEach((x) => p.networks.add(x.network));
        if (!p.description) p.description = row.description.slice(0, 300);
        by.set(row.origin, p);
      }
      const providers = [...by.values()].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, limit).map((p) => ({ ...p, networks: [...p.networks] }));
      if (skills && providers.length) {
        await skills.check(providers.map((p) => p.origin));
        for (const p of providers) withSkill(p, p.origin);
      }
      return { days, providers, trackingSince: Math.min(...Object.values(firstSeen).filter((v) => v > 0), now()) };
    },
    // Best matches for a request: { results: [{ url, host, description, method, prices: [{ network, usd }], cheapest }] }.
    // Listing counts per category (and how many from new providers), for the category tiles.
    async categories({ maxUsd = Infinity } = {}) {
      const counts = new Map([...CATEGORIES.map((c) => [c.id, { ...c, count: 0, fresh: 0, sellers: new Set() }]), ["other", { id: "other", name: "Other", icon: "✨", count: 0, fresh: 0, sellers: new Set() }]]);
      const seenUrl = new Set();
      const db = await load();
      for (const row of db.prepare("SELECT origin, path, cheapest, category FROM listings WHERE https = 1 AND cheapest IS NOT NULL ORDER BY id").iterate()) {
        if (row.cheapest > maxUsd || seenUrl.has(`${row.origin}${row.path}`)) continue;
        seenUrl.add(`${row.origin}${row.path}`);
        const c = counts.get(row.category);
        c.count++;
        c.sellers.add(row.origin);
        if (isNew(row.origin)) c.fresh++;
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
      const db = await load();
      // With words, the listings that have any of them (the full-text index); then the filters.
      const where = ["l.https = 1", "l.cheapest IS NOT NULL"], params = [];
      if (terms.length) { where.push("fts MATCH ?"); params.push(terms.map((t) => `"${t}"`).join(" OR ")); }
      if (category) { where.push("l.category = ?"); params.push(category); }
      if (fresh) { where.push("l.origin IN (SELECT value FROM json_each(?))"); params.push(inList(Object.keys(firstSeen).filter((o) => isNew(o)))); }
      const { counts: matched = null, all: allWords = 0 } = terms.length ? matchCounts(db, terms) : {};
      const rows = db.prepare(`SELECT l.id, l.resource, l.origin, l.host, l.path, l.description, l.prices, l.method, e.json AS example, l.category
        FROM ${terms.length ? "fts JOIN listings l ON l.id = fts.rowid" : "listings l"} LEFT JOIN examples e ON e.id = l.example
        WHERE ${where.join(" AND ")} ORDER BY l.id`).iterate(...params);
      for (const row of rows) {
        const prices = JSON.parse(row.prices).filter((p) => !nets || nets.has(p.network));
        if (!prices.length) continue;
        const cheapest = Math.min(...prices.map((p) => p.usd));
        if (cheapest > maxUsd) continue;
        // Without words, everything that passes the filters counts; new providers first, then cheapest.
        const score = matched ? matched.get(row.id) ?? 0 : 1 + (isNew(row.origin) ? 1 : 0);
        if (!score) continue;
        const key = `${row.origin}${row.path}`;
        if (found.has(key) && found.get(key).score >= score) continue;
        // example: the seller's own example input (query parameters or body), so an agent knows how to call it. Kept as
        // JSON until the page of results is cut: a category can have 26,000 listings.
        found.set(key, { score, url: row.resource, host: row.host, description: row.description, method: row.method, example: row.example, prices, cheapest, isNew: isNew(row.origin), category: row.category });
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
      // coverage (with words): the share of the question's words the listing has, rare words weighing more (0 to 1).
      const results = all.slice((at - 1) * per, at * per).map(({ score, ...r }) => ({ ...r, ...(matched && allWords && typeof score === "number" ? { coverage: Math.round(Math.min(1, score / allWords) * 100) / 100 } : {}), example: r.example == null ? null : JSON.parse(r.example) }));
      // Which of these sellers publish a skill.md (cached; unknown ones are checked now, briefly).
      if (skills && results.length) {
        const origins = results.map((r) => new URL(r.url).origin);
        await skills.check(origins);
        for (const r of results) withSkill(r, new URL(r.url).origin);
      }
      // The seller's track record, shown on the card ("paid out 30 of 30 days").
      if (trust) { await trust.ready({ waitMs: 0 }); for (const r of results) r.record = trust.seller(new URL(r.url).origin); }
      return { query: String(query ?? ""), category, results, total: all.length, page: at, pages };
    },
  };
}
