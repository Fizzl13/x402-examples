// Usage statistics for the owner: one JSON line per event in the private usage-log repo
// (events/wallet/<YYYY-MM-DD>.jsonl), next to the four Fizzl services, so the weekly report can
// show how the wallet is used. Anonymous on purpose (see the privacy statement):
// - an account is a short code (HMAC with a secret, 12 hex characters), never its address;
// - no agent keys, Telegram ids, wallet or recipient addresses, purchase descriptions or receipts;
// - a purchase is logged as the seller's host name and the amount, nothing about what was bought.
// Settings (Render): USAGE_LOG_TOKEN (Contents read/write on the log repo only), optional
// USAGE_LOG_REPO (default Fizzl13/usage-log), USAGE_LOG_SALT (default: the token) and
// USAGE_OWN_WALLETS (your own sign-in addresses, comma-separated: their events are marked own).
// Without a token nothing is logged. Logging never delays or breaks a request.
import { createHmac } from "node:crypto";

const API = "https://api.github.com";
const MAX_TEXT = 200;
const clip = (v) => (typeof v === "string" && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v);
const clean = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, clip(v)])) : undefined);

// Who called, in a word: "browser", a bot's name, or the first product token ("presign-guard-wallet/0.6.0").
export function agentOf(userAgent) {
  const ua = String(userAgent ?? "").trim();
  if (!ua) return "none";
  const bot = /([A-Za-z0-9._-]*(?:bot|crawler|spider|scan|monitor)[A-Za-z0-9._-]*)(?:\/[\w.-]+)?/i.exec(ua);
  if (bot) return bot[0].slice(0, 60);
  if (/^Mozilla\//.test(ua) && /(Chrome|Safari|Firefox|Edg)\//.test(ua)) return "browser";
  return (ua.split(/[\s;(]/)[0] || ua).slice(0, 60);
}
// The host a purchase went to (from the URL the agent named), or null.
// A Fizzl site (fizzl.eu or one of its subdomains) given as where someone came from, or undefined.
export const fizzlSite = (v) => (typeof v === "string" && /^([a-z0-9-]+\.)?fizzl\.eu$/i.test(v) ? v.toLowerCase() : undefined);
export const hostOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname : null; } catch { return null; } };

export function createUsage({ token = null, repo = "Fizzl13/usage-log", salt = null, ownWallets = [], fetch: fetchImpl = globalThis.fetch, now = () => new Date(), log = console, batchMs = 3000 } = {}) {
  const secret = salt || token;
  const own = new Set(ownWallets.map((w) => String(w).trim().toLowerCase()).filter(Boolean));
  const queue = [];
  let flushing = null;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "usage-log/wallet" };

  // An account as a short, stable code; the server owner is "owner".
  const code = (accountId) => (accountId === "admin" ? "owner" : accountId && secret ? createHmac("sha256", secret).update(`wallet:${String(accountId).toLowerCase()}`).digest("hex").slice(0, 12) : undefined);
  const isOwn = (accountId) => accountId === "admin" || own.has(String(accountId ?? "").replace(/^sol:/, "").toLowerCase());

  async function append(path, lines) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = `${API}/repos/${repo}/contents/${path}`;
      const current = await fetchImpl(url, { headers });
      let sha, text = "";
      if (current.status === 200) { const file = await current.json(); sha = file.sha; text = Buffer.from(file.content || "", "base64").toString("utf8"); }
      else if (current.status !== 404) throw new Error(`read ${path}: HTTP ${current.status}`);
      const body = { message: `wallet: ${lines.length} event${lines.length === 1 ? "" : "s"}`, content: Buffer.from(text + lines.join("\n") + "\n").toString("base64"), ...(sha ? { sha } : {}) };
      const put = await fetchImpl(url, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (put.status === 200 || put.status === 201) return;
      if (put.status !== 409 && put.status !== 422) throw new Error(`write ${path}: HTTP ${put.status}`);
      await new Promise((ok) => setTimeout(ok, 250 * (attempt + 1)));
    }
    throw new Error(`write ${path}: gave up after retries`);
  }
  // Events are sent in batches, at most every few seconds, one commit per batch.
  function flush() {
    flushing ??= (async () => {
      if (batchMs) await new Promise((ok) => setTimeout(ok, batchMs).unref?.());
      while (queue.length) {
        const byFile = new Map();
        for (const e of queue.splice(0)) { const p = `events/${e.service}/${e.t.slice(0, 10)}.jsonl`; if (!byFile.has(p)) byFile.set(p, []); byFile.get(p).push(JSON.stringify(e)); }
        for (const [p, lines] of byFile) { try { await append(p, lines); } catch (err) { log.error(`[usage] ${err.message}; ${lines.length} event(s) dropped`); } }
      }
    })().finally(() => { flushing = null; if (queue.length) flush(); });
    return flushing;
  }

  return {
    enabled: Boolean(token),
    // record("purchase", { account, via, agent, input, result }): what happened, never who.
    // service "site" is the website counter (events/site/); ref is the Fizzl site an account came from.
    record(route, { account = null, via = undefined, agent = undefined, input = undefined, result = undefined, usd = undefined, ref = undefined, service = "wallet" } = {}) {
      if (!token) return;
      const e = { t: now().toISOString(), service, route, via, acct: code(account), ...(account && isOwn(account) ? { own: true } : {}), agent, ref, status: 200, paid: false, usd, input: clean(input), result: clean(result) };
      queue.push(Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
      if (queue.length > 2000) queue.splice(0, queue.length - 2000);
      flush();
    },
    flush,
    code,
  };
}
// For code that runs without a log: the same shape, doing nothing.
export const noUsage = { enabled: false, record() {}, flush: async () => {}, code: () => undefined };
