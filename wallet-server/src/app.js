// HTTP routes. Agents use /v1/* with "Authorization: Bearer awk_…"; the
// dashboard uses /api/* with the session cookie (the owner with the password,
// customers with their wallet); Telegram posts button taps and /start links
// to /telegram/webhook. Every request works only on its own account.
import express from "express";
import { PAY_CHAINS } from "./accounts.js";
import { noUsage, agentOf, fizzlSite } from "./usage.js";
import { readFileSync } from "node:fs";
import qrcode from "qrcode-generator";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DASHBOARD = fileURLToPath(new URL("../public/index.html", import.meta.url));
const LEGAL = { "/privacy": fileURLToPath(new URL("../public/privacy.html", import.meta.url)), "/terms": fileURLToPath(new URL("../public/terms.html", import.meta.url)) };
const SKILL = fileURLToPath(new URL("../public/skill.md", import.meta.url));
const COUNTER = fileURLToPath(new URL("../public/s.js", import.meta.url));
const AGENTKEY = fileURLToPath(new URL("../public/agentkey.js", import.meta.url)); // makes an agent wallet in the browser
const FONTS = fileURLToPath(new URL("../public/fonts", import.meta.url));
const ICONS = fileURLToPath(new URL("../public/icons", import.meta.url)); // wallet logos (MetaMask, Phantom) for the sign-in buttons
const APP = fileURLToPath(new URL("../public/app", import.meta.url)); // the dashboard as an installable app: icons
const MANIFEST = fileURLToPath(new URL("../public/manifest.webmanifest", import.meta.url));
const WORKER = fileURLToPath(new URL("../public/sw.js", import.meta.url)); // service worker: notifications
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function createApp({ accounts, auth, telegram = null, signInWithWallet = true, operator = {}, catalog = null, usage = noUsage, stats = null, outreach = null, outreachKey = null, likes = null }) {
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
    if (status >= 500 && !err.expose) console.error(err); // exposed errors were already logged in one line where they happened
    res.status(status).json({ error: status >= 500 ? "server_error" : "bad_request", message: status >= 500 && !err.expose ? "Something went wrong." : err.message });
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  // What the sign-in page offers.
  app.get("/api/config", (_req, res) => res.json({ wallet: signInWithWallet, solana: signInWithWallet && !!accounts.solanaEnabled, email: signInWithWallet && !!accounts.emailEnabled, password: auth.hasPassword, telegram: !!telegram?.username }));

  // ---------- agents ----------
  const agentOnly = async (req, res, next) => {
    try {
      const key = /^Bearer (awk_[A-Za-z0-9_-]+)$/.exec(req.get("authorization") ?? "")?.[1];
      const found = key && (await accounts.agentForKey(key));
      if (!found) return res.status(401).json({ error: "unauthorized", message: "Send Authorization: Bearer <agent key>. Keys are made on the dashboard." });
      req.agent = found.agent;
      req.wallet = accounts.walletFor(found.account);
      req.wallet.seen(found.agent).catch(() => {}); // for "Test my setup": the agent got through
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

  // ---------- the search bar: paid APIs in the public x402 catalog ----------
  // The same routes for signed-in users (/api/services/…) and, read-only and rate-limited, for the
  // public demo (/api/public/services/…). Searching never writes anything an outsider could steer.
  const services = express.Router();
  const unavailable = (res) => res.status(503).json({ error: "unavailable", message: "Searching is not set up on this server." });
  const down = (res, err) => { console.warn(`[catalog] ${err.message}`); res.status(502).json({ error: "catalog_unavailable", message: "The x402 catalog can't be reached right now. Try again in a minute." }); };
  services.get("/search", wrap(async (req, res) => {
    if (!catalog) return unavailable(res);
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const max = Number(req.query.max);
    const category = typeof req.query.cat === "string" && /^[a-z]{2,20}$/.test(req.query.cat) ? req.query.cat : null;
    const page = Math.min(500, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    // Filters: net=Base,Solana · new=1 · skill=1 · reliable=1 · sort=best|cheap|record
    const NETWORKS = ["Base", "Solana", "Arbitrum", "Optimism", "Polygon", "Ethereum"];
    const networks = typeof req.query.net === "string" ? req.query.net.split(",").filter((n) => NETWORKS.includes(n)) : null;
    const flag = (k) => req.query[k] === "1" || req.query[k] === "true";
    const sort = ["cheap", "record"].includes(req.query.sort) ? req.query.sort : "best";
    try {
      const r = await catalog.search(q, { maxUsd: max > 0 ? max : Infinity, limit: 20, category, page, networks, fresh: flag("new"), skill: flag("skill"), reliable: flag("reliable"), sort });
      // What people look for, and what they don't find (anonymous; signed-in searches carry the account code).
      usage.record("search", { account: req.account ?? null, via: req.account ? "dashboard" : "public", agent: req.account ? undefined : agentOf(req.get("user-agent")),
        input: { q: q.trim().toLowerCase() || undefined, cat: category ?? undefined, max: max > 0 ? max : undefined, net: networks?.join(",") || undefined, reliable: flag("reliable") || undefined, skill: flag("skill") || undefined, new: flag("new") || undefined, sort: sort !== "best" ? sort : undefined, page: page > 1 ? page : undefined },
        result: { total: r.total, top: r.results[0]?.host } });
      res.json(r);
    } catch (err) { down(res, err); }
  }));
  services.get("/categories", wrap(async (req, res) => {
    if (!catalog) return unavailable(res);
    const max = Number(req.query.max);
    try { res.json(await catalog.categories({ maxUsd: max > 0 ? max : Infinity })); } catch (err) { down(res, err); }
  }));
  services.get("/new", wrap(async (req, res) => {
    if (!catalog) return unavailable(res);
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    try {
      const r = await catalog.newProviders({ days });
      usage.record("new_providers", { account: req.account ?? null, via: req.account ? "dashboard" : "public", result: { count: r.providers.length } });
      res.json(r);
    } catch (err) { down(res, err); }
  }));
  // The demo: at most 60 searches a minute per address.
  const hits = new Map();
  const slowDown = (req, res, next) => {
    const now = Date.now(), h = hits.get(req.ip);
    if (!h || now - h.since > 60_000) { hits.set(req.ip, { n: 1, since: now }); if (hits.size > 10_000) hits.clear(); return next(); }
    if (++h.n > 60) return res.status(429).json({ error: "slow_down", message: "Too many searches. Wait a minute." });
    next();
  };
  app.use("/api/public/services", slowDown, services);
  // The dashboard tells which buttons people use on search results (Connect, one request, website, a Fizzl
  // service, a new provider): only the kind of button, where, and the seller's host name.
  const CLICKS = new Set(["connect", "request", "website", "all_services", "fizzl_connect", "fizzl_request", "skill_line", "ask_example"]);
  // The visitor counter on fizzl.eu and its subdomains (public/s.js): a page view, or a click to the
  // wallet or a service. No cookies, no IP address, nothing about the visitor; Do Not Track is respected.
  const siteOrigin = (o) => { try { const u = new URL(o); return u.protocol === "https:" && fizzlSite(u.hostname) ? u.hostname : null; } catch { return null; } };
  app.options("/api/public/usage/site", (req, res) => {
    const site = siteOrigin(req.get("origin"));
    if (site) res.set({ "access-control-allow-origin": `https://${site}`, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" });
    res.status(204).end();
  });
  app.post("/api/public/usage/site", express.text({ type: "*/*", limit: "2kb" }), slowDown, (req, res) => {
    const site = siteOrigin(req.get("origin"));
    if (site) res.set({ "access-control-allow-origin": `https://${site}`, vary: "origin" });
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}; } catch {}
    const path = typeof b.path === "string" && /^\/[\w\-./%~]*$/.test(b.path) ? b.path.slice(0, 120) : "/";
    const to = typeof b.to === "string" && /^[a-z0-9.-]{1,120}$/i.test(b.to) ? b.to.toLowerCase() : undefined;
    if (site && (b.kind === "view" || (b.kind === "out" && to))) usage.record(b.kind, { service: "site", via: site, agent: agentOf(req.get("user-agent")), input: { site, path, to } });
    res.status(204).end();
  });
  // Likes on fizzl.eu and its subdomains (the heart button): one count per site. A visitor counts once a
  // day: a mark made from a secret that changes with every restart, the day, their address and browser,
  // hashed, kept 24 hours and then gone. No cookies, nothing stored about the visitor.
  const likeSalt = randomBytes(16).toString("hex");
  const likeMark = (req, site) => createHash("sha256").update(`${likeSalt}|${new Date().toISOString().slice(0, 10)}|${req.ip}|${req.get("user-agent") ?? ""}|${site}`).digest("base64url").slice(0, 32);
  const likeCors = (req, res) => { const site = siteOrigin(req.get("origin")); if (site) res.set({ "access-control-allow-origin": `https://${site}`, vary: "origin" }); return site; };
  app.options("/api/public/likes", (req, res) => {
    const site = siteOrigin(req.get("origin"));
    if (site) res.set({ "access-control-allow-origin": `https://${site}`, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" });
    res.status(204).end();
  });
  app.get("/api/public/likes", wrap(async (req, res) => {
    likeCors(req, res);
    const site = typeof req.query.site === "string" && fizzlSite(req.query.site.toLowerCase()) ? req.query.site.toLowerCase() : null;
    if (!likes || !site) return res.status(404).json({ error: "not_found" });
    res.set("cache-control", "no-store").json({ site, count: await likes.likeCount(site) });
  }));
  app.post("/api/public/likes", express.text({ type: "*/*", limit: "1kb" }), slowDown, wrap(async (req, res) => {
    const site = likeCors(req, res); // only from the site itself: its own origin decides what is liked
    if (!likes || !site) return res.status(403).json({ error: "forbidden", message: "Likes come from the Fizzl websites." });
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}; } catch {}
    if (/bot|crawl|spider|headless/i.test(req.get("user-agent") ?? "")) return res.json({ site, count: await likes.likeCount(site), counted: false });
    const r = b.action === "unlike" ? await likes.unlike(site, likeMark(req, site)) : await likes.like(site, likeMark(req, site), 86_400);
    if (r.counted) usage.record(b.action === "unlike" ? "unlike" : "like", { service: "site", via: site, agent: agentOf(req.get("user-agent")), input: { site } });
    res.json({ site, count: r.count, counted: r.counted });
  }));
  app.post("/api/public/usage/click", slowDown, (req, res) => {
    const kind = req.body?.kind, host = typeof req.body?.host === "string" && /^[a-z0-9.-]{1,120}$/i.test(req.body.host) ? req.body.host.toLowerCase() : undefined;
    const from = ["search", "new", "fizzl", "agents"].includes(req.body?.from) ? req.body.from : undefined;
    if (CLICKS.has(kind)) {
      const account = auth.subject(req.get("cookie")) ?? null;
      usage.record("click", { account, via: account ? "dashboard" : req.body?.demo === true ? "demo" : "public", input: { kind, host, from } });
    }
    res.status(204).end();
  });

  // ---------- sign-in ----------
  app.post("/api/login", (req, res) => {
    const r = auth.login(req.body?.password, req.ip);
    if (!r.ok) return res.status(r.retryAfter ? 429 : 401).json({ error: "wrong_password", retryAfter: r.retryAfter ?? null });
    res.set("set-cookie", r.cookie).json({ ok: true });
  });
  app.post("/api/signin/message", wrap(async (req, res) => {
    if (!signInWithWallet) return res.status(404).json({ error: "not_found" });
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    res.json(await accounts.signInMessage(req.body?.address, `${req.protocol}://${req.host}`, req.body?.chain === "solana" ? "solana" : "ethereum", req.body?.chainId));
  }));
  app.post("/api/signin", wrap(async (req, res) => {
    if (!signInWithWallet) return res.status(404).json({ error: "not_found" });
    const id = await accounts.signIn(req.body?.nonce, req.body?.signature, { ref: req.body?.ref });
    res.set("set-cookie", auth.sessionFor(id)).json({ ok: true });
  }));
  // Sign in with e-mail: a 6-digit code is mailed, then typed in.
  app.post("/api/signin/email", wrap(async (req, res) => {
    if (!signInWithWallet) return res.status(404).json({ error: "not_found" });
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    res.json(await accounts.emailCode(req.body?.email));
  }));
  app.post("/api/signin/email/code", wrap(async (req, res) => {
    if (!signInWithWallet) return res.status(404).json({ error: "not_found" });
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    const id = await accounts.emailSignIn(req.body?.email, req.body?.code, { ref: req.body?.ref });
    res.set("set-cookie", auth.sessionFor(id)).json({ ok: true });
  }));
  // Passkeys (Face ID, Touch ID, a fingerprint): the page this request came from is the site the passkey is for.
  const where = (req) => ({ origin: `${req.protocol}://${req.host}`, rpId: req.hostname });
  app.post("/api/passkey/options", wrap(async (req, res) => {
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    res.json(await accounts.passkeyLoginOptions(req.hostname));
  }));
  app.post("/api/passkey/signin", wrap(async (req, res) => {
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    const id = await accounts.passkeyLogin(req.body, where(req));
    res.set("set-cookie", auth.sessionFor(id)).json({ ok: true });
  }));
  // The installed app on a phone: it asks for a code, the customer confirms it where they are signed in, the app polls.
  app.post("/api/device/start", wrap(async (req, res) => {
    if (!auth.allowSignIn(req.ip)) return res.status(429).json({ error: "slow_down", message: "Too many sign-ins. Wait a while." });
    res.json(await accounts.deviceStart(req.body?.label));
  }));
  app.post("/api/device/poll", wrap(async (req, res) => {
    const id = await accounts.devicePoll(req.body?.token);
    if (!id) return res.json({ ok: false });
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
  owner.use("/services", services);
  owner.get("/purchases", wrap(async (req, res) => res.json({ purchases: await req.wallet.purchases({ agent: typeof req.query.agent === "string" ? req.query.agent : null, limit: req.query.limit }) })));
  owner.get("/purchases/:id", wrap(async (req, res) => res.json({ purchase: await req.wallet.purchase(req.params.id) })));
  owner.put("/policy", wrap(async (req, res) => res.json({ policy: await req.wallet.setPolicy(req.body?.policy) })));
  owner.post("/pause", wrap(async (req, res) => { await req.wallet.setPaused(!!req.body?.paused); res.json({ ok: true }); }));
  owner.post("/agents", wrap(async (req, res) => res.json(await req.wallet.addAgent(req.body?.name, req.body?.site))));
  owner.post("/agents/:id/pause", wrap(async (req, res) => res.json(await req.wallet.setAgentPaused(req.params.id, !!req.body?.paused))));
  owner.put("/agents/:id/site", wrap(async (req, res) => res.json(await req.wallet.setAgentSite(req.params.id, req.body?.site ?? null))));
  owner.put("/agents/:id/address", wrap(async (req, res) => res.json(await req.wallet.setAgentAddress(req.params.id, req.body?.address || null))));
  owner.post("/setup/check", wrap(async (req, res) => res.json(await accounts.setupCheck(req.account, { agentId: typeof req.body?.agentId === "string" ? req.body.agentId : null, telegram: req.body?.telegram === true }))));
  owner.put("/follow", wrap(async (req, res) => res.json(await accounts.setFollow(req.account, req.body?.categories))));
  owner.delete("/agents/:id", wrap(async (req, res) => { await req.wallet.removeAgent(req.params.id); res.json({ ok: true }); }));
  owner.post("/approvals/:id", wrap(async (req, res) => {
    const d = req.body?.decision;
    if (d !== "approve" && d !== "deny") return res.status(400).json({ error: "bad_request", message: 'decision must be "approve" or "deny"' });
    res.json(await req.wallet.decide(req.params.id, d, "dashboard"));
  }));
  // Notifications on the devices where the dashboard is installed as an app (Web Push).
  owner.get("/push", wrap(async (req, res) => res.json(await accounts.pushDevices(req.account))));
  owner.post("/push/subscribe", wrap(async (req, res) => res.json(await accounts.pushSubscribe(req.account, req.body?.subscription, req.body?.label))));
  owner.post("/push/unsubscribe", wrap(async (req, res) => res.json(await accounts.pushUnsubscribe(req.account, String(req.body?.endpoint ?? "")))));
  // E-mail on a wallet account (sign in with either), and a wallet on an e-mail account (to pay Pro from).
  owner.post("/account/email", wrap(async (req, res) => res.json(await accounts.emailCode(req.body?.email, { purpose: "link", id: req.account }))));
  owner.post("/account/email/code", wrap(async (req, res) => res.json(await accounts.emailLink(req.account, req.body?.email, req.body?.code))));
  owner.post("/account/email/remove", wrap(async (req, res) => res.json(await accounts.emailUnlink(req.account))));
  owner.post("/account/wallet/message", wrap(async (req, res) => res.json(await accounts.signInMessage(req.body?.address, `${req.protocol}://${req.host}`, req.body?.chain === "solana" ? "solana" : "ethereum", req.body?.chainId))));
  owner.post("/account/wallet", wrap(async (req, res) => res.json(await accounts.walletLink(req.account, req.body?.nonce, req.body?.signature))));
  owner.post("/promo", wrap(async (req, res) => res.json(await accounts.promoRedeem(req.account, req.body?.code))));
  owner.post("/feedback", wrap(async (req, res) => res.json(await accounts.feedback(req.account, req.body?.text))));
  owner.get("/admin/promos", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    res.json(await accounts.promoList());
  }));
  owner.post("/admin/promos", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    res.json(await accounts.promoCreate(req.body?.days, req.body?.uses, req.body?.note));
  }));
  owner.post("/admin/promos/:code/stop", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    res.json(await accounts.promoStop(req.params.code));
  }));
  owner.post("/passkey/new", wrap(async (req, res) => res.json(await accounts.passkeyOptions(req.account, req.hostname))));
  owner.post("/passkey/add", wrap(async (req, res) => res.json(await accounts.passkeyAdd(req.account, req.body?.answer, req.body?.label, where(req)))));
  owner.post("/passkey/remove", wrap(async (req, res) => res.json(await accounts.passkeyRemove(req.account, String(req.body?.id ?? "")))));
  owner.post("/device/approve", wrap(async (req, res) => res.json(await accounts.deviceApprove(req.account, req.body?.code))));
  owner.post("/push/test", wrap(async (req, res) => res.json(await accounts.pushTest(req.account))));
  owner.post("/telegram/link", wrap(async (req, res) => res.json(await accounts.telegramLink(req.account))));
  owner.post("/telegram/unlink", wrap(async (req, res) => res.json(await accounts.telegramUnlink(req.account))));
  owner.post("/billing/solana", wrap(async (req, res) => res.json(await accounts.solanaPayment(req.account, req.body?.months, req.body?.tier))));
  owner.post("/billing/claim", wrap(async (req, res) => res.json(await accounts.claimPayment(req.account, req.body?.txHash, req.body?.chainId, req.body?.tier))));
  owner.post("/account/delete", wrap(async (req, res) => {
    if (req.body?.confirm !== "delete") return res.status(400).json({ error: "bad_request", message: 'send { "confirm": "delete" }' });
    await accounts.deleteAccount(req.account);
    res.set("set-cookie", auth.logoutCookie()).json({ ok: true });
  }));
  // The EU right of withdrawal: one click, then a confirmation (the "withdrawal function" consumer law asks for).
  owner.post("/billing/withdraw", wrap(async (req, res) => {
    if (req.body?.confirm !== "withdraw") return res.status(400).json({ error: "bad_request", message: 'send { "confirm": "withdraw" }' });
    res.json(await accounts.withdraw(req.account));
  }));
  owner.get("/admin/withdrawals", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    res.json({ withdrawals: await accounts.withdrawals() });
  }));
  owner.post("/admin/withdrawals/:id/refunded", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    res.json(await accounts.markRefunded(req.params.id, req.body?.tx));
  }));
  // Endpoint monitor: the x402 endpoints this account watches (checked hourly, alerts on Telegram).
  owner.get("/monitors", wrap(async (req, res) => res.json(await accounts.monitors(req.account))));
  owner.post("/monitors", wrap(async (req, res) => res.json(await accounts.addMonitor(req.account, { url: req.body?.url, method: req.body?.method || "GET" }))));
  owner.put("/monitors/alert-hook", wrap(async (req, res) => res.json(await accounts.setAlertHook(req.account, req.body?.url))));
  owner.post("/monitors/alert-hook/test", wrap(async (req, res) => res.json(await accounts.testAlertHook(req.account))));
  owner.delete("/monitors/:id", wrap(async (req, res) => res.json(await accounts.removeMonitor(req.account, req.params.id))));
  owner.post("/monitors/:id/check", wrap(async (req, res) => { await accounts.checkMonitor(req.account, req.params.id); res.json(await accounts.monitors(req.account)); }));
  owner.post("/billing/auto/refresh", wrap(async (req, res) => res.json(await accounts.refreshAuto(req.account))));
  // The owner's Stats tab: the website, the wallet and the four services, from the usage log.
  owner.get("/admin/stats", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    if (!stats) return res.status(503).json({ error: "unavailable", message: "Statistics are not set up on this server." });
    res.json(await stats.summary(Number(req.query.days) || 30));
  }));
  // The weekly summary on Telegram, now (it also goes out by itself on Monday morning).
  owner.post("/admin/digest", wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    const summary = stats?.enabled ? await stats.summary(7).catch(() => null) : null;
    const r = await accounts.weeklyDigest({ summary, force: true });
    if (!r.sent) return res.status(409).json({ error: "not_sent", message: r.reason });
    res.json(r);
  }));
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
  // Outreach (src/outreach.js): the owner's drafts to sellers, sent only on the owner's word.
  const ownerOnly = (fn) => wrap(async (req, res) => {
    if (req.account !== "admin") return res.status(403).json({ error: "forbidden" });
    if (!outreach) return res.status(503).json({ error: "unavailable", message: "Outreach is not set up on this server." });
    return fn(req, res);
  });
  owner.get("/admin/outreach", ownerOnly(async (_req, res) => res.json(await outreach.list())));
  owner.post("/admin/outreach", ownerOnly(async (req, res) => res.json(await outreach.add({ to: req.body?.to, subject: req.body?.subject, body: req.body?.body, url: req.body?.url || null }))));
  owner.put("/admin/outreach/:id", ownerOnly(async (req, res) => res.json(await outreach.update(req.params.id, { to: req.body?.to, subject: req.body?.subject, body: req.body?.body }))));
  owner.post("/admin/outreach/:id/send", ownerOnly(async (req, res) => res.json(await outreach.send(req.params.id, "dashboard"))));
  owner.post("/admin/outreach/:id/discard", ownerOnly(async (req, res) => res.json(await outreach.discard(req.params.id, "dashboard"))));
  owner.post("/admin/outreach-stop", ownerOnly(async (req, res) => res.json(await outreach.stop(req.body?.email))));
  app.use("/api", owner);

  // x402 Doctor hands in a draft (a broken endpoint and its published contact). Needs OUTREACH_KEY; makes a draft only.
  const keyHash = outreachKey ? createHash("sha256").update(outreachKey).digest() : null;
  app.post("/hooks/outreach-draft", wrap(async (req, res) => {
    if (!outreach || !keyHash) return res.status(404).json({ error: "not_found" });
    const given = createHash("sha256").update(String(req.get("authorization") ?? "").replace(/^Bearer\s+/i, "")).digest();
    if (!timingSafeEqual(given, keyHash)) { console.warn("[outreach] a draft with a wrong OUTREACH_KEY was refused"); return res.status(401).json({ error: "unauthorized" }); }
    const out = await outreach.fromDoctor({ url: req.body?.url, to: req.body?.to, findings: req.body?.findings, reportUrl: req.body?.reportUrl, via: req.body?.via === "scan" ? "scan" : "check" });
    console.log(`[outreach] from Doctor: ${out.draft ? `draft ${out.draft.id} for ${out.draft.host}` : `no draft (${out.skipped})`}`);
    res.json(out);
  }));

  // ---------- Telegram ----------
  app.post("/telegram/webhook", wrap(async (req, res) => {
    if (!telegram) return res.status(404).end();
    const ok = await telegram.handleWebhook({ "x-telegram-bot-api-secret-token": req.get("x-telegram-bot-api-secret-token") }, req.body, {
      decide: (id, d, from) => accounts.telegramDecide(id, d, from),
      outreach: outreach ? (id, action, from) => outreach.fromTelegram(id, action, from) : null,
      start: (code, chat, from) => accounts.telegramStart(code, chat, from),
    });
    res.status(ok ? 200 : 401).end();
  }));

  // ---------- dashboard, privacy statement, terms, fonts (served here: nothing loads from third parties) ----------
  // The website counter script for fizzl.eu and its subdomains: <script defer src="https://wallet.fizzl.eu/s.js"></script>
  let counter;
  app.get("/s.js", (_req, res) => {
    counter ??= readFileSync(COUNTER, "utf8");
    res.set({ "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }).type("application/javascript").send(counter);
  });
  app.use("/fonts", express.static(FONTS, { maxAge: "365d", immutable: true, fallthrough: false }));
  app.use("/icons", express.static(ICONS, { maxAge: "30d", fallthrough: false }));
  app.use("/app", express.static(APP, { maxAge: "30d", fallthrough: false }));
  app.get("/apple-touch-icon.png", (_req, res) => res.set("cache-control", "public, max-age=2592000").sendFile(`${APP}/icon-180.png`));
  app.get("/manifest.webmanifest", (_req, res) => res.set("cache-control", "public, max-age=3600").type("application/manifest+json").sendFile(MANIFEST));
  // Never cached long, so a new version of the worker reaches phones quickly.
  app.get("/sw.js", (_req, res) => res.set({ "cache-control": "no-cache", "content-security-policy": CSP }).type("text/javascript").sendFile(WORKER));
  let page;
  const legal = new Map();
  app.get(["/", "/index.html", "/demo"], (req, res) => {
    page ??= readFileSync(DASHBOARD, "utf8");
    usage.record("page", { via: req.path === "/demo" ? "demo" : "dashboard", agent: agentOf(req.get("user-agent")), input: { ref: fizzlSite(req.query.ref) } });
    res.set("content-security-policy", CSP);
    res.type("html").send(page);
  });
  // Who runs the service comes from the environment (OPERATOR_NAME, OPERATOR_ADDRESS, CONTACT_EMAIL), not from the code.
  // /skill.md: instructions an agent reads and follows ("Connect to wallet.fizzl.eu/skill.md"),
  // with this server's own address in them.
  let skill;
  app.get("/agentkey.js", (_req, res) => res.set("cache-control", "public, max-age=3600").type("text/javascript").sendFile(AGENTKEY));
  // A QR code that opens this dashboard on a phone (for "Other wallets": scan, then open it in the wallet app).
  const qrCache = new Map();
  app.get("/qr.svg", (req, res) => {
    const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(req.host ?? "") ? req.host : "wallet.fizzl.eu";
    const url = `${req.protocol === "http" && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "https" : req.protocol}://${host}/`;
    if (!qrCache.has(url)) {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      qrCache.set(url, qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }));
      if (qrCache.size > 20) qrCache.delete(qrCache.keys().next().value);
    }
    res.set("cache-control", "public, max-age=86400").type("image/svg+xml").send(qrCache.get(url));
  });
  app.get("/skill.md", (req, res) => {
    skill ??= readFileSync(SKILL, "utf8");
    const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(req.host ?? "") ? req.host : "wallet.fizzl.eu";
    const origin = `${req.protocol === "http" && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "https" : req.protocol}://${host}`;
    res.set("cache-control", "public, max-age=300").type("text/markdown; charset=utf-8").send(skill.replaceAll("{{ORIGIN}}", origin));
  });
  app.get(Object.keys(LEGAL), (req, res) => {
    if (!legal.has(req.path)) legal.set(req.path, readFileSync(LEGAL[req.path], "utf8"));
    const missing = (what) => `<mark>[${what}: set in Render]</mark>`;
    res.set("content-security-policy", CSP);
    res.type("html").send(legal.get(req.path)
      .replaceAll("{{OPERATOR}}", operator.name ? escapeHtml(operator.name) : missing("OPERATOR_NAME"))
      .replaceAll("{{ADDRESS_LINE}}", operator.address ? ` Address: ${escapeHtml(operator.address)}.` : "")
      .replaceAll("{{ADDRESS_COMMA}}", operator.address ? `, ${escapeHtml(operator.address)}` : "")
      .replaceAll("{{CONTACT}}", operator.email ? `<a href="mailto:${escapeHtml(operator.email)}">${escapeHtml(operator.email)}</a>` : missing("CONTACT_EMAIL")));
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}
