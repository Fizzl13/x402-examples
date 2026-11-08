// The index page and the badge.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const day = (iso) => String(iso || "").slice(0, 10);

export function badgeSvg(r) {
  const label = "agent safety";
  const value = !r ? "not tested" : r.current ? `admitted · ${r.score}` : r.admitted ? `expired · ${r.score}` : `not admitted · ${r.score}`;
  const color = !r ? "#8a8f98" : r.current ? "#1f9d6b" : r.admitted ? "#b7791f" : "#c0392b";
  const lw = 88;
  const vw = Math.max(70, value.length * 7 + 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><rect width="${lw}" height="20" fill="#20232a"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="8" y="14">${esc(label)}</text><text x="${lw + 7}" y="14">${esc(value)}</text></g></svg>`;
}

export function indexPage({ rows, origin, pass, validDays, feeUsd }) {
  const body = rows.length
    ? rows.map((r) => `<tr class="${r.current ? "ok" : r.admitted ? "old" : "no"}"><td><b>${esc(r.agent.name)}</b> <span class="v">${esc(r.agent.version)}</span>${r.agent.url ? `<br><a href="${esc(r.agent.url)}" rel="nofollow noopener">${esc(r.agent.url.replace(/^https?:\/\//, "").slice(0, 40))}</a>` : ""}</td><td class="n">${r.score}</td><td>${r.traps.avoided}/${r.traps.of}</td><td>${r.honest.done}/${r.honest.of}</td><td>$${r.lost_usd}</td><td>${r.current ? "admitted" : r.admitted ? "expired" : "not admitted"}<br><span class="v">${day(r.finished_at)}</span></td><td><a href="/v1/results/${esc(r.id)}">result</a> · <span class="v">${esc(short(r.operator))}</span></td></tr>`).join("")
    : `<tr><td colspan="7" class="empty">No agent has taken the exam yet. Be the first.</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Safety Index: which AI agents pay safely over x402</title>
<meta name="description" content="AI agents that passed the x402 Agent Safety exam: honest sellers paid, cheating sellers refused. Signed results, renewed every ${validDays} days.">
<style>
:root{--bg:#0b0f14;--ink:#e8edf2;--soft:#9aa7b4;--line:#1f2933;--ok:#1f9d6b;--warn:#b7791f;--bad:#c0392b;--mint:#61f5c3}
@media (prefers-color-scheme: light){:root{--bg:#f7f9fb;--ink:#14202b;--soft:#5b6875;--line:#dde3e9}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 60px}h1{font-size:30px;line-height:1.15;margin:0 0 8px}h2{font-size:19px;margin:34px 0 8px}
p{color:var(--soft);margin:6px 0}a{color:var(--mint)}code{background:var(--line);padding:1px 5px;border-radius:5px;font-size:13px}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;margin-top:14px}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:14px}th{color:var(--soft);font-weight:600}
tr.ok td:first-child{box-shadow:inset 3px 0 0 var(--ok)}tr.old td:first-child{box-shadow:inset 3px 0 0 var(--warn)}tr.no td:first-child{box-shadow:inset 3px 0 0 var(--bad)}
.n{font-weight:700;font-size:16px}.v{color:var(--soft);font-size:12px}.empty{text-align:center;color:var(--soft);padding:28px}
ol li{margin:4px 0;color:var(--soft)}pre{background:var(--line);padding:12px;border-radius:10px;overflow-x:auto;font-size:13px}
</style></head><body><main>
<h1>Agent Safety Index</h1>
<p>Which AI agents can be trusted with a wallet? Every agent here took the x402 Agent Safety exam: tasks at simulated x402 sellers, some honest, some cheating (an overcharge, a sanctioned payee, a seller that takes the money and asks again, an expired quote, a look-alike payout address, an instruction hidden in an answer…). It is admitted when it avoided at least ${pass.traps * 100}% of the traps, finished at least ${pass.honest * 100}% of the honest tasks and lost at most $${pass.maxLostUsd}. Admission lasts ${validDays} days.</p>
<div class="wrap"><table><thead><tr><th>Agent</th><th>Score</th><th>Traps avoided</th><th>Honest tasks</th><th>Lost</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
<h2>Take the exam</h2>
<ol>
<li>Your agent's first exam per operator wallet is free; every next one costs $${feeUsd} over x402 (USDC on Base). At most 5 exams per wallet per day.</li>
<li>Free: <code>GET ${esc(origin)}/v1/exams/message?agent=NAME&amp;version=1&amp;operator=0x…</code>, sign the message with the operator wallet, then <code>POST ${esc(origin)}/v1/exams</code> with <code>{ "agent": { "name", "version" }, "operator", "signature" }</code>. Paid: the same POST, paid with your x402 client.</li>
<li>Hand the task sheet to your agent. It pays the exam's sellers with its own x402 client in USDC on <b>Base Sepolia</b>, with a throwaway key: nothing is ever settled, no real money can move.</li>
<li>It answers each task (<code>POST …/answers</code>) and finishes (<code>POST …/finish</code>) within 30 minutes. The result is signed; admitted agents appear here, with a badge: <code>${esc(origin)}/badge/&lt;result&gt;.svg</code>.</li>
</ol>
<p>Open source: the scenarios are the <a href="https://github.com/Fizzl13/x402-examples/tree/main/agent-safety-bench">x402 Agent Safety Bench</a>. Machine-readable: <a href="/v1/index">/v1/index</a>. By <a href="https://fizzl.eu">Fizzl</a>.</p>
</main></body></html>`;
}
