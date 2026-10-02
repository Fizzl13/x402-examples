// HTTP routes. Agents use /v1/* with "Authorization: Bearer awk_…"; the owner's
// dashboard uses /api/* with the session cookie; Telegram posts button taps to
// /telegram/webhook.
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DASHBOARD = fileURLToPath(new URL("../public/index.html", import.meta.url));

export function createApp({ wallet, auth, telegram = null }) {
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

  // ---------- agents ----------
  const agentOnly = async (req, res, next) => {
    try {
      const key = /^Bearer (awk_[A-Za-z0-9_-]+)$/.exec(req.get("authorization") ?? "")?.[1];
      const agent = key && (await wallet.agentForKey(key));
      if (!agent) return res.status(401).json({ error: "unauthorized", message: "Send Authorization: Bearer <agent key>. Keys are made on the dashboard." });
      req.agent = agent;
      next();
    } catch (err) { console.error(err); res.status(500).json({ error: "server_error" }); }
  };
  const v1 = express.Router();
  v1.use(agentOnly);
  v1.get("/policy", wrap(async (_req, res) => res.json({ policy: await wallet.getPolicy() })));
  v1.post("/reserve", wrap(async (req, res) => res.json(await wallet.reserve(req.agent, req.body ?? {}))));
  v1.get("/approvals/:id", wrap(async (req, res) => {
    const wait = Math.min(25_000, Math.max(0, Number(req.query.wait ?? 0) * 1000 || 0));
    res.json(await wallet.waitForApproval(req.agent, req.params.id, wait));
  }));
  v1.post("/release", wrap(async (req, res) => res.json(await wallet.release(req.agent, Array.isArray(req.body?.entries) ? req.body.entries.map(String) : []))));
  v1.post("/spent", wrap(async (req, res) => res.json(await wallet.spent(req.agent, Array.isArray(req.body?.entries) ? req.body.entries.map(String) : [], req.body?.result))));
  v1.get("/spending", wrap(async (_req, res) => res.json({ spending: await wallet.spending() })));
  app.use("/v1", v1);

  // ---------- owner ----------
  const ownerOnly = (req, res, next) => {
    if (!auth.isOwner(req.get("cookie"))) return res.status(401).json({ error: "login_required" });
    if (req.method !== "GET" && req.method !== "DELETE" && !req.is("application/json")) return res.status(415).json({ error: "json_required" });
    next();
  };
  app.post("/api/login", (req, res) => {
    const r = auth.login(req.body?.password, req.ip);
    if (!r.ok) return res.status(r.retryAfter ? 429 : 401).json({ error: "wrong_password", retryAfter: r.retryAfter ?? null });
    res.set("set-cookie", r.cookie).json({ ok: true });
  });
  app.post("/api/logout", (_req, res) => res.set("set-cookie", auth.logoutCookie()).json({ ok: true }));
  const owner = express.Router();
  owner.use(ownerOnly);
  owner.get("/state", wrap(async (_req, res) => res.json(await wallet.state())));
  owner.put("/policy", wrap(async (req, res) => res.json({ policy: await wallet.setPolicy(req.body?.policy) })));
  owner.post("/pause", wrap(async (req, res) => { await wallet.setPaused(!!req.body?.paused); res.json({ ok: true }); }));
  owner.post("/agents", wrap(async (req, res) => res.json(await wallet.addAgent(req.body?.name))));
  owner.post("/agents/:id/pause", wrap(async (req, res) => res.json(await wallet.setAgentPaused(req.params.id, !!req.body?.paused))));
  owner.delete("/agents/:id", wrap(async (req, res) => { await wallet.removeAgent(req.params.id); res.json({ ok: true }); }));
  owner.post("/approvals/:id", wrap(async (req, res) => {
    const d = req.body?.decision;
    if (d !== "approve" && d !== "deny") return res.status(400).json({ error: "bad_request", message: 'decision must be "approve" or "deny"' });
    res.json(await wallet.decide(req.params.id, d, "dashboard"));
  }));
  app.use("/api", owner);

  // ---------- Telegram ----------
  app.post("/telegram/webhook", wrap(async (req, res) => {
    if (!telegram) return res.status(404).end();
    const ok = await telegram.handleWebhook({ "x-telegram-bot-api-secret-token": req.get("x-telegram-bot-api-secret-token") }, req.body, (id, d, by) => wallet.decide(id, d, by));
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
