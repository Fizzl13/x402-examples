// Outreach for the owner: short, one-off e-mails to sellers whose paid endpoint is broken, offering the
// fix and the Fizzl gateway pilot. Nothing goes out by itself: a draft is made (by x402 Doctor when someone
// checks a broken endpoint that publishes a contact address, or by the owner on the dashboard), the owner
// gets it on Telegram and the dashboard, and only their "Send" mails it.
//
// Rules, enforced here whatever the caller asks:
//   - one e-mail per address, ever (also after a "stop" reply, which the owner records with stop());
//   - at most `dailyLimit` e-mails per UTC day;
//   - one open draft per address and per host (a second report on the same seller is dropped);
//   - every mail ends with a line saying why they got it and that "stop" ends it;
//   - drafts are kept in the server's store (Redis), never in git or the usage log.
import { randomBytes } from "node:crypto";

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,24}$/i;
const MAX_FINDINGS = 4;
const DRAFT_DAYS = 30;

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

// The HTML twin of a plain-text mail: the same words (links clickable), and the Fizzl mail icon next to the
// signature. Clients that block images still show the text; clients without HTML get the plain version.
export function toHtml(text, { logoUrl = null } = {}) {
  const lines = String(text).split("\n");
  const cut = lines.lastIndexOf("--"); // footer starts at the "--" line
  const main = cut >= 0 ? lines.slice(0, cut) : lines;
  const foot = cut >= 0 ? lines.slice(cut + 1).join(" ") : "";
  const linkify = (s) => escapeHtml(s).replace(/https:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (u) => `<a href="${u.replace(/"/g, "&quot;")}" style="color:#0b8a63">${u}</a>`);
  while (main.length && !main[main.length - 1].trim()) main.pop();
  // the last two lines are the sign-off ("Cheers," / "Frits (Fizzl)"): they go next to the icon
  const sign = main.length >= 2 ? main.splice(-2) : [];
  while (main.length && !main[main.length - 1].trim()) main.pop();
  const paras = main.join("\n").split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.split("\n").map(linkify).join("<br>")}</p>`).join("");
  const signature = sign.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 0"><tr>${logoUrl ? `<td style="padding:0 12px 0 0;vertical-align:middle"><img src="${escapeAttr(logoUrl)}" width="52" height="52" alt="Fizzl" style="display:block;border:0;border-radius:50%"></td>` : ""}<td style="vertical-align:middle;line-height:1.4">${sign.map(linkify).join("<br>")}</td></tr></table>` : "";
  const footer = foot ? `<p style="margin:26px 0 0;padding-top:12px;border-top:1px solid #e3e8e6;color:#6b7774;font-size:12px">${linkify(foot)}</p>` : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff"><div style="max-width:600px;padding:20px;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14201d">${paras}${signature}${footer}</div></body></html>`;
}

// The mail Doctor's findings turn into. Kept here so the wording lives in one place.
export function composeFromFindings({ host, url, findings, reportUrl, gatewayUrl = "https://fizzl.eu/gateway/" }) {
  const list = findings.slice(0, MAX_FINDINGS);
  const items = list.map((f, i) => `${i + 1}. ${clean(f.message, 400)}${f.hint ? `\n   Fix: ${clean(f.hint, 300)}` : ""}`).join("\n");
  const more = findings.length > list.length ? `\n(and ${findings.length - list.length} more in the report)` : "";
  return {
    subject: `x402 Doctor found ${findings.length === 1 ? "an issue" : `${findings.length} issues`} on ${host}`,
    body: [
      "Hi,",
      "",
      `I run x402 Doctor, a checker for paid agent APIs. Someone ran ${url} through it, and it found:`,
      "",
      `${items}${more}`,
      "",
      `Full report (free): ${reportUrl}`,
      "",
      `If you'd rather not maintain the payment side yourself: we're piloting a gateway that puts x402 (Base, Solana) and MPP (Base, Tempo) in front of an API, with payouts straight to your own wallets. Free during the pilot: ${gatewayUrl}?ref=${encodeURIComponent(host)}`,
      "",
      "Cheers,",
      "Frits (Fizzl)",
    ].join("\n"),
  };
}

export function createOutreach({ store, mailer, telegram = null, adminChatId = null, from = null, replyTo = null, dailyLimit = 10, dashboardUrl = null, logoUrl = null, now = () => Date.now() } = {}) {
  const g = store.global;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const footer = (host) => `\n\n--\nYou got this one-off note because ${host ? `${host} lists` : "your site lists"} this address as its contact. Reply "stop" and you won't hear from us again.`;
  const err = (status, message) => Object.assign(new Error(message), { status });

  const open = async () => (await g.listOutreach()).filter((d) => d.status === "draft" && now() - d.createdAt < DRAFT_DAYS * 86_400_000);

  async function notify(d) {
    if (!telegram || !adminChatId) return;
    const text = [
      `<b>Concept-mail aan ${escapeHtml(d.to)}</b>${d.host ? ` (${escapeHtml(d.host)})` : ""}`,
      `<i>${escapeHtml(d.source === "doctor" ? "via x402 Doctor: iemand checkte een kapotte dienst" : "handmatig toegevoegd")}</i>`,
      "",
      `<b>${escapeHtml(d.subject)}</b>`,
      "",
      escapeHtml(d.body.length > 2500 ? `${d.body.slice(0, 2500)}…` : d.body),
      ...(dashboardUrl ? ["", `<a href="${escapeHtml(dashboardUrl)}">Aanpassen op het dashboard (Stats)</a>`] : []),
    ].join("\n");
    const messageId = await telegram.sendButtons(adminChatId, text, [[{ text: "Versturen", data: `ow:${d.id}:s` }, { text: "Weggooien", data: `ow:${d.id}:d` }]]).catch((e) => { console.warn(`[outreach] telegram: ${e.message}`); return null; });
    if (messageId) await g.putOutreach({ ...d, telegram: { chatId: adminChatId, messageId } });
  }

  async function done(d, line) {
    if (!telegram || !d.telegram) return;
    await telegram.appendToMessage(d.telegram.chatId, d.telegram.messageId, line).catch(() => {});
  }

  async function add({ to, subject, body, host = null, url = null, source = "manual" }) {
    const email = clean(to, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) throw err(400, "That doesn't look like an e-mail address.");
    subject = clean(subject, 200); body = clean(body, 8000);
    if (!subject || !body) throw err(400, "A draft needs a subject and a text.");
    host = host ? clean(host, 200).toLowerCase() : hostOf(url);
    if (await g.isStopped(email)) return { skipped: "stopped", message: `${email} asked not to be mailed.` };
    if (await g.isContacted(email)) return { skipped: "contacted", message: `${email} was already mailed once.` };
    const pending = await open();
    if (pending.some((d) => d.to === email || (host && d.host === host))) return { skipped: "pending", message: "There is already an open draft for this address or site." };
    const d = { id: `ow_${randomBytes(9).toString("base64url")}`, status: "draft", to: email, subject, body, host, url: url ? clean(url, 500) : null, source, createdAt: now() };
    await g.putOutreach(d);
    await notify(d);
    return { draft: d };
  }

  return {
    enabled: Boolean(mailer && from),
    add,
    // From x402 Doctor: a broken endpoint (failing checks) with the contact address it publishes.
    async fromDoctor({ url, to, findings, reportUrl }) {
      const host = hostOf(url);
      if (!host || !Array.isArray(findings) || !findings.length) throw err(400, "url and findings are required.");
      const fails = findings.filter((f) => f && typeof f.message === "string").map((f) => ({ id: clean(f.id, 60), message: f.message, hint: f.hint || null }));
      if (!fails.length) throw err(400, "No findings to write about.");
      const report = typeof reportUrl === "string" && /^https:\/\//.test(reportUrl) ? reportUrl : `https://x402-doctor.fizzl.eu/?url=${encodeURIComponent(url)}`;
      return add({ to, host, url, source: "doctor", ...composeFromFindings({ host, url, findings: fails, reportUrl: report }) });
    },
    async list() {
      const all = (await g.listOutreach()).sort((a, b) => b.createdAt - a.createdAt);
      return { enabled: Boolean(mailer && from), from, replyTo, dailyLimit, sentToday: await g.countSent(day()), drafts: all.filter((d) => d.status === "draft"), sent: all.filter((d) => d.status === "sent").slice(0, 50), discarded: all.filter((d) => d.status === "discarded").length };
    },
    async update(id, { to, subject, body } = {}) {
      const d = await g.getOutreach(id);
      if (!d || d.status !== "draft") throw err(404, "No open draft with that id.");
      if (to !== undefined) { const email = clean(to, 254).toLowerCase(); if (!EMAIL_RE.test(email)) throw err(400, "That doesn't look like an e-mail address."); d.to = email; }
      if (subject !== undefined) d.subject = clean(subject, 200) || d.subject;
      if (body !== undefined) d.body = clean(body, 8000) || d.body;
      await g.putOutreach(d);
      return d;
    },
    async discard(id, by = "dashboard") {
      const d = await g.getOutreach(id);
      if (!d || d.status !== "draft") throw err(404, "No open draft with that id.");
      const next = { ...d, status: "discarded", decidedAt: now(), decidedBy: by };
      await g.putOutreach(next);
      await done(next, `<b>Weggegooid (${escapeHtml(by)}).</b>`);
      return next;
    },
    async send(id, by = "dashboard") {
      const d = await g.getOutreach(id);
      if (!d || d.status !== "draft") throw err(404, "No open draft with that id (already sent or thrown away?).");
      if (!mailer || !from) throw err(503, "Outreach mail is off: set RESEND_API_KEY and OUTREACH_FROM on the wallet server.");
      if (await g.isStopped(d.to)) throw err(409, `${d.to} asked not to be mailed.`);
      if ((await g.countSent(day())) >= dailyLimit) throw err(429, `Today's limit of ${dailyLimit} e-mails is reached. Try again tomorrow.`);
      if (!(await g.markContacted(d.to))) throw err(409, `${d.to} was already mailed once.`);
      await g.countSent(day(), 1);
      try {
        const text = `${d.body}${footer(d.host)}`;
        await mailer.send(d.to, d.subject, text, { from, replyTo: replyTo || undefined, html: toHtml(text, { logoUrl }) });
      } catch (e) {
        // The mail service refused it, so nothing went out: the address may be tried again.
        await g.countSent(day(), -1);
        await g.unmarkContacted(d.to);
        await g.putOutreach({ ...d, lastError: clean(e.message, 300) });
        throw err(502, `Not sent: ${e.message}. Nothing went out; the draft is still there.`);
      }
      const next = { ...d, status: "sent", sentAt: now(), decidedBy: by };
      await g.putOutreach(next);
      await done(next, `<b>Verstuurd (${escapeHtml(by)}).</b>`);
      return next;
    },
    // A "stop" reply (or anyone the owner never wants to mail): no draft, no mail, ever.
    async stop(email) {
      const e = clean(email, 254).toLowerCase();
      if (!EMAIL_RE.test(e)) throw err(400, "That doesn't look like an e-mail address.");
      await g.stopOutreach(e);
      for (const d of await open()) if (d.to === e) await g.putOutreach({ ...d, status: "discarded", decidedAt: now(), decidedBy: "stop" });
      return { stopped: e };
    },
    // Telegram buttons ("ow:<id>:s|d"), only from the owner's chat.
    async fromTelegram(id, action, from) {
      if (!adminChatId || String(from?.id) !== String(adminChatId)) return { refused: true };
      return action === "s" ? this.send(id, "Telegram") : this.discard(id, "Telegram");
    },
  };
}
