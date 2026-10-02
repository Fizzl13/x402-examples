// HTTP routes. Agents use /v1/* with "Authorization: Bearer awk_…"; the
// dashboard uses /api/* with the session cookie (the owner with the password,
// customers with their wallet); Telegram posts button taps and /start links
// to /telegram/webhook. Every request works only on its own account.
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DASHBOARD = fileURLToPath(new URL("../public/index.html", import.meta.url));

export function createApp({ accounts, auth, telegram = null, signInWithWallet = true }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    res.set("x-content-type-options", "nosniff");
    res.set("referrer-policy", "no-referrer");
    next();
  });

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status ?? (err instanceof TypeError ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "server_error" : "bad_request", message: status >= 500 ? "Something went wrong." : err.message });
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  // What the sign-in page offers.
  app.get("/api/config", (_req, res) => res.json({ wallet: signInWithWallet, password: auth.hasPassword, telegram: !!telegram?.username }));

  // ---------- agents ----------
  const agentOnly = async (req, res, next) => {
    try {
      const key = /^Bearer (awk_[A-Za-z0-9_-]+)$/.exec(req.get("authorization") ?? "")?.[1];
      const found = key && (await accounts.agentForKey(key));
      if (!found) return res.status(401).json({ error: "unauthorized", message: "Send Authorization: Bearer <agent key>. Keys are made on the dashboard." });
      req.agent = found.agent;
      req.wallet = accounts.walletFor(found.account);
      next();
    } catch (err) { console.error(err); res.status(500).json({ error: "server_error" }); }
  };
  const v1 = express.Router();
  v1.use(agentOnly);
  v1.get("/policy", wrap(async (req, res) => res.json({ policy: await req.wallet.getPolicy() })));
  v1.post("/reserve", wrap(async (req, res) => res.json(await req.wallet.reserve(req.agent, req.body ?? {}))));
  v1.get("/approvals/:id", wrap(async (req, res) => {
    const wait = Math.min(25_000, Math.max(0, Number(req.query.wait ?? 0) * 1000 || 0));
    res.json(await req.wallet.waitForApproval(req.agent, req.params.id, wait));
  }));
  const ids = (v) => (Array.isArray(v) ? v.map(String) : []);
  v1.post("/release", wrap(async (req, res) => res.json(await req.wallet.release(req.agent, ids(req.body?.entries), { purchaseId: req.body?.purchaseId, error: req.body?.error }))));
  v1.post("/spent", wrap(async (req, res) => res.json(await req.wallet.spent(req.agent, ids(req.body?.entries), req.body?.result, { purchaseId: req.body?.purchaseId }))));
  v1.post("/purchases/annotate", wrap(async (req, res) => res.json(await req.wallet.annotate(req.agent, ids(req.body?.ids), req.body?.outcome))));
  v1.get("/spending", wrap(async (req, res) => res.json({ spending: await req.wallet.spending() })));
  app.use("/v1", v1);

  // ---------- sign-in ----------
  app.post("/api/login", (req, res) => {
    const r = auth.login(req.body?.password, req.ip);
    if (!r.ok) return res.status(r.retryAfter ? 429 : 401).json({ error: "wrong_password", retryAfter: r.retryAfter ?? null });
    res.set("set-cookie", r.cookie).json({ ok: true });
  });
  app.post("/api/signin/message", wrap(async (req, res) => {
    if (!signInWithWallet) return res.status(404).json({ error: "not_found" });
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    res.json(await accounts.signInMessage(req.body?.address));
  }));
  app.post("/api/signin", wrap(async (req, res) => {
    if (!signInWithWallet) return res.status(404).json({ error: "not_found" });
    const id = await accounts.signIn(req.body?.nonce, req.body?.signature);
    res.set("set-cookie", auth.sessionFor(id)).json({ ok: true });
  }));
  app.post("/api/logout", (_req, res) => res.set("set-cookie", auth.logoutCookie()).json({ ok: true }));

  // ---------- the account's own dashboard ----------
  const signedIn = (req, res, next) => {
    const id = auth.subject(req.get("cookie"));
    if (!id) return res.status(401).json({ error: "login_required" });
    if (req.method !== "GET" && req.method !== "DELETE" && !req.is("application/json")) return res.status(415).json({ error: "json_required" });
    req.account = id;
    req.wallet = accounts.walletFor(id);
    next();
  };
  const owner = express.Router();
  owner.use(signedIn);
  owner.get("/me", wrap(async (req, res) => res.json(await accounts.me(req.account))));
  owner.get("/state", wrap(async (req, res) => res.json(await req.wallet.state())));
  owner.get("/purchases/:id", wrap(async (req, res) => res.json({ purchase: await req.wallet.purchase(req.params.id) })));
  owner.put("/policy", wrap(async (req, res) => res.json({ policy: await req.wallet.setPolicy(req.body?.policy) })));
  owner.post("/pause", wrap(async (req, res) => { await req.wallet.setPaused(!!req.body?.paused); res.json({ ok: true }); }));
  owner.post("/agents", wrap(async (req, res) => res.json(await req.wallet.addAgent(req.body?.name))));
  owner.post("/agents/:id/pause", wrap(async (req, res) => res.json(await req.wallet.setAgentPaused(req.params.id, !!req.body?.paused))));
  owner.delete("/agents/:id", wrap(async (req, res) => { await req.wallet.removeAgent(req.params.id); res.json({ ok: true }); }));
  owner.post("/approvals/:id", wrap(async (req, res) => {
    const d = req.body?.decision;
    if (d !== "approve" && d !== "deny") return res.status(400).json({ error: "bad_request", message: 'decision must be "approve" or "deny"' });
    res.json(await req.wallet.decide(req.params.id, d, "dashboard"));
  }));
  owner.post("/telegram/link", wrap(async (req, res) => res.json(await accounts.telegramLink(req.account))));
  owner.post("/telegram/unlink", wrap(async (req, res) => res.json(await accounts.telegramUnlink(req.account))));
  owner.post("/billing/claim", wrap(async (req, res) => res.json(await accounts.claimPayment(req.account, req.body?.txHash))));
  // The owner's bookkeeping: every Pro payment, as CSV.
  owner.get("/admin/payments.csv", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    const rows = await accounts.allPayments();
    const csv = ["date,account,amount_usdc,months,transaction,paid_until", ...rows.map((r) => [new Date(r.at).toISOString(), r.account, r.amount, r.months, r.tx, new Date(r.paidUntil).toISOString()].join(","))].join("\n");
    res.type("text/csv").set("content-disposition", 'attachment; filename="fizzl-wallet-payments.csv"').send(`${csv}\n`);
  }));
  app.use("/api", owner);

  // ---------- Telegram ----------
  app.post("/telegram/webhook", wrap(async (req, res) => {
    if (!telegram) return res.status(404).end();
    const ok = await telegram.handleWebhook({ "x-telegram-bot-api-secret-token": req.get("x-telegram-bot-api-secret-token") }, req.body, {
      decide: (id, d, from) => accounts.telegramDecide(id, d, from),
      start: (code, chat, from) => accounts.telegramStart(code, chat, from),
    });
    res.status(ok ? 200 : 401).end();
  }));

  // ---------- dashboard ----------
  let page;
  app.get(["/", "/index.html", "/demo"], (_req, res) => {
    page ??= readFileSync(DASHBOARD, "utf8");
    res.set("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.type("html").send(page);
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}
