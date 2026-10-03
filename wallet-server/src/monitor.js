// Endpoint monitor for x402 sellers (part of Fizzl Pro): every hour, call each watched endpoint the
// way a paying agent's first request does, without paying, and check that it still asks for payment
// correctly: HTTP 402 with an x402 challenge (PAYMENT-REQUIRED header or JSON body) that has payment
// options. Public https endpoints only; nothing is paid or signed.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "./catalog.js";

const UA = "fizzl-endpoint-monitor/1.0 (+https://wallet.fizzl.eu)";
const SLOW_MS = 10_000;

/** Is this a URL we may call: public https, no port, no IP, no internal names. Returns an error text or null. */
export function urlProblem(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return "Not a URL."; }
  if (u.protocol !== "https:") return "Use an https:// address.";
  if (u.port || isIP(u.hostname) || !u.hostname.includes(".") || /(^|\.)(localhost|local|internal|lan|home)$/i.test(u.hostname)) return "Use a public https address (no IPs, ports or internal names).";
  if (u.username || u.password) return "No user name or password in the address.";
  if (u.href.length > 500) return "That address is too long.";
  return null;
}

function decodeChallenge(headerValue, bodyText) {
  const tryJson = (t) => { try { const j = JSON.parse(t); return j && typeof j === "object" ? j : null; } catch { return null; } };
  if (headerValue) {
    const j = tryJson(headerValue) ?? tryJson(Buffer.from(headerValue, "base64").toString("utf8"));
    if (j) return j;
  }
  return tryJson(bodyText ?? "");
}

export function createEndpointMonitor({ fetch: fetchImpl = globalThis.fetch, lookup = (h) => dnsLookup(h, { all: true }), now = () => Date.now() } = {}) {
  /** One check: { state: "ok" | "down", status, ms, note, networks, method }. When the chosen method doesn't
   *  ask for payment but the other one (GET/POST) does, that counts as ok, with `method` saying which works. */
  async function check(url, method = "GET") {
    const r = await checkOnce(url, method);
    if (r.state === "ok" || r.status === 0 || r.status === 402) return { ...r, method };
    const other = method === "POST" ? "GET" : "POST";
    const alt = await checkOnce(url, other);
    if (alt.state !== "ok") return { ...r, method };
    return { ...alt, method: other, note: `${alt.note.replace(/\.$/, "")}, on ${other} (not ${method}).` };
  }
  async function checkOnce(url, method) {
    const problem = urlProblem(url);
    if (problem) return { state: "down", status: 0, ms: 0, note: problem };
    const host = new URL(url).hostname;
    const addrs = await lookup(host).catch(() => []);
    if (!addrs.length) return { state: "down", status: 0, ms: 0, note: `The name ${host} doesn't resolve.` };
    if (addrs.some((a) => isPrivateAddress(a.address ?? a))) return { state: "down", status: 0, ms: 0, note: "That address points to a private network." };
    const t = now();
    let res, text = "";
    try {
      res = await fetchImpl(url, { method, redirect: "manual", headers: { "user-agent": UA, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(20_000) });
      const reader = res.body?.getReader?.();
      if (reader) { for (let total = 0; total < 65536;) { const { done, value } = await reader.read(); if (done) break; total += value.length; text += new TextDecoder().decode(value, { stream: true }); } reader.cancel().catch(() => {}); }
    } catch (err) {
      return { state: "down", status: 0, ms: now() - t, note: err?.name === "TimeoutError" ? "No answer within 20 seconds." : "Not reachable." };
    }
    const ms = now() - t;
    if (res.status !== 402) {
      const hint = res.status >= 500 ? "the server has an error" : res.status >= 300 && res.status < 400 ? "it redirects (agents don't follow a redirect to pay)" : res.status === 200 ? "it answers without asking for payment" : res.status === 401 || res.status === 403 ? "it refuses the request (blocked, or it wants a login or API key first)" : res.status === 404 ? "the page doesn't exist" : res.status === 405 ? "wrong method: try GET or POST" : "agents can't pay it";
      return { state: "down", status: res.status, ms, note: `Answers HTTP ${res.status} instead of 402: ${hint}.` };
    }
    const challenge = decodeChallenge(res.headers.get("payment-required") ?? res.headers.get("x-payment-required"), text);
    const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
    if (!accepts.length) return { state: "down", status: 402, ms, note: "Answers 402, but without an x402 challenge with payment options: agents can't pay." };
    const networks = [...new Set(accepts.map((a) => String(a?.network ?? "")).filter(Boolean))];
    if (ms > SLOW_MS) return { state: "ok", status: 402, ms, networks, note: `Asks for payment correctly, but slowly (${Math.round(ms / 1000)} s).` };
    return { state: "ok", status: 402, ms, networks, note: `Asks for payment correctly (${networks.join(", ") || "x402"}).` };
  }
  return { check };
}

// Monitor alerts to a webhook as well as Telegram: a Discord or Slack incoming webhook (their own message
// format), or any https URL (JSON with the event). The URL is a secret of the seller's: it's kept on the
// server and only shown back as its kind and host. Same rules as watched endpoints: public https only.
export function hookKind(raw) {
  const u = new URL(raw);
  if (/^(discord|discordapp)\.com$/i.test(u.hostname) && u.pathname.startsWith("/api/webhooks/")) return "discord";
  if (/^hooks\.slack\.com$/i.test(u.hostname)) return "slack";
  return "webhook";
}

export function createAlertHook({ fetch: fetchImpl = globalThis.fetch, lookup = (h) => dnsLookup(h, { all: true }) } = {}) {
  /** Send one alert. `event`: { type: "down" | "up" | "test", url, method, note, status, at }. Throws a readable error. */
  async function send(url, text, event) {
    const problem = urlProblem(url);
    if (problem) throw new Error(problem);
    const host = new URL(url).hostname;
    const addrs = await lookup(host).catch(() => []);
    if (!addrs.length) throw new Error(`The name ${host} doesn't resolve.`);
    if (addrs.some((a) => isPrivateAddress(a.address ?? a))) throw new Error("That address points to a private network.");
    const kind = hookKind(url);
    const body = kind === "discord" ? { content: text.slice(0, 1900), allowed_mentions: { parse: [] } } : kind === "slack" ? { text } : { text, event };
    let res;
    try {
      res = await fetchImpl(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      res.body?.cancel?.().catch?.(() => {});
    } catch (err) {
      throw new Error(err?.name === "TimeoutError" ? "The webhook didn't answer within 10 seconds." : "The webhook isn't reachable.");
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`The webhook answered HTTP ${res.status}.`);
    return { kind };
  }
  return { send };
}
