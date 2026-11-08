// How the exam is used, for the owner: one JSON line per event in the private usage-log repo
// (events/exam/<YYYY-MM-DD>/<HH>.jsonl, merged into one file per day each night by that repo), next to the other Fizzl
// services, so the weekly report can count exams, demos, replays and MCP calls.
//
// Anonymous like the others: a caller is a visitor code (HMAC of the IP with a secret, 12 hex characters), an operator
// wallet is an account code (HMAC of the address); a paid exam names its payer, as every paid call in the log does
// (it is public on chain). No task answers, no agent output.
//
// Settings (Render): USAGE_LOG_TOKEN (Contents read/write on the log repo only), optional USAGE_LOG_REPO (default
// Fizzl13/usage-log), USAGE_LOG_SALT (default: the token) and USAGE_OWN_WALLETS (your own operator wallets,
// comma-separated: their exams are marked own). Without a token nothing is logged. Logging never delays or breaks a
// request.

import { createHmac } from "node:crypto";

const API = "https://api.github.com";

// Who called, in a word: "browser", a bot's name, or the first product token ("node", "python-httpx/0.28").
export function agentOf(userAgent) {
  const ua = String(userAgent ?? "").trim();
  if (!ua) return "none";
  const bot = /([A-Za-z0-9._-]*(?:bot|crawler|spider|scan|monitor)[A-Za-z0-9._-]*)(?:\/[\w.-]+)?/i.exec(ua);
  if (bot) return bot[0].slice(0, 60);
  if (/^Mozilla\//.test(ua) && /(Chrome|Safari|Firefox|Edg)\//.test(ua)) return "browser";
  if (/^Mozilla\/5\.0 \((iPhone|iPad|iPod);[^)]*\) AppleWebKit\//.test(ua)) return "browser";
  return (ua.split(/[\s;(]/)[0] || ua).slice(0, 60);
}

export function createUsage({ token = null, repo = "Fizzl13/usage-log", salt = null, ownWallets = [], fetch: fetchImpl = globalThis.fetch, now = () => new Date(), log = console, batchMs = 5000 } = {}) {
  const secret = salt || token;
  const own = new Set(ownWallets.map((w) => String(w).trim().toLowerCase()).filter(Boolean));
  const queue = [];
  let flushing = null;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "usage-log/exam" };
  const hmac = (s) => (secret ? createHmac("sha256", secret).update(s).digest("hex").slice(0, 12) : undefined);

  async function append(path, lines) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = `${API}/repos/${repo}/contents/${path}`;
      const current = await fetchImpl(url, { headers });
      let sha;
      let text = "";
      if (current.status === 200) {
        const file = await current.json();
        sha = file.sha;
        text = Buffer.from(file.content || "", "base64").toString("utf8");
      } else if (current.status !== 404) throw new Error(`read ${path}: HTTP ${current.status}`);
      const body = { message: `exam: ${lines.length} event${lines.length === 1 ? "" : "s"}`, content: Buffer.from(text + lines.join("\n") + "\n").toString("base64"), ...(sha ? { sha } : {}) };
      const put = await fetchImpl(url, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (put.status === 200 || put.status === 201) return;
      if (put.status !== 409 && put.status !== 422) throw new Error(`write ${path}: HTTP ${put.status}`);
      await new Promise((ok) => setTimeout(ok, 250 * (attempt + 1)));
    }
    throw new Error(`write ${path}: gave up after retries`);
  }

  // Events go in batches, at most every few seconds, one commit per hour file.
  function flush() {
    flushing ??= (async () => {
      if (batchMs) await new Promise((ok) => setTimeout(ok, batchMs).unref?.());
      while (queue.length) {
        const byFile = new Map();
        for (const e of queue.splice(0)) {
          const p = `events/exam/${e.t.slice(0, 10)}/${e.t.slice(11, 13)}.jsonl`;
          if (!byFile.has(p)) byFile.set(p, []);
          byFile.get(p).push(JSON.stringify(e));
        }
        for (const [p, lines] of byFile) {
          try {
            await append(p, lines);
          } catch (err) {
            log.error?.(`[usage] ${err.message}; ${lines.length} event(s) dropped`);
          }
        }
      }
    })().finally(() => {
      flushing = null;
      if (queue.length) flush();
    });
    return flushing;
  }

  return {
    enabled: Boolean(token),
    // record(route, { req, via, operator, payer, usd, status, input, result }): what happened, never who.
    record(route, { req = null, via = "api", operator = null, payer = null, usd = undefined, status = 200, input = undefined, result = undefined } = {}) {
      if (!token) return;
      const e = {
        t: now().toISOString(),
        service: "exam",
        route,
        via,
        agent: req ? agentOf(req.get?.("user-agent") ?? req.headers?.["user-agent"]) : "server",
        visitor: req?.ip ? hmac(String(req.ip).replace(/^::ffff:/, "")) : undefined,
        acct: operator ? hmac(`exam:${String(operator).toLowerCase()}`) : undefined,
        ...(operator && own.has(String(operator).toLowerCase()) ? { own: true } : {}),
        status,
        paid: Boolean(payer),
        ...(payer ? { payer } : {}),
        usd,
        input,
        result,
      };
      queue.push(Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
      if (queue.length > 2000) queue.splice(0, queue.length - 2000);
      flush();
    },
    flush,
  };
}

export const noUsage = { enabled: false, record() {}, flush: async () => {} };

export function usageFromEnv(env = process.env, log = console) {
  if (!env.USAGE_LOG_TOKEN) return noUsage;
  return createUsage({ token: env.USAGE_LOG_TOKEN, repo: env.USAGE_LOG_REPO || "Fizzl13/usage-log", salt: env.USAGE_LOG_SALT || null, ownWallets: String(env.USAGE_OWN_WALLETS || "").split(","), log });
}
