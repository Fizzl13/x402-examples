// The owner's Stats tab: reads the private usage-log repo (events/<service>/<day>.jsonl, written by
// the wallet, the website counter and the four x402 services) and sums it up per day. Your own wallets
// and monitors (scripts/known.json in that repo) and your own wallet accounts are left out.
// Files are cached by their git sha, so a refresh only downloads days that changed (normally today).
const API = "https://api.github.com";
const SERVICES = ["ichimoku", "presign", "doctor", "plaintext"];
const NAMES = { ichimoku: "Ichimoku Signal", presign: "presign-guard", doctor: "x402 Doctor", plaintext: "PlainText" };
const DAY = 86_400_000;

// Only the fields the summary needs, so a month of logs stays small in memory.
const KEEP_INPUT = ["host", "kind", "from", "q", "cat", "chain", "network", "months", "path", "site", "to", "ref", "pair", "url"];
const KEEP_RESULT = ["outcome", "total", "decision", "via", "seconds", "fail", "ready", "agents"];
function slim(e) {
  const pick = (o, keys) => (o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : undefined);
  return { t: e.t, service: e.service, route: e.route, status: e.status, paid: e.paid, quote: e.quote, usd: e.usd, payer: e.payer, agent: e.agent, own: e.own, acct: e.acct, via: e.via, ref: e.ref, visitor: e.visitor, input: pick(e.input, KEEP_INPUT), result: pick(e.result, KEEP_RESULT) };
}
const count = (list, key) => {
  const m = new Map();
  for (const e of list) { const k = key(e); if (k !== undefined && k !== null && k !== "") m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
};
const round2 = (n) => Math.round(n * 100) / 100;

export function createStats({ token = null, repo = "Fizzl13/usage-log", fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = 5 * 60_000 } = {}) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "fizzl-wallet-stats" };
  const files = new Map(); // sha -> slim events
  const summaries = new Map(); // days -> { at, value }
  let known = { at: 0, own: new Set(), monitor: /bot|crawl|spider|scan|monitor|health|probe/i, probePairs: new Set() };

  const get = async (path, raw = false) => {
    const res = await fetchImpl(`${API}/repos/${repo}/contents/${path}`, { headers: raw ? { ...headers, accept: "application/vnd.github.raw" } : headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`usage log ${path}: HTTP ${res.status}`);
    return raw ? res.text() : res.json();
  };
  async function loadKnown() {
    if (now() - known.at < 60 * 60_000) return known;
    try {
      const k = JSON.parse((await get("scripts/known.json", true)) ?? "{}");
      known = { at: now(), own: new Set((k.own_wallets ?? []).map((w) => String(w).toLowerCase())), monitor: new RegExp(k.monitor_agents || "bot|crawl|spider|scan|monitor", "i"), probePairs: new Set((k.probe_pairs ?? []).map((p) => String(p).toUpperCase())) };
    } catch { known.at = now(); }
    return known;
  }
  // Every event of one service from `fromDay` on.
  async function events(service, fromDay) {
    const list = (await get(`events/${service}`)) ?? [];
    const wanted = list.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.name) && f.name.slice(0, 10) >= fromDay);
    const out = [];
    for (let i = 0; i < wanted.length; i += 6) {
      await Promise.all(wanted.slice(i, i + 6).map(async (f) => {
        if (!files.has(f.sha)) {
          const text = (await get(`events/${service}/${f.name}`, true)) ?? "";
          files.set(f.sha, text.split("\n").filter(Boolean).map((l) => { try { return slim(JSON.parse(l)); } catch { return null; } }).filter(Boolean));
          if (files.size > 1500) files.delete(files.keys().next().value);
        }
        out.push(...files.get(f.sha));
      }));
    }
    return out;
  }

  async function build(days) {
    const end = new Date(new Date(now()).toISOString().slice(0, 10) + "T00:00:00Z").getTime() + DAY; // end of today
    const from = end - days * DAY, prevFrom = from - days * DAY;
    const dayKeys = Array.from({ length: days }, (_, i) => new Date(from + i * DAY).toISOString().slice(0, 10));
    const k = await loadKnown();
    const [wallet, site, ...svc] = await Promise.all([events("wallet", new Date(prevFrom).toISOString().slice(0, 10)), events("site", new Date(prevFrom).toISOString().slice(0, 10)), ...SERVICES.map((s) => events(s, new Date(prevFrom).toISOString().slice(0, 10)))]);
    const outside = (e) => !e.own && !(e.payer && k.own.has(String(e.payer).toLowerCase())) && !(e.agent && k.monitor.test(e.agent)) && !(e.input?.pair && k.probePairs.has(String(e.input.pair).toUpperCase())) && !/^__verifymcp/.test(e.route || "");
    const window = (list, a, b) => list.filter((e) => e.t >= new Date(a).toISOString() && e.t < new Date(b).toISOString() && outside(e));
    const perDay = (list, pick = () => 1) => { const m = new Map(dayKeys.map((d) => [d, 0])); for (const e of list) { const d = e.t.slice(0, 10); if (m.has(d)) m.set(d, m.get(d) + pick(e)); } return [...m.values()].map(round2); };

    function period(a, b) {
      const W = window(wallet, a, b), S = window(site, a, b), X = svc.map((list) => window(list, a, b));
      const w = (route) => W.filter((e) => e.route === route);
      const views = S.filter((e) => e.route === "view"), outs = S.filter((e) => e.route === "out");
      const ok = w("purchase").filter((e) => e.result?.outcome === "ok");
      const paid = X.flat().filter((e) => e.paid);
      const fromSite = (e) => Boolean(e.ref || e.input?.ref);
      return {
        W, S, X, views, outs, ok, paid,
        kpi: {
          siteViews: views.length,
          clicksToWallet: outs.filter((e) => e.input?.to === "wallet.fizzl.eu").length,
          walletVisits: w("page").filter((e) => e.agent === "browser").length,
          signups: w("signup").length,
          agentsAdded: w("agent_added").length,
          purchases: ok.length,
          spentUsd: round2(ok.reduce((s, e) => s + (Number(e.usd) || 0), 0)),
          pro: w("pro_paid").length,
          proUsd: round2(w("pro_paid").reduce((s, e) => s + (Number(e.usd) || 0), 0)),
          paidCalls: paid.length,
          serviceUsd: round2(paid.reduce((s, e) => s + (Number(e.usd) || 0), 0)),
        },
        funnel: [
          ["Website visits", views.length],
          ["Clicks to the wallet", outs.filter((e) => e.input?.to === "wallet.fizzl.eu").length],
          ["Wallet visits from the website", w("page").filter((e) => e.agent === "browser" && fromSite(e)).length],
          ["Sign-ups from the website", w("signup").filter(fromSite).length],
          ["Agents added (website sign-ups)", w("agent_added").filter(fromSite).length],
          ["Purchases (website sign-ups)", ok.filter(fromSite).length],
          ["Pro (website sign-ups)", w("pro_paid").filter(fromSite).length],
        ],
      };
    }
    const cur = period(from, end), prev = period(prevFrom, from);
    const searches = cur.W.filter((e) => e.route === "search");
    const sv = SERVICES.map((s, i) => {
      const list = cur.X[i], paid = list.filter((e) => e.paid);
      return { id: s, name: NAMES[s], paid: paid.length, usd: round2(paid.reduce((n, e) => n + (Number(e.usd) || 0), 0)), quotes: list.filter((e) => e.quote).length, payers: new Set(paid.map((e) => e.payer).filter(Boolean)).size, visitors: new Set(list.map((e) => e.visitor).filter(Boolean)).size };
    });
    return {
      days, from: dayKeys[0], to: dayKeys.at(-1), dayKeys,
      logging: { wallet: wallet.length > 0, site: site.length > 0, services: svc.some((l) => l.length) },
      kpi: cur.kpi, prev: prev.kpi,
      series: {
        siteViews: perDay(cur.views),
        signups: perDay(cur.W.filter((e) => e.route === "signup")),
        purchases: perDay(cur.ok),
        paidCalls: perDay(cur.paid),
        revenue: perDay([...cur.paid, ...cur.W.filter((e) => e.route === "pro_paid")], (e) => Number(e.usd) || 0),
      },
      funnel: cur.funnel,
      services: sv,
      tables: {
        pages: count(cur.views, (e) => `${e.input?.site ?? e.via ?? ""}${e.input?.path ?? ""}`).slice(0, 12),
        sites: count(cur.views, (e) => e.input?.site ?? e.via).slice(0, 8),
        out: count(cur.outs, (e) => e.input?.to).slice(0, 10),
        hosts: count(cur.ok, (e) => e.input?.host).slice(0, 10),
        searches: count(searches, (e) => e.input?.q || (e.input?.cat ? `[${e.input.cat}]` : null)).slice(0, 12),
        noResults: count(searches.filter((e) => e.result?.total === 0), (e) => e.input?.q || (e.input?.cat ? `[${e.input.cat}]` : null)).slice(0, 12),
        setupFails: count(cur.W.filter((e) => e.route === "setup_check").flatMap((e) => String(e.result?.fail || "").split(",").filter((x) => x && x !== "none").map((id) => ({ id }))), (x) => x.id),
        clicks: count(cur.W.filter((e) => e.route === "click"), (e) => e.input?.kind),
      },
    };
  }

  return {
    enabled: Boolean(token),
    async summary(days = 30) {
      if (!token) throw Object.assign(new Error("Set USAGE_LOG_TOKEN on this server to see the statistics."), { status: 503 });
      const d = [7, 30].includes(Number(days)) ? Number(days) : 30;
      const c = summaries.get(d);
      if (c && now() - c.at < cacheMs) return c.value;
      const value = await build(d);
      summaries.set(d, { at: now(), value });
      return value;
    },
  };
}
