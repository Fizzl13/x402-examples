// The owner's weekly summary on Telegram (Monday morning, Amsterdam time): the last 7 days from the
// Stats tab (website, wallet, the four services, Pro) against the week before, plus refunds still to
// send. Sent once per week; "Send me the weekly summary now" on the Stats tab sends it on demand.

const TZ = "Europe/Amsterdam";

// The Monday (YYYY-MM-DD, Amsterdam) of the week `t` falls in, and whether it's Monday 9:00 or later there.
export function weekOf(t) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const monday = new Date(local - dow * 86_400_000).toISOString().slice(0, 10);
  return { monday, due: dow > 0 || Number(parts.hour) >= 9 };
}

const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
function change(now, before) {
  if (!before && !now) return "";
  if (!before) return " (new)";
  const d = now - before;
  return d === 0 ? " (same)" : ` (${d > 0 ? "+" : ""}${Math.round(d * 100) / 100} vs ${Math.round(before * 100) / 100})`;
}

/** The message text. `summary` is stats.summary(7) (or null when statistics are off). */
export function formatDigest({ summary, refunds = [], dashboardUrl = null }) {
  const L = ["📊 Fizzl weekly summary"];
  if (summary) {
    const k = summary.kpi, p = summary.prev ?? {};
    const revenue = (k.serviceUsd || 0) + (k.proUsd || 0) - (k.refundUsd || 0), prevRevenue = (p.serviceUsd || 0) + (p.proUsd || 0) - (p.refundUsd || 0);
    L[0] += ` · ${summary.from} – ${summary.to}`;
    L.push("");
    L.push(`💰 Revenue: ${money(revenue)}${change(revenue, prevRevenue)}`);
    L.push(`   services ${money(k.serviceUsd)} from ${k.paidCalls} paid call${k.paidCalls === 1 ? "" : "s"} · Pro ${money(k.proUsd)} (${k.pro} payment${k.pro === 1 ? "" : "s"})${k.withdrawals ? ` · refunds −${money(k.refundUsd)}` : ""}`);
    L.push(`🌐 Website visits: ${k.siteViews}${change(k.siteViews, p.siteViews)} · clicks to the wallet: ${k.clicksToWallet}`);
    L.push(`👛 Wallet: ${k.signups} sign-up${k.signups === 1 ? "" : "s"}${change(k.signups, p.signups)} · ${k.agentsAdded} agent${k.agentsAdded === 1 ? "" : "s"} added · ${k.purchases} purchase${k.purchases === 1 ? "" : "s"} by agents (${money(k.spentUsd)})`);
    const top = (summary.services ?? []).filter((s) => s.paid || s.quotes).sort((a, b) => b.usd - a.usd || b.paid - a.paid);
    if (top.length) L.push(`🛠 Services: ${top.map((s) => `${s.name} ${s.paid} paid${s.payers ? ` / ${s.payers} payer${s.payers === 1 ? "" : "s"}` : ""}`).join(" · ")}`);
    const searches = summary.tables?.noResults?.slice(0, 3) ?? [];
    if (searches.length) L.push(`🔎 Searched, nothing found: ${searches.map(([q, n]) => `"${q}" (${n})`).join(", ")}`);
  } else {
    L.push("", "Statistics are off on this server (set USAGE_LOG_TOKEN to get the numbers here).");
  }
  const open = refunds.filter((w) => !w.refundedAt);
  if (open.length) L.push("", `⚠️ Refunds still to send: ${open.length} (${money(open.reduce((s, w) => s + (Number(w.refundUsdc) || 0), 0))}). Mark them refunded on the dashboard once sent.`);
  if (dashboardUrl) L.push("", `Details: ${dashboardUrl.replace(/\/$/, "")}/#/stats`);
  return L.join("\n");
}
