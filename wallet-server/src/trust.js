// Track records from x402 Doctor's public Trust Index: every endpoint in the x402 catalog is
// checked daily like a paying agent would (without paying), and the last 30 days are published
// as one letter per day (g = go, c = caution, n = no go, x = broken, - = not checked). Here they
// are summed up per seller (origin), so the search bar can put sellers that keep working first.
// Loaded on first use and every 6 hours; unknown sellers are simply unknown (null).
// Read from the index in parts (index/meta.json lists them; each part has one [key, resource] per line), one part at a
// time and line by line: the same index as one JSON file was 42 MB on 25 Oct 2026 and grows, and parsing it at once
// took this 512 MB server down (22 Oct 2026, exit status 134). index.ndjson (a header line, then the same lines in one
// file) while the branch has no parts yet.
export const TRUST_INDEX_URL = "https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index/meta.json";
const TRUST_INDEX_NDJSON_URL = "https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index.ndjson";
const TTL_MS = 6 * 60 * 60 * 1000;

// One resource's track record, added to its seller's totals.
function add(by, key, entry) {
  let origin; try { origin = new URL(key).origin; } catch { return; }
  const seen = [...String(entry?.h ?? "")].filter((c) => c !== "-");
  if (!seen.length) return;
  const ok = seen.filter((c) => c === "g" || c === "c").length;
  const s = by.get(origin) ?? { checks: 0, payable: 0, days: 0, payableDays: 0 };
  s.checks += seen.length; s.payable += ok;
  if (seen.length > s.days || (seen.length === s.days && ok > s.payableDays)) { s.days = seen.length; s.payableDays = ok; }
  by.set(origin, s);
}
const totals = (by) => new Map([...by].map(([o, s]) => [o, { days: s.days, payableDays: s.payableDays, ratio: Math.round((s.payable / s.checks) * 100) / 100 }]));

export function summarizeIndex(index) {
  const by = new Map();
  for (const [key, entry] of Object.entries(index?.resources ?? {})) add(by, key, entry);
  return totals(by);
}

// The same from a response body, as it arrives: one line at a time. A line that is a whole index ({ resources })
// counts too, so index.json (small ones, in tests) still works.
export async function summarizeBody(body) {
  const by = new Map();
  await addBody(by, body);
  return totals(by);
}

async function addBody(by, body) {
  const line = (text) => {
    if (!text.trim()) return;
    let row; try { row = JSON.parse(text); } catch { return; }
    if (Array.isArray(row)) add(by, row[0], row[1]);
    else if (row?.resources) for (const [key, entry] of Object.entries(row.resources)) add(by, key, entry);
  };
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = parts.pop();
    for (const p of parts) line(p);
  }
  line(rest + decoder.decode());
}

// The published index: each part of index/meta.json in turn, or index.ndjson while there are no parts.
async function summarizePublished(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) {
    const single = await fetchImpl(TRUST_INDEX_NDJSON_URL, { signal: AbortSignal.timeout(30_000) });
    if (!single.ok) throw new Error(`trust index HTTP ${single.status}`);
    return summarizeBody(single.body);
  }
  if (!res.ok) throw new Error(`trust index HTTP ${res.status}`);
  const meta = await res.json();
  if (!Array.isArray(meta?.parts)) return summarizeIndex(meta);
  const by = new Map();
  for (const part of meta.parts) {
    const p = await fetchImpl(new URL(part, url).href, { signal: AbortSignal.timeout(30_000) });
    if (!p.ok) throw new Error(`trust index part ${part} HTTP ${p.status}`);
    await addBody(by, p.body);
  }
  return totals(by);
}

export function createTrustIndex({ url = TRUST_INDEX_URL, fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let sellers = null, at = 0, loading = null;
  function refresh() {
    loading ??= (async () => {
      if (url === TRUST_INDEX_URL) sellers = await summarizePublished(fetchImpl, url);
      else {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`trust index HTTP ${res.status}`);
        sellers = await summarizeBody(res.body);
      }
      at = now();
    })().catch((err) => { console.warn(`[trust] ${err.message}`); at = now() - TTL_MS + 600_000; }) // retry in 10 minutes
      .finally(() => { loading = null; });
    return loading;
  }
  return {
    // Load if old; waits at most `waitMs` the first time (the answer stays "unknown" meanwhile).
    async ready({ waitMs = 3000 } = {}) {
      if (now() - at < TTL_MS) return;
      const pending = refresh();
      if (!sellers) await Promise.race([pending, new Promise((ok) => setTimeout(ok, waitMs))]);
    },
    // { days, payableDays, ratio } for a seller, or null when Doctor hasn't checked it.
    seller: (origin) => sellers?.get(origin) ?? null,
    // 2: proven (paid out on at least 90% of checks over 5+ days); 1: unknown or mostly fine; 0: often failing.
    tier(origin) {
      const s = sellers?.get(origin);
      if (!s) return 1;
      if (s.ratio >= 0.9 && s.days >= 5) return 2;
      return s.ratio >= 0.6 ? 1 : 0;
    },
  };
}
