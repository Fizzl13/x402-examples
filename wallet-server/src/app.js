// HTTP routes. Agents use /v1/* with "Authorization: Bearer awk_…"; the
// dashboard uses /api/* with the session cookie (the owner with the password,
// customers with their wallet); Telegram posts button taps and /start links
// to /telegram/webhook. Every request works only on its own account.
import express from "express";
import { PAY_CHAINS } from "./accounts.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DASHBOARD = fileURLToPath(new URL("../public/index.html", import.meta.url));
const LEGAL = { "/privacy": fileURLToPath(new URL("../public/privacy.html", import.meta.url)), "/terms": fileURLToPath(new URL("../public/terms.html", import.meta.url)) };
const FONTS = fileURLToPath(new URL("../public/fonts", import.meta.url));
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function createApp({ accounts, auth, telegram = null, signInWithWallet = true, operator = {}, catalog = null }) {
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
  app.get("/api/config", (_req, res) => res.json({ wallet: signInWithWallet, solana: signInWithWallet && !!accounts.solanaEnabled, password: auth.hasPassword, telegram: !!telegram?.username }));

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
    res.json(await accounts.signInMessage(req.body?.address, `${req.protocol}://${req.host}`, req.body?.chain === "solana" ? "solana" : "ethereum"));
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
  // The search bar: paid APIs in the public x402 catalog.
  owner.get("/services/search", wrap(async (req, res) => {
    if (!catalog) return res.status(503).json({ error: "unavailable", message: "Searching is not set up on this server." });
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const max = Number(req.query.max);
    try { res.json(await catalog.search(q, { maxUsd: max > 0 ? max : Infinity, limit: 12 })); }
    catch (err) { console.warn(`[catalog] ${err.message}`); res.status(502).json({ error: "catalog_unavailable", message: "The x402 catalog can't be reached right now. Try again in a minute." }); }
  }));
  owner.get("/services/new", wrap(async (req, res) => {
    if (!catalog) return res.status(503).json({ error: "unavailable", message: "Searching is not set up on this server." });
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    try { res.json(await catalog.newProviders({ days })); }
    catch (err) { console.warn(`[catalog] ${err.message}`); res.status(502).json({ error: "catalog_unavailable", message: "The x402 catalog can't be reached right now. Try again in a minute." }); }
  }));
  owner.get("/purchases", wrap(async (req, res) => res.json({ purchases: await req.wallet.purchases({ agent: typeof req.query.agent === "string" ? req.query.agent : null, limit: req.query.limit }) })));
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
  owner.post("/billing/solana", wrap(async (req, res) => res.json(await accounts.solanaPayment(req.account, req.body?.months))));
  owner.post("/billing/claim", wrap(async (req, res) => res.json(await accounts.claimPayment(req.account, req.body?.txHash, req.body?.chainId))));
  owner.post("/account/delete", wrap(async (req, res) => {
    if (req.body?.confirm !== "delete") return res.status(400).json({ error: "bad_request", message: 'send { "confirm": "delete" }' });
    await accounts.deleteAccount(req.account);
    res.set("set-cookie", auth.logoutCookie()).json({ ok: true });
  }));
  owner.post("/billing/auto/refresh", wrap(async (req, res) => res.json(await accounts.refreshAuto(req.account))));
  owner.get("/admin/subscription", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    res.json(await accounts.subscriptionSetup());
  }));
  // The owner's bookkeeping: every Pro payment, as CSV.
  owner.get("/admin/payments.csv", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    const rows = await accounts.allPayments();
    const network = (r) => (r.chain === "solana" ? "Solana" : PAY_CHAINS[r.chainId ?? 8453]?.name ?? r.chainId);
    const csv = ["date,account,network,amount_usdc,months,transaction,paid_until,automatic", ...rows.map((r) => [new Date(r.at).toISOString(), r.account, network(r), r.amount, r.months, r.tx, new Date(r.paidUntil).toISOString(), r.auto ? "yes" : "no"].join(","))].join("\n");
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

  // ---------- dashboard, privacy statement, terms, fonts (served here: nothing loads from third parties) ----------
  app.use("/fonts", express.static(FONTS, { maxAge: "365d", immutable: true, fallthrough: false }));
  let page;
  const legal = new Map();
  app.get(["/", "/index.html", "/demo"], (_req, res) => {
    page ??= readFileSync(DASHBOARD, "utf8");
    res.set("content-security-policy", CSP);
    res.type("html").send(page);
  });
  // Who runs the service comes from the environment (OPERATOR_NAME, CONTACT_EMAIL), not from the code.
  app.get(Object.keys(LEGAL), (req, res) => {
    if (!legal.has(req.path)) legal.set(req.path, readFileSync(LEGAL[req.path], "utf8"));
    const missing = (what) => `<mark>[${what}: set in Render]</mark>`;
    res.set("content-security-policy", CSP);
    res.type("html").send(legal.get(req.path)
      .replaceAll("{{OPERATOR}}", operator.name ? escapeHtml(operator.name) : missing("OPERATOR_NAME"))
      .replaceAll("{{CONTACT}}", operator.email ? `<a href="mailto:${escapeHtml(operator.email)}">${escapeHtml(operator.email)}</a>` : missing("CONTACT_EMAIL")));
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}
