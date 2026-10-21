// The live demo page for fizzl-paypal-guard: one shared run at a time, streamed to every viewer.
//   GET  /                 the page
//   GET  /api/config       what this server can do (sandbox or simulated PayPal, Claude or not, wallet approvals)
//   GET  /api/stream       server-sent events: the current run from its start, then live; the last run when idle
//   POST /api/run          { mode: "careful"|"fooled", code, approver: "page"|"wallet" } -> { token }
//   POST /api/approve      { id, decision: "approve"|"deny", token }: the owner's tap on the page's phone
// Env: PAYPAL_SANDBOX_CLIENT_ID + PAYPAL_SANDBOX_SECRET (else PayPal is simulated), ANTHROPIC_API_KEY (the
// careful agent; needs DEMO_CODE), OWNER_CODE + WALLET_SERVER_KEY (approvals on the owner's Telegram through the
// Fizzl wallet), PORT.
import express from "express";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fizzlWalletApproval } from "fizzl-paypal-guard";
import { runShop } from "./src/shop.js";

const env = process.env;
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const RECORDED = fileURLToPath(new URL("./public/recorded.json", import.meta.url));
const creds = { clientId: env.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: env.PAYPAL_SANDBOX_SECRET };
const sandbox = Boolean(creds.clientId && creds.clientSecret);
const claude = Boolean(env.ANTHROPIC_API_KEY && env.DEMO_CODE);
const wallet = Boolean(env.OWNER_CODE && env.WALLET_SERVER_KEY);
const APPROVAL_MS = 3 * 60_000;
const LIMITS = { careful: 10, fooled: 30 }; // runs an hour, across all visitors

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
let anthropic = null;
if (env.ANTHROPIC_API_KEY) anthropic = new (await import("@anthropic-ai/sdk")).default();

// The run everyone watches.
let run = null; // { id, token, mode, approver, events: [], started }
// The last finished run; after a restart, a real run recorded on the live demo (public/recorded.json, marked recorded).
let last = existsSync(RECORDED) ? JSON.parse(readFileSync(RECORDED, "utf8")) : null; // { mode, approver, at, events, recorded? }
const clients = new Set();
const recent = { careful: [], fooled: [] };
const pending = new Map(); // approval id -> resolve
const send = (res, e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
const emit = (e) => {
  if (!run) return;
  const ev = { at: Date.now() - run.started, ...e };
  run.events.push(ev);
  for (const c of clients) send(c, ev);
};

// The owner's phone on the page: the request shows there; the tap of whoever started the run decides.
const pageApprove = async (r) => {
  const id = r.id;
  emit({ type: "approval", id, channel: "page", summary: r.summary, reasons: r.reasons, customer: r.customer, request: r.request, amount: r.amount, currency: r.currency, expiresIn: APPROVAL_MS });
  const answer = await new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ approved: false, by: "no answer" }); }, APPROVAL_MS);
    pending.set(id, (v) => { clearTimeout(t); pending.delete(id); resolve(v); });
  });
  emit({ type: "approval-done", id, approved: answer.approved, by: answer.by });
  return answer;
};
// The owner's real phone: Telegram through the Fizzl wallet.
const walletApprove = wallet ? (() => {
  const ask = fizzlWalletApproval({ key: env.WALLET_SERVER_KEY, url: env.WALLET_SERVER_URL || "https://wallet.fizzl.eu", timeoutMs: APPROVAL_MS });
  const wrapped = async (r) => {
    emit({ type: "approval", id: r.id, channel: "telegram", summary: r.summary, reasons: r.reasons, customer: r.customer, request: r.request, amount: r.amount, currency: r.currency, expiresIn: APPROVAL_MS });
    const answer = await ask(r).catch((err) => ({ approved: false, by: `wallet error: ${err.message}` }));
    emit({ type: "approval-done", id: r.id, approved: answer.approved, by: answer.approved ? "the owner, in Telegram" : answer.by });
    return answer;
  };
  wrapped.report = ask.report;
  return wrapped;
})() : null;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
app.use((_req, res, next) => {
  res.set({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
  next();
});
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => res.json({ paypal: sandbox ? "sandbox" : "simulated", claude, wallet, running: Boolean(run), last: last ? { mode: last.mode, at: last.at } : null }));

app.get("/api/stream", (req, res) => {
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();
  if (run) { send(res, { type: "run", id: run.id, mode: run.mode, approver: run.approver, live: true }); for (const e of run.events) send(res, e); }
  else if (last) { send(res, { type: "run", mode: last.mode, approver: last.approver, live: false, at: last.at, recorded: last.recorded === true }); for (const e of last.events) send(res, e); }
  clients.add(res);
  const beat = setInterval(() => res.write(": beat\n\n"), 20_000);
  req.on("close", () => { clearInterval(beat); clients.delete(res); });
});

app.post("/api/run", (req, res) => {
  const mode = req.body?.mode === "careful" ? "careful" : "fooled";
  const approver = req.body?.approver === "wallet" ? "wallet" : "page";
  if (run) return res.status(409).json({ error: "busy", message: "A run is going on: watch it here, then start yours." });
  if (mode === "careful" && !claude) return res.status(400).json({ error: "no_claude", message: "The Claude agent isn't set up on this server. Try the fooled agent." });
  if (mode === "careful" && !same(req.body?.code, env.DEMO_CODE) && !same(req.body?.code, env.OWNER_CODE)) return res.status(403).json({ error: "code", message: "The Claude agent needs the demo code (it's in the submission's testing instructions)." });
  if (approver === "wallet" && !(wallet && same(req.body?.code, env.OWNER_CODE))) return res.status(403).json({ error: "owner", message: "Approvals in Telegram are for the shop owner's code." });
  const hour = Date.now() - 3600_000;
  recent[mode] = recent[mode].filter((t) => t > hour);
  if (recent[mode].length >= LIMITS[mode]) return res.status(429).json({ error: "busy_hour", message: "Many runs this hour; the replay of the last one is on the page. Try again later." });
  recent[mode].push(Date.now());
  run = { id: randomBytes(6).toString("hex"), token: randomBytes(16).toString("hex"), mode, approver, events: [], started: Date.now() };
  const mine = run;
  for (const c of clients) send(c, { type: "run", id: run.id, mode, approver, live: true });
  res.json({ id: run.id, token: run.token });
  runShop({ mode, paypal: sandbox ? "sandbox" : "mock", creds, anthropic, approve: approver === "wallet" ? walletApprove : pageApprove, emit })
    .catch((err) => { console.error(err); emit({ type: "error", message: String(err.message).slice(0, 300) }); })
    .finally(() => {
      for (const resolve of pending.values()) resolve({ approved: false, by: "run ended" });
      last = { mode: mine.mode, approver: mine.approver, at: new Date().toISOString(), events: mine.events };
      if (run === mine) run = null;
      for (const c of clients) send(c, { type: "end" });
    });
});

app.post("/api/approve", (req, res) => {
  const resolve = pending.get(String(req.body?.id ?? ""));
  if (!run || !resolve) return res.status(404).json({ error: "gone", message: "Nothing is waiting for that answer." });
  if (!same(req.body?.token, run.token)) return res.status(403).json({ error: "not_owner", message: "Only whoever started this run can answer for the owner." });
  const approved = req.body?.decision === "approve";
  resolve({ approved, by: approved ? "the owner, on the phone" : "the owner said no" });
  res.json({ ok: true });
});

app.use(express.static(PUBLIC, { maxAge: "1h", index: "index.html" }));
const port = Number(env.PORT) || 8080;
app.listen(port, () => console.log(`demo on :${port} · PayPal ${sandbox ? "sandbox" : "simulated"} · Claude ${claude ? "on" : "off"} · wallet approvals ${wallet ? "on" : "off"}`));
