// The owner's Stats tab and outreach to sellers: served only to the signed-in owner (GET /api/admin/owner.js),
// so the public page holds none of it. The dashboard passes its helpers in; me() is the current account.
export function startOwner({ $, esc, api, post, me, DEMO }) {
  // ---------- Stats (owner only): the website, the wallet and the four services, from the usage log ----------
  let statsDays = 30, statsBusy = false;
  const n0 = (v) => (Number(v) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short" });
  // A clean axis top: 1, 2, 5 × 10^n at or above the largest value.
  const niceMax = (m) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)); for (const f of [1, 2, 5, 10]) if (f * p >= m) return f * p; return 10 * p; };
  function columnChart(title, values, days, { money = false } = {}) {
    // The svg is stretched to the card's width (preserveAspectRatio none), so it holds only marks and
    // hairlines; the axis labels are HTML around it and never get distorted.
    const W = 600, H = 100, max = niceMax(Math.max(...values)), slot = W / values.length, bw = Math.min(24, Math.max(2, slot - 2));
    const fmt = (v) => (money ? `$${n0(v)}` : n0(v));
    const total = values.reduce((a, b) => a + b, 0);
    const y = (v) => H - (v / max) * (H - 4);
    const cols = values.map((v, i) => {
      const x = i * slot + (slot - bw) / 2, top = y(v), h = H - top, r = Math.min(4, h, bw / 2);
      const d = h <= 0 ? "" : `M${x},${H} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H} Z`;
      return `<g class="col" tabindex="0" data-tip="${esc(shortDay(days[i]))}|${esc(fmt(v))}"><rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>${d ? `<path class="bar" d="${d}"/>` : ""}</g>`;
    }).join("");
    return `<article class="card chart"><header><b>${esc(title)}</b><span>${esc(fmt(total))} in ${days.length} days</span></header>
      <div class="plot"><span class="ymax">${esc(fmt(max))}</span><span class="yzero">0</span>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)} per day, ${esc(fmt(total))} in total"><line class="grid" x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" vector-effect="non-scaling-stroke"/><line class="grid" x1="0" x2="${W}" y1="${H}" y2="${H}" vector-effect="non-scaling-stroke"/>${cols}</svg></div>
      <div class="xlab"><span>${esc(shortDay(days[0]))}</span><span>${esc(shortDay(days.at(-1)))}</span></div><div class="tip" hidden></div>
      <details><summary>Show as table</summary><table>${days.map((d, i) => `<tr><td>${esc(shortDay(d))}</td><td style="text-align:right">${esc(fmt(values[i]))}</td></tr>`).join("")}</table></details></article>`;
  }
  // The svg is stretched to the card width, so bars are paths (crisp at any width) and the tooltip follows the pointer.
  $("#statsOut").addEventListener("pointermove", (e) => {
    const col = e.target.closest?.("g.col"), card = e.target.closest?.(".chart"); if (!card) return;
    const tip = card.querySelector(".tip");
    if (!col) { tip.hidden = true; return; }
    const [d, v] = col.dataset.tip.split("|"), box = card.getBoundingClientRect(), r = col.getBoundingClientRect();
    tip.innerHTML = `<small>${esc(d)}</small>${esc(v)}`; tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(r.left + r.width / 2 - box.left, 50), box.width - 50)}px`; tip.style.top = `${r.top - box.top + 20}px`;
  });
  $("#statsOut").addEventListener("pointerleave", () => document.querySelectorAll("#statsOut .tip").forEach((t) => { t.hidden = true; }), true);
  $("#statsOut").addEventListener("focusin", (e) => { const col = e.target.closest?.("g.col"); if (col) col.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })); });
  const tableCard = (title, rows, head = "Count", money = false) => `<article class="card stable"><span class="tag">${esc(title)}</span>${rows.length ? `<table><tr><th></th><th>${esc(head)}</th></tr>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(money ? `$${n0(v)}` : n0(v))}</td></tr>`).join("")}</table>` : `<p class="note" style="margin:0">Nothing yet.</p>`}</article>`;
  function deltaTxt(now, before, money = false) {
    if (!before && !now) return `<small>no data yet</small>`;
    const d = now - before;
    return `<small><span class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "▲" : d < 0 ? "▼" : "="} ${esc(money ? `$${n0(Math.abs(d))}` : n0(Math.abs(d)))}</span> vs the ${statsDays} days before</small>`;
  }
  async function loadStats() {
    if (statsBusy || !me()?.admin) return;
    statsBusy = true;
    document.querySelectorAll("#statsSec .seg button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.days) === statsDays)));
    const out = $("#statsOut");
    if (!out.dataset.loaded) out.innerHTML = `<p class="note">Reading the usage log…</p>`;
    try {
      const s = await api("GET", `/api/admin/stats?days=${statsDays}`);
      const k = s.kpi, p = s.prev, rev = k.serviceUsd + k.proUsd - (k.refundUsd || 0), prevRev = p.serviceUsd + p.proUsd - (p.refundUsd || 0);
      const notes = [
        !s.logging.site ? `<b>The website counter hasn't counted anything yet.</b> It is in the pages of fizzl.eu and its subdomains once those are deployed: <code>&lt;script defer src="https://wallet.fizzl.eu/s.js"&gt;&lt;/script&gt;</code>` : "",
        !s.logging.wallet ? `<b>No wallet events yet.</b> Set <code>USAGE_LOG_TOKEN</code> on fizzl-wallet-server in Render (the same token as the other services).` : "",
      ].filter(Boolean);
      const top = s.funnel[0][1] || 0;
      out.innerHTML = `${notes.length ? `<div class="card snote">${notes.map((n) => `<p class="note" style="margin:0">${n}</p>`).join("")}</div>` : ""}
        <div class="kpis">
          <article class="card kpi"><span class="tag">WEBSITE VISITS</span><b>${esc(n0(k.siteViews))}</b>${deltaTxt(k.siteViews, p.siteViews)}</article>
          <article class="card kpi"><span class="tag">WALLET SIGN-UPS</span><b>${esc(n0(k.signups))}</b>${deltaTxt(k.signups, p.signups)}</article>
          <article class="card kpi"><span class="tag">PURCHASES BY AGENTS</span><b>${esc(n0(k.purchases))}</b>${deltaTxt(k.purchases, p.purchases)}</article>
          <article class="card kpi"><span class="tag">REVENUE</span><b>$${esc(n0(rev))}</b>${deltaTxt(rev, prevRev, true)}<small>services $${esc(n0(k.serviceUsd))} · Pro $${esc(n0(k.proUsd))}${k.withdrawals ? ` · ${esc(n0(k.withdrawals))} withdrawal${k.withdrawals === 1 ? "" : "s"}, −$${esc(n0(k.refundUsd))}` : ""}</small></article>
        </div>
        <article class="card funnel"><span class="tag">FROM THE WEBSITE TO PRO · ${esc(shortDay(s.from))} – ${esc(shortDay(s.to))}</span>
          ${s.funnel.map(([label, v]) => `<div class="frow"><span>${esc(label)}</span><span class="track" aria-hidden="true"><i style="width:${top ? Math.max(0.5, (v / top) * 100) : 0}%"></i></span><em>${esc(n0(v))}${top && v !== top ? ` <small>${esc(Math.round((v / top) * 1000) / 10)}%</small>` : ""}</em></div>`).join("")}
          <p class="note" style="margin:0">A sign-up counts as "from the website" when the visitor came through a link on fizzl.eu or a subdomain. No cookies: the site's name travels in the link, nothing about the person.</p>
        </article>
        <div class="charts">
          ${columnChart("Website visits", s.series.siteViews, s.dayKeys)}
          ${columnChart("Wallet sign-ups", s.series.signups, s.dayKeys)}
          ${columnChart("Purchases by agents in the wallet", s.series.purchases, s.dayKeys)}
          ${columnChart("Paid calls to your 4 services", s.series.paidCalls, s.dayKeys)}
          ${columnChart("Revenue (services + Pro)", s.series.revenue, s.dayKeys, { money: true })}
        </div>
        <article class="card stable" style="margin-bottom:14px"><span class="tag">YOUR 4 SERVICES · OUTSIDE USE</span>
          <table><tr><th>Service</th><th>Paid calls</th><th>Revenue</th><th>Price shown (402)</th><th>Payers</th><th>Visitors</th></tr>
          ${s.services.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(n0(x.paid))}</td><td>$${esc(n0(x.usd))}</td><td>${esc(n0(x.quotes))}</td><td>${esc(n0(x.payers))}</td><td>${esc(n0(x.visitors))}</td></tr>`).join("")}</table>
          <p class="note" style="margin:0">Your own wallets and monitors are left out (scripts/known.json in the usage log).</p></article>
        <div class="stables">
          ${tableCard("Top pages", s.tables.pages, "Views")}
          ${tableCard("Where visitors came from", s.tables.from, "Views")}
          ${tableCard("Clicks from the website", s.tables.out, "Clicks")}
          ${tableCard("Where agents bought", s.tables.hosts, "Purchases")}
          ${tableCard("Searches in the wallet", s.tables.searches, "Searches")}
          ${tableCard("Searches that found nothing", s.tables.noResults, "Searches")}
          ${tableCard("Test my setup: what fails", s.tables.setupFails, "Times")}
        </div>`;
      out.dataset.loaded = "1";
    } catch (err) { if (err.message !== "login") out.innerHTML = `<div class="card snote"><p class="note" style="margin:0">${esc(err.message)}</p></div>`; }
    finally { statsBusy = false; }
  }
  $("#statsSec").addEventListener("click", (e) => { const b = e.target.closest(".seg button[data-days]"); if (!b) return; statsDays = Number(b.dataset.days); loadStats(); });

  // ---------- outreach to sellers (owner only) ----------
  const owSay = (t, bad) => { const m = $("#outreachMsg"); m.textContent = t; m.style.color = bad ? "var(--rose)" : ""; };
  async function loadOutreach() {
    if (!me()?.admin || DEMO) return;
    const out = $("#outreachOut");
    try {
      const r = await api("GET", "/api/admin/outreach");
      const head = `<p class="note" style="margin:0 0 8px">${r.enabled ? `From <b style="color:#fff">${esc(r.from)}</b>${r.replyTo ? `, replies to ${esc(r.replyTo)}` : ""} · ${esc(r.sentToday)}/${esc(r.dailyLimit)} sent today` : `<b>Sending is off.</b> Set <code>RESEND_API_KEY</code> and <code>OUTREACH_FROM</code> on this server (and <code>OUTREACH_KEY</code>, the same on x402 Doctor, for drafts from Doctor).`}</p>`;
      const drafts = r.drafts.map((d) => `<div class="card" style="margin:0 0 10px;padding:12px" data-ow="${esc(d.id)}">
          <p class="note" style="margin:0 0 6px">${esc(d.source === "doctor" ? "From x402 Doctor" : "Added by you")}${d.host ? ` · ${esc(d.host)}` : ""} · ${esc(new Date(d.createdAt).toLocaleString())}${d.lastError ? ` · <span style="color:var(--rose)">last try: ${esc(d.lastError)}</span>` : ""}</p>
          <div style="display:grid;gap:6px"><input data-f="to" value="${esc(d.to)}" aria-label="To" maxlength="254"><input data-f="subject" value="${esc(d.subject)}" aria-label="Subject" maxlength="200"><textarea data-f="body" rows="10" aria-label="Text" maxlength="8000">${esc(d.body)}</textarea></div>
          <p style="margin:8px 0 0"><button class="button small" type="button" data-owact="send">Send</button> <button class="link" type="button" data-owact="save">Save changes</button> · <button class="link" type="button" data-owact="discard">Throw away</button></p></div>`).join("");
      const sent = r.sent.length ? `<details style="margin-top:6px"><summary>Sent (${esc(r.sent.length)})</summary><div class="paylist">${r.sent.map((d) => `<div><span>${esc(new Date(d.sentAt).toLocaleDateString())} · ${esc(d.to)}${d.host ? ` · ${esc(d.host)}` : ""}</span><span>${esc(d.subject)}</span></div>`).join("")}</div></details>` : "";
      out.innerHTML = head + (drafts || `<p class="note" style="margin:0">No open drafts.</p>`) + sent;
    } catch (err) { if (err.message !== "login") out.innerHTML = `<p class="note">${esc(err.message)}</p>`; }
  }
  $("#outreachBox").addEventListener("toggle", (e) => { if (e.target.id === "outreachBox" && e.target.open) loadOutreach(); });
  $("#outreachOut").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-owact]"); if (!b) return;
    const card = b.closest("[data-ow]"), id = card.dataset.ow;
    const val = (f) => card.querySelector(`[data-f="${f}"]`).value;
    try {
      if (b.dataset.owact === "discard") { await api("POST", `/api/admin/outreach/${encodeURIComponent(id)}/discard`, {}); owSay("Thrown away."); }
      else {
        await api("PUT", `/api/admin/outreach/${encodeURIComponent(id)}`, { to: val("to"), subject: val("subject"), body: val("body") });
        if (b.dataset.owact === "send") {
          if (!confirm(`Send this e-mail to ${val("to")}? It goes out once and can't be taken back.`)) return;
          await api("POST", `/api/admin/outreach/${encodeURIComponent(id)}/send`, {}); owSay(`Sent to ${val("to")}.`);
        } else owSay("Saved.");
      }
      loadOutreach();
    } catch (err) { if (err.message !== "login") owSay(err.message, true); }
  });
  $("#outreachNew").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/admin/outreach", { to: $("#owTo").value, url: $("#owUrl").value || null, subject: $("#owSubject").value, body: $("#owBody").value });
      if (r.skipped) owSay(r.message, true); else { owSay("Draft saved (also on Telegram)."); e.target.reset(); }
      loadOutreach();
    } catch (err) { if (err.message !== "login") owSay(err.message, true); }
  });
  // Many drafts at once (Claude prepares the list; the owner pastes it): the same rules as one by one.
  $("#outreachImport").addEventListener("submit", async (e) => {
    e.preventDefault();
    let list;
    try {
      const parsed = JSON.parse($("#owImport").value);
      list = Array.isArray(parsed) ? parsed : parsed?.drafts;
      if (!Array.isArray(list) || !list.length) throw new Error();
    } catch { owSay("That isn't a JSON list of drafts.", true); return; }
    if (list.length > 20) { owSay("At most 20 drafts per import.", true); return; }
    let saved = 0;
    const skipped = [];
    for (const d of list) {
      try {
        const r = await api("POST", "/api/admin/outreach", { to: d?.to, url: d?.url || null, subject: d?.subject, body: d?.body });
        if (r.skipped) skipped.push(`${d?.to}: ${r.message}`); else saved++;
      } catch (err) {
        if (err.message === "login") return;
        skipped.push(`${d?.to}: ${err.message}`);
      }
    }
    owSay(`${saved} draft${saved === 1 ? "" : "s"} saved (also on Telegram)${skipped.length ? `; skipped: ${skipped.join("; ")}` : "."}`, skipped.length > 0 && saved === 0);
    if (saved) e.target.reset();
    loadOutreach();
  });
  $("#outreachStop").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { const r = await api("POST", "/api/admin/outreach-stop", { email: $("#owStop").value }); owSay(`${r.stopped} will never be mailed.`); e.target.reset(); loadOutreach(); } catch (err) { if (err.message !== "login") owSay(err.message, true); }
  });
  $("#digestNow").addEventListener("click", async (e) => {
    const b = e.currentTarget, m = $("#digestMsg");
    if (DEMO) { m.textContent = "This is the demo: nothing is sent."; return; }
    b.disabled = true; m.textContent = "Sending…";
    try { await post("/api/admin/digest", {}); m.textContent = "Sent: check Telegram."; }
    catch (err) { m.textContent = err.message; }
    finally { b.disabled = false; }
  });
  return { loadStats };
}
