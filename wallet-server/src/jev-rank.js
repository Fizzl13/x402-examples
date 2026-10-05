// Search ranked by meaning: TypeSafe's Jev scores how well each of the best keyword matches answers what
// the person or agent asked ("is this token safe?" puts a token checker first even when its description
// says "honeypot", not "safe"). One request for up to 40 candidates; answers cached per query for 10 minutes.
// Off without TYPESAFE_API_KEY; on a timeout or error the keyword order stays.
const API = "https://api.typesafe.ai/v1/systemone";
const LEVELS = [
  "Unrelated: does something else than what the query asks",
  "Loosely related: same area, but not what the query asks",
  "Partly answers the query",
  "Does exactly what the query asks",
];

export function createRanker({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 2500, max = 40, model = process.env.JEV_MODEL || "jev-latest", now = () => Date.now(), log = console } = {}) {
  const cache = new Map(); // `${query}\n${urls}` -> { at, scores }
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== "off";

  // results: [{ url, host, description, ... }] in keyword order. Returns the same items, the first `max`
  // reordered by Jev's score (ties keep the keyword order), the rest after them unchanged.
  async function rank(query, results) {
    if (!enabled || !query || results.length < 2) return results;
    const head = results.slice(0, max), tail = results.slice(max);
    const key = `${query.toLowerCase()}\n${head.map((r) => r.url).join(" ")}`;
    let hit = cache.get(key);
    if (!hit || now() - hit.at > 600_000) {
      const questions = {};
      head.forEach((r, i) => {
        questions[`c${i}`] = {
          type: "score",
          instructions: { service: { host: r.host, description: (r.description || "").slice(0, 300), method: r.method || null }, question: "How well does `service` do what `query` asks for? Judge by what the service does, not by shared words." },
          criteria: LEVELS,
        };
      });
      try {
        const res = await fetchImpl(API, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, state: { query }, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { log.warn?.(`[jev] search HTTP ${res.status}`); return results; }
        const answers = (await res.json())?.answers ?? {};
        const scores = head.map((_, i) => (typeof answers[`c${i}`]?.score === "number" ? answers[`c${i}`].score : null));
        if (scores.every((s) => s === null)) return results;
        hit = { at: now(), scores };
        cache.set(key, hit);
        if (cache.size > 300) cache.delete(cache.keys().next().value);
      } catch (err) {
        log.warn?.(`[jev] search ${err.name}: ${err.message}`);
        return results;
      }
    }
    const order = head.map((r, i) => ({ r, i, s: hit.scores[i] ?? -1 })).sort((a, b) => b.s - a.s || a.i - b.i);
    return [...order.map((o) => ({ ...o.r, relevance: o.s >= 0 ? Math.round((o.s / 3) * 100) / 100 : null })), ...tail];
  }

  return { enabled, rank };
}
