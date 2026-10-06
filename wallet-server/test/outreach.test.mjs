// Outreach: drafts are made, nothing is mailed without send(), one mail per address, a daily cap, stop works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../src/store.js";
import { createOutreach, composeFromFindings, toHtml } from "../src/outreach.js";
import { createApp } from "../src/app.js";

function setup({ dailyLimit = 10, failMail = false } = {}) {
  const store = memoryStore();
  const mails = [], tg = [];
  const mailer = { async send(to, subject, text, opts) { if (failMail) throw new Error("rejected"); mails.push({ to, subject, text, opts }); } };
  const telegram = {
    async sendButtons(chatId, html, rows) { tg.push({ chatId, html, rows }); return tg.length; },
    async appendToMessage(chatId, messageId, html) { tg.push({ chatId, messageId, html }); },
  };
  const outreach = createOutreach({ store, mailer, telegram, adminChatId: "42", from: "Frits from Fizzl <frits@fizzl.eu>", replyTo: "me@example.com", dailyLimit, logoUrl: "https://wallet.fizzl.eu/icons/fizzl.png" });
  return { store, mails, tg, outreach };
}
const findings = [{ id: "solana-payout-account", message: "payTo has no USDC token account on Solana.", hint: "Send 0.01 USDC once." }, { id: "bazaar", message: "Bazaar declaration is invalid." }];

test("a Doctor finding becomes a draft (on Telegram with buttons); nothing is mailed until send", async () => {
  const s = setup();
  const r = await s.outreach.fromDoctor({ url: "https://api.seller.test/x", to: "Ops@Seller.test", findings });
  assert.equal(r.draft.to, "ops@seller.test");
  assert.equal(r.draft.host, "api.seller.test");
  assert.match(r.draft.subject, /2 issues on api\.seller\.test/);
  assert.match(r.draft.body, /1\. payTo has no USDC token account[\s\S]*Fix: Send 0\.01 USDC once\.[\s\S]*2\. Bazaar declaration/);
  assert.match(r.draft.body, /x402-doctor\.fizzl\.eu\/\?url=https%3A%2F%2Fapi\.seller\.test%2Fx/);
  assert.match(r.draft.body, /fizzl\.eu\/gateway\/\?ref=api\.seller\.test/);
  assert.equal(s.mails.length, 0);
  assert.deepEqual(s.tg[0].rows[0].map((b) => b.text), ["Versturen", "Weggooien"]);
  const sent = await s.outreach.send(r.draft.id, "dashboard");
  assert.equal(sent.status, "sent");
  assert.equal(s.mails.length, 1);
  assert.equal(s.mails[0].opts.from, "Frits from Fizzl <frits@fizzl.eu>");
  assert.equal(s.mails[0].opts.replyTo, "me@example.com");
  assert.match(s.mails[0].text, /Reply "stop" and you won't hear from us again\.$/);
  assert.match(s.mails[0].opts.html, /<img src="https:\/\/wallet\.fizzl\.eu\/icons\/fizzl\.png"/);
  assert.match(s.mails[0].opts.html, /Reply &quot;stop&quot;|Reply "stop"/);
  await assert.rejects(s.outreach.send(r.draft.id), /No open draft/);
});

test("one mail per address ever, one open draft per address or site", async () => {
  const s = setup();
  const a = await s.outreach.fromDoctor({ url: "https://a.test/x", to: "x@a.test", findings });
  assert.equal((await s.outreach.fromDoctor({ url: "https://a.test/y", to: "other@a.test", findings })).skipped, "pending");
  assert.equal((await s.outreach.add({ to: "x@a.test", subject: "s", body: "b" })).skipped, "pending");
  await s.outreach.send(a.draft.id);
  assert.equal((await s.outreach.add({ to: "x@a.test", subject: "s", body: "b" })).skipped, "contacted");
});

test("stop means no draft and no mail; Telegram taps only count from the owner's chat", async () => {
  const s = setup();
  const d = (await s.outreach.add({ to: "y@b.test", subject: "Hi", body: "Text" })).draft;
  await s.outreach.stop("Y@b.test");
  assert.equal((await s.outreach.list()).drafts.length, 0);
  assert.equal((await s.outreach.add({ to: "y@b.test", subject: "Hi", body: "Text" })).skipped, "stopped");
  await assert.rejects(s.outreach.send(d.id), /No open draft/);
  const e = (await s.outreach.add({ to: "z@c.test", subject: "Hi", body: "Text" })).draft;
  assert.deepEqual(await s.outreach.fromTelegram(e.id, "s", { id: 7 }), { refused: true });
  assert.equal((await s.outreach.fromTelegram(e.id, "s", { id: 42 })).status, "sent");
  assert.equal(s.mails.length, 1);
});

test("daily cap, and a refused mail leaves the draft and the address free", async () => {
  const s = setup({ dailyLimit: 1 });
  const a = (await s.outreach.add({ to: "a@a.test", subject: "Hi", body: "T" })).draft;
  const b = (await s.outreach.add({ to: "b@b.test", subject: "Hi", body: "T" })).draft;
  await s.outreach.send(a.id);
  await assert.rejects(s.outreach.send(b.id), /limit of 1/);
  const f = setup({ failMail: true });
  const c = (await f.outreach.add({ to: "c@c.test", subject: "Hi", body: "T" })).draft;
  await assert.rejects(f.outreach.send(c.id), /Not sent/);
  assert.equal((await f.outreach.list()).drafts.length, 1);
  assert.equal(await f.store.global.isContacted("c@c.test"), false);
  assert.equal(await f.store.global.countSent(new Date().toISOString().slice(0, 10)), 0);
});

test("compose caps the findings at four", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ message: `m${i}` }));
  const { body } = composeFromFindings({ host: "h.test", url: "https://h.test", findings: many, reportUrl: "https://r" });
  assert.match(body, /4\. m3\n\(and 2 more in the report\)/);
});

test("the Doctor hook needs OUTREACH_KEY and only makes drafts", async () => {
  const s = setup();
  const accounts = new Proxy({}, { get: () => async () => null });
  const app = createApp({ accounts, auth: { middleware: () => (_q, _s, n) => n() }, outreach: s.outreach, outreachKey: "secret-key-123" });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (auth) => fetch(`${base}/hooks/outreach-draft`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ url: "https://api.seller.test/x", to: "ops@seller.test", findings }) });
  try {
    assert.equal((await post()).status, 401);
    assert.equal((await post("Bearer wrong")).status, 401);
    const ok = await post("Bearer secret-key-123");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).draft.to, "ops@seller.test");
    assert.equal(s.mails.length, 0);
  } finally { server.close(); }
});

test("the HTML version: same words, links clickable, text escaped, icon next to the sign-off, footer small", () => {
  const html = toHtml('Hi,\n\nSee https://x402-doctor.fizzl.eu/?url=a&b=1.\n<script>x</script>\n\nCheers,\nFrits (Fizzl)\n\n--\nReply "stop".', { logoUrl: "https://wallet.fizzl.eu/icons/fizzl.png" });
  assert.match(html, /<a href="https:\/\/x402-doctor\.fizzl\.eu\/\?url=a&amp;b=1"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /fizzl\.png"[^>]*alt="Fizzl"[\s\S]*Cheers,<br>Frits \(Fizzl\)/);
  assert.match(html, /font-size:12px">Reply "stop"\.<\/p>/);
  assert.doesNotMatch(toHtml("Hi,\n\nCheers,\nFrits"), /<img/);
});

test("weekly scan drafts: scan wording, and a discarded site is not drafted again", async () => {
  const s = setup();
  const r = await s.outreach.fromDoctor({ url: "https://scan.test/x", to: "ops@scan.test", findings, via: "scan" });
  assert.equal(r.draft.source, "scan");
  assert.match(r.draft.body, /daily read-only scan of the x402 Bazaar checked https:\/\/scan\.test\/x/);
  assert.doesNotMatch(r.draft.body, /Someone ran/);
  await s.outreach.discard(r.draft.id);
  assert.equal((await s.outreach.fromDoctor({ url: "https://scan.test/y", to: "ops@scan.test", findings, via: "scan" })).skipped, "discarded");
  // The owner can still write to them by hand.
  assert.ok((await s.outreach.add({ to: "ops@scan.test", subject: "s", body: "b" })).draft);
});

test("the message hook needs DRAFT_KEY (not OUTREACH_KEY), makes a draft with Claude's text and mails nothing", async () => {
  const s = setup();
  const accounts = new Proxy({}, { get: () => async () => null });
  const app = createApp({ accounts, auth: { middleware: () => (_q, _s, n) => n() }, outreach: s.outreach, outreachKey: "doctor-key", draftKey: "draft-key-456" });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const msg = { to: "Mike@Agent402.test", subject: "presign-guard for your catalog?", body: "Hi Mike,\n\nWould it fit?\n\nCheers,\nFrits (Fizzl)", url: "https://agent402.test" };
  const post = (auth, body = msg) => fetch(`${base}/hooks/outreach-message`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post()).status, 401);
    assert.equal((await post("Bearer doctor-key")).status, 401);
    const ok = await post("Bearer draft-key-456");
    assert.equal(ok.status, 200);
    const { draft } = await ok.json();
    assert.equal(draft.to, "mike@agent402.test"); assert.equal(draft.source, "claude"); assert.equal(draft.host, "agent402.test"); assert.equal(draft.subject, msg.subject);
    assert.match(s.tg.at(-1).html, /opgesteld door Claude/);
    assert.equal(s.mails.length, 0);
    assert.equal((await (await post("Bearer draft-key-456")).json()).skipped, "pending");
    assert.equal((await post("Bearer draft-key-456", { ...msg, to: "not-an-address" })).status, 400);
  } finally { server.close(); }
  const off = createApp({ accounts, auth: { middleware: () => (_q, _s, n) => n() }, outreach: s.outreach, outreachKey: "doctor-key" });
  const sv2 = await new Promise((r) => { const sv = off.listen(0, () => r(sv)); });
  try { assert.equal((await fetch(`http://127.0.0.1:${sv2.address().port}/hooks/outreach-message`, { method: "POST", headers: { authorization: "Bearer x" } })).status, 404); } finally { sv2.close(); }
});
