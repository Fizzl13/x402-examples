// The demo page: one EventSource for the shared run, the inbox and conversation built from its events.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let config = null, mode = "fooled", token = null, view = 0;
let pinned = false; // a click on an email keeps it in view while the run goes on
let S = null; // the run as the page sees it

const fresh = (meta = {}) => ({ meta, mails: [], per: [], ledger: [], approval: null, done: false, error: null });

function pick(m) {
  mode = m;
  document.querySelectorAll(".opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === m)));
  $("#codeWrap").hidden = m !== "careful";
}

function chipFor(i) {
  const p = S.per[i];
  if (!p) return `<span class="chip">waiting</span>`;
  const g = p.guard;
  if (S.approval && S.approval.mail === i && !S.approval.done) return `<span class="chip ask">asking the owner</span>`;
  if (g.some((e) => e.outcome === "blocked")) return `<span class="chip no">stopped by the guard</span>`;
  if (g.some((e) => e.outcome === "done" && e.decision === "ask")) return `<span class="chip ask">refunded, owner approved</span>`;
  if (g.some((e) => e.outcome === "done")) return `<span class="chip ok">refunded</span>`;
  if (p.reply !== null) return `<span class="chip ok">answered</span>`;
  return `<span class="chip work">working…</span>`;
}

function renderInbox() {
  $("#inbox").innerHTML = S.mails.map((m, i) => `<li data-i="${i}" class="${i === view ? "on" : ""}"><div class="from">${esc(m.from)}</div><div class="subj">${esc(m.subject)}</div>${chipFor(i)}</li>`).join("") || `<li class="empty">Waiting for the shop to open…</li>`;
}

function verdictCard(e) {
  const cls = e.outcome === "blocked" ? "no" : e.decision === "ask" ? "ask" : "ok";
  const title = e.outcome === "blocked" ? (e.decision === "deny" ? "Guard: blocked" : "Guard: not approved") : e.outcome === "asked" ? "Guard: over the limit, asking the owner" : e.outcome === "failed" ? "PayPal refused it" : e.decision === "ask" ? `Guard: approved by ${esc(e.approvedBy || "the owner")}, done` : "Guard: within the rules, done";
  // A deny shows what stopped it; limits it would also have passed don't matter then.
  const reasons = e.decision === "deny" && e.reasons?.some((r) => r.stops) ? e.reasons.filter((r) => r.stops) : e.reasons ?? [];
  return `<div class="verdict ${cls}"><div class="t">${title}</div><div>${esc(e.summary)}</div>${reasons.length ? `<ul>${reasons.map((r) => `<li>${esc(r.message)}</li>`).join("")}</ul>` : ""}</div>`;
}

function renderConv() {
  const m = S.mails[view], p = S.per[view];
  $("#convTitle").textContent = m ? `Conversation · ${m.from}` : "Conversation";
  if (!m) { $("#conv").innerHTML = `<p class="empty">${S.error ? esc(S.error) : "Run the inbox to see the agent at work."}</p>`; return; }
  const parts = [`<div class="mail"><b>${esc(m.subject)}</b>\n${esc(m.body)}</div>`];
  for (const x of p?.steps ?? []) {
    if (x.kind === "tool") parts.push(`<div class="step">Agent calls <code>${esc(x.tool)}</code>${x.tool === "create_refund" ? ` · ${esc(x.input?.amount ? `${x.input.amount.value} ${x.input.amount.currency_code}` : "the whole payment")} on capture <code>${esc(x.input?.capture_id)}</code>` : ""}</div>`);
    if (x.kind === "guard") parts.push(verdictCard(x.e));
    if (x.kind === "thinking") parts.push(`<div class="step">${esc(S.meta.mode === "careful" ? "Claude is reading…" : "The agent reads the email…")}</div>`);
  }
  if (p?.reply !== null && p?.reply !== undefined) parts.push(`<div class="reply"><span class="who">Reply to ${esc(m.from)}</span>${esc(p.reply)}</div>`);
  $("#conv").innerHTML = parts.join("");
}

function renderPhone() {
  const a = S.approval;
  if (!a) { $("#screen").innerHTML = `<p class="idle">Nothing waits for the owner.</p>`; return; }
  const mineToAnswer = a.channel === "page" && token && !a.done && S.meta.live;
  const left = a.done ? "" : `<div class="left">${a.channel === "telegram" ? "Sent to the owner's real Telegram (Fizzl wallet bot)." : mineToAnswer ? "You started this run: you answer for the owner." : "Waiting for the owner's tap."}</div>`;
  $("#screen").innerHTML = `<div class="tg"><div class="bot">Fizzl Agent Wallet</div><p><b>Support agent wants to do something in PayPal that needs your OK</b></p><p>${esc(a.summary)}</p>${a.customer ? `<p>customer: <code>${esc(a.customer)}</code></p>` : ""}<ul>${(a.reasons || []).map((r) => `<li>${esc(r.message)}</li>`).join("")}</ul>${a.request ? `<p><i>“${esc(a.request)}”</i></p>` : ""}${a.done ? `<div class="done" style="color:${a.approved ? "var(--mint)" : "var(--rose)"}">${a.approved ? "✅ Approved" : "❌ Not approved"} · ${esc(a.by)}</div>` : `<div class="btns"><button type="button" data-d="approve" ${mineToAnswer ? "" : "disabled"}>✅ Approve</button><button type="button" data-d="deny" ${mineToAnswer ? "" : "disabled"}>❌ Deny</button></div>`}${left}</div>`;
}

function renderLedger() {
  $("#ledger").innerHTML = S.ledger.map((l) => {
    const pct = l.paid ? Math.min(100, (Number(l.refunded || 0) / Number(l.paid)) * 100) : 0;
    return `<li><div class="row"><span>${esc(l.item)} · ${esc(l.customer)}</span></div><div class="row"><span>paid $${esc(l.paid)}</span><span>refunded $${esc(l.refunded)}</span></div><div class="bar"><i style="width:${pct}%"></i></div></li>`;
  }).join("") || `<li class="empty">No orders yet.</li>`;
}

function render() { renderInbox(); renderConv(); renderPhone(); renderLedger(); renderStatus(); }

function renderStatus() {
  const live = S.meta.live && !S.done;
  $("#runBtn").disabled = live;
  const what = config ? `PayPal ${config.paypal === "sandbox" ? "sandbox (test money)" : "simulated in memory"}` : "";
  const who = S.meta.mode === "careful" ? "Claude agent" : "fooled agent";
  $("#status").textContent = S.error ? `Stopped: ${S.error}` : live ? `Running · ${who} · ${what}` : S.done ? `Done · ${who} · ${what}. Pick an email to see what happened.` : S.meta.at ? `Showing the last run (${who}). ${what}.` : `${what}.`;
}

function on(e) {
  if (e.type === "run") { S = fresh(e); view = 0; pinned = false; render(); return; }
  if (!S) S = fresh({});
  const per = (i) => (S.per[i] ??= { steps: [], guard: [], reply: null });
  switch (e.type) {
    case "orders": S.ledger = e.ledger; break;
    case "ledger": case "done": S.ledger = e.ledger; if (e.type === "done") S.done = true; break;
    case "inbox": S.mails = e.mails; break;
    case "mail": per(e.mail); if (S.meta.live && !pinned) view = e.mail; break;
    case "thinking": { const p = per(e.mail); if (p.steps.at(-1)?.kind !== "thinking") p.steps.push({ kind: "thinking" }); break; }
    case "tool": per(e.mail).steps.push({ kind: "tool", tool: e.tool, input: e.input }); break;
    case "guard": { const p = per(e.mail); p.guard.push(e); p.steps.push({ kind: "guard", e }); if (e.outcome === "asked") S.approval = { ...(S.approval || {}), mail: e.mail }; break; }
    case "approval": S.approval = { ...e, mail: S.approval?.mail ?? view, done: false }; break;
    case "approval-done": if (S.approval) Object.assign(S.approval, { done: true, approved: e.approved, by: e.by }); break;
    case "reply": per(e.mail).reply = e.text; break;
    case "error": S.error = e.message; break;
    case "end": S.done = true; S.meta.live = false; token = null; break;
  }
  render();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onmessage = (m) => on(JSON.parse(m.data));
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}

$("#inbox").addEventListener("click", (ev) => { const li = ev.target.closest("li[data-i]"); if (!li) return; view = Number(li.dataset.i); pinned = true; render(); });
document.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => pick(b.dataset.mode)));
$("#runBtn").addEventListener("click", async () => {
  $("#runBtn").disabled = true;
  try {
    const r = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, code: $("#code").value }) });
    const j = await r.json();
    if (!r.ok) { $("#status").textContent = j.message || "Couldn't start."; $("#runBtn").disabled = false; return; }
    token = j.token;
    render(); // an approval may have arrived before the token
  } catch { $("#runBtn").disabled = false; }
});
$("#screen").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-d]"); if (!b || !S?.approval) return;
  document.querySelectorAll(".tg button").forEach((x) => (x.disabled = true));
  await fetch("/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: S.approval.id, decision: b.dataset.d, token }) }).catch(() => {});
});

config = await fetch("/api/config").then((r) => r.json()).catch(() => null);
$("#ppMode").textContent = config?.paypal === "sandbox" ? "sandbox" : "simulated";
pick(config?.claude ? "careful" : "fooled");
S = fresh({});
render();
connect();
