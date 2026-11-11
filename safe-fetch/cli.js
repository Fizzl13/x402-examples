#!/usr/bin/env node
// x402-safe-fetch on the command line: an AI agent (or you) pays for one API call with one command, and safe-fetch's
// rules decide whether it is paid: x402 Doctor's preflight first, the cheapest option within the budget, a budget per
// call and per day, never paying an endpoint again after it took money without delivering, and the paid answer
// checked for instructions aimed at the agent.
//
//   npx x402-safe-fetch find "bitcoin price in usd"        free: who sells it, at what price, and whether it delivers
//   npx x402-safe-fetch check <url>                        free: the price and x402 Doctor's free check; pays nothing
//   npx x402-safe-fetch connect                            a wallet for this computer, linked to your Fizzl wallet
//   npx x402-safe-fetch pay <url> --max 0.05 --daily 1
//   npx x402-safe-fetch spent                              what was paid today, and what is left
//
// Pays USDC on Base from this computer's own wallet (init or connect make it; EVM_PRIVATE_KEY overrides it). Linked
// to a Fizzl Agent Wallet (connect), the owner's limits and approvals apply to every payment (wallet.js). The day's spend and the
// endpoints that took money without delivering are kept in ~/.x402-safe-fetch/state.json (X402_SAFE_FETCH_HOME
// moves it), so the limits and the paid-twice guard hold across commands.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWallet, readWallet, writeWallet, pair, serverSigner, usdcBalance, buyUsdcUrl, WALLET_URL } from "./wallet.js";
import {
  createSafeFetch, SafePayError, receiptOf, readOffer, usdOfOption, answerCheckOf, purchaseKey, paidTwiceMessage,
  PAID_ERROR_MS, DOCTOR_URL, VERSION,
} from "./index.js";

export const BUY_URL = "https://buy.fizzl.eu";
const PREFLIGHT_USD = 0.001;

const HELP = `x402-safe-fetch ${VERSION}: pay for an API call from the command line, checked first.

  connect              Start here. Makes a wallet for this computer and links it to your Fizzl wallet
                       (wallet.fizzl.eu): approve the code on your phone. Your limits and approvals then apply.
  init                 Only the wallet for this computer, not linked: shows its address and a link to buy USDC with a card.
  wallet               This computer's wallet: address, USDC balance, and whether it is linked.
  find <need>          Free. Who sells it (Fizzl Buy's pick): URL, price, and how often it delivered.
  check <url>          Free, pays nothing. The price per network and x402 Doctor's free check of the endpoint.
  pay <url>            Pays one call in USDC on Base, only if x402 Doctor's preflight says go.
  spent                What was paid today and what is left of the day's limit.

Options for pay (check takes --method and --data too):
  --max <usd>          Most one call may cost (default 0.05).
  --daily <usd>        Most all calls together may cost per UTC day, preflights included (default 1).
  --method <GET|POST>  HTTP method (default GET, or POST with --data).
  --data <json>        Request body (sent as application/json).
  --caution <stop|pay> What to do when the preflight says caution (default stop).
  --dry-run            Same as check: show the price and the free check, pay nothing.
  --no-answer-check    Don't check the paid answer for instructions aimed at your agent.
  --json               One line of JSON instead of text.

Exit codes: 0 done, 1 not paid (a check said no, or a limit), 2 usage or setup error.`;

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const bool = new Set(["dry-run", "json", "no-answer-check", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") out.flags.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (bool.has(k)) out.flags[k] = true;
      else out.flags[k] = v !== undefined ? v : argv[++i];
    } else out._.push(a);
  }
  return out;
}

function money(v, name) {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/^\$/, ""));
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive dollar amount, like 0.05`);
  return n;
}

class UsageError extends Error {}

// The state kept between commands: today's spend and the endpoints that took money without delivering.
export function stateStore({ home = process.env.X402_SAFE_FETCH_HOME || path.join(os.homedir(), ".x402-safe-fetch"), now = Date.now } = {}) {
  const file = path.join(home, "state.json");
  const today = () => new Date(now()).toISOString().slice(0, 10);
  function read() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
    if (s.day !== today()) s = { day: today(), spentUsd: 0, calls: 0, failed: s.failed || {} };
    for (const [k, v] of Object.entries(s.failed || {})) if (now() - v.at >= PAID_ERROR_MS) delete s.failed[k];
    s.failed ||= {};
    return s;
  }
  function write(s) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  return { home, file, read, write, now };
}

function requestInit(flags) {
  const data = flags.data;
  const method = String(flags.method || (data !== undefined ? "POST" : "GET")).toUpperCase();
  const init = { method };
  if (data !== undefined) {
    try { JSON.parse(data); } catch { throw new UsageError("--data must be JSON"); }
    init.body = data;
    init.headers = { "content-type": "application/json" };
  }
  return init;
}

function targetUrl(args) {
  const url = args._[1];
  if (!url || !/^https?:\/\//.test(url)) throw new UsageError("give the endpoint's URL, starting with https://");
  return url;
}

async function find(args, { fetch }) {
  const need = args._.slice(1).join(" ").trim();
  if (!need) throw new UsageError('say what you need, like: find "bitcoin price in usd"');
  const res = await fetch(`${BUY_URL}/v1/pick?need=${encodeURIComponent(need)}`, { headers: { "user-agent": `x402-safe-fetch-cli/${VERSION}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) return { ok: false, code: "pick_failed", message: `Fizzl Buy answered HTTP ${res.status}` };
  const row = (p) => p && { url: p.url, method: p.method, price_usd: p.price_usd, description: p.description, delivered: p.record ? `${p.record.payableDays} of ${p.record.days} days` : null, example: p.example, example_in: p.example_in };
  return { ok: Boolean(body.pick), need, pick: row(body.pick), alternatives: (body.alternatives || []).map(row), ...(body.pick ? {} : { message: "no seller found for that" }) };
}

async function check(args, { fetch }) {
  const url = targetUrl(args);
  const init = requestInit(args.flags);
  const res = await fetch(url, init);
  if (res.status !== 402) return { ok: true, url, status: res.status, paid: false, message: `HTTP ${res.status}: not a paid endpoint (nothing to pay)` };
  const { accepts } = await readOffer(res);
  const options = (accepts || []).map((o) => ({ network: o.network, scheme: o.scheme, price_usd: usdOfOption(o, o.network), pay_to: o.payTo }));
  let doctor = null;
  try {
    const d = await fetch(`${DOCTOR_URL}/api/diagnose`, { method: "POST", headers: { "content-type": "application/json", "user-agent": `x402-safe-fetch-cli/${VERSION}` }, body: JSON.stringify({ url, method: init.method }) });
    const j = await d.json();
    if (d.ok && j?.overall) doctor = { overall: j.overall, problems: (j.checks || []).filter((c) => c.status === "fail" || c.status === "warn").map((c) => ({ status: c.status, id: c.id, message: c.message })), report: j.share_url || null };
    else doctor = { overall: "unavailable", message: j?.error || `HTTP ${d.status}` };
  } catch (err) {
    doctor = { overall: "unavailable", message: err.message };
  }
  return { ok: true, url, status: 402, paid: false, options, doctor };
}

async function pay(args, { fetch, env, store, createPayingFetch, safeFetchOptions = {}, say = () => {} }) {
  if (args.flags["dry-run"]) return check(args, { fetch });
  const url = targetUrl(args);
  const init = requestInit(args.flags);
  const maxUsd = money(args.flags.max, "max") ?? 0.05;
  const daily = money(args.flags.daily, "daily") ?? 1;
  const caution = args.flags.caution ?? "stop";
  if (!["stop", "pay"].includes(caution)) throw new UsageError("--caution is stop or pay");

  const state = store.read();
  const left = Math.round((daily - state.spentUsd) * 1e6) / 1e6;
  if (left <= PREFLIGHT_USD) return { ok: false, url, code: "over_daily_limit", message: `not paid: today's limit of $${daily} is spent ($${state.spentUsd} paid)`, spent_today_usd: state.spentUsd };
  const key = purchaseKey(url, init);
  const earlier = state.failed[key];
  if (earlier) return { ok: false, url, code: "paid_no_delivery", message: paidTwiceMessage(url, earlier), earlier };

  let register;
  let linked = null; // the Fizzl wallet's signer, when this computer's wallet is linked
  if (!createPayingFetch) {
    const envKey = String(env.EVM_PRIVATE_KEY || "").trim();
    const own = envKey ? null : readWallet(store.home);
    const raw = envKey || own?.privateKey;
    if (!raw) throw new UsageError("no wallet yet: run  npx x402-safe-fetch connect  (or init), or set EVM_PRIVATE_KEY");
    let ExactEvmScheme, privateKeyToAccount;
    try {
      ({ ExactEvmScheme } = await import("@x402/evm/exact/client"));
      ({ privateKeyToAccount } = await import("viem/accounts"));
    } catch {
      throw new UsageError("paying needs @x402/evm and viem: npx -p x402-safe-fetch -p @x402/evm -p viem x402-safe-fetch pay <url>");
    }
    const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
    if (own?.server?.key) {
      linked = serverSigner({ account, server: own.server, fetch, purchase: { url, description: "x402-safe-fetch pay" }, onWait: (summary) => say(`Waiting for your approval (${summary}): check Telegram or ${own.server.url}`) });
    }
    register = (client) => client.register("eip155:8453", new ExactEvmScheme(linked ?? account));
  }

  let preflights = 0;
  let preflight = null;
  const safeFetch = createSafeFetch({
    register, createPayingFetch, fetch,
    maxUsd, maxTotalUsd: Math.round((left - PREFLIGHT_USD) * 1e6) / 1e6, // the day's limit, less this call's preflight
    onCaution: caution,
    checkAnswers: args.flags["no-answer-check"] ? false : "quick",
    onPreflight: (p, { cached }) => { preflight = p; if (!cached) preflights++; },
    ...safeFetchOptions,
  });
  // What one payment to the endpoint cost, as the preflight read it from the 402 (else the most it may cost).
  const priceOf = () => {
    const o = preflight?.options?.[preflight?.recommended_option];
    return typeof o?.usd === "number" ? o.usd : maxUsd;
  };
  const settle = (extra) => {
    // A seller that answers 402 again after taking the payment shows as "nothing paid" to safe-fetch's budget, which
    // can't tell; for the day's limit it counts as paid, so a loop of such calls can't run past it.
    const endpointUsd = extra?.failed && safeFetch.spent().totalUsd === 0 ? priceOf() : safeFetch.spent().totalUsd;
    const paidUsd = Math.round((endpointUsd + preflights * PREFLIGHT_USD) * 1e6) / 1e6;
    state.spentUsd = Math.round((state.spentUsd + paidUsd) * 1e6) / 1e6;
    if (paidUsd > 0) state.calls = (state.calls || 0) + 1;
    if (extra?.failed) state.failed[key] = { at: store.now(), status: extra.failed };
    if (extra?.delivered) delete state.failed[key];
    store.write(state);
    return { paid_usd: paidUsd, spent_today_usd: state.spentUsd, daily_limit_usd: daily };
  };
  const verdict = () => preflight && { verdict: preflight.verdict, summary: preflight.summary };

  try {
    const res = await safeFetch(url, init).finally(() => linked?.finish("x402-safe-fetch"));
    const text = await res.text();
    const receipt = receiptOf(res);
    // A response after a preflight means the endpoint was paid (or a payment was sent): a 2xx clears it, anything else
    // blocks this endpoint for 30 minutes, also for the next command.
    const attempted = preflight !== null;
    const delivered = res.status >= 200 && res.status < 300;
    const totals = settle(attempted ? (delivered ? { delivered: true } : { failed: res.status }) : null);
    let body = text;
    try { body = JSON.parse(text); } catch { /* text */ }
    return {
      ok: delivered, url, status: res.status, ...totals, preflight: verdict(),
      transaction: receipt?.transaction || null, network: receipt?.network || null,
      answer_check: answerCheckOf(res), body,
      ...(delivered ? {} : { code: "not_delivered", message: `paid, but the endpoint answered HTTP ${res.status}; it won't be paid again for 30 minutes` }),
    };
  } catch (err) {
    const refused = linked?.state.denied;
    if (refused) {
      const totals = settle(null);
      return { ok: false, url, code: refused.code, message: `not paid: your Fizzl wallet says no: ${refused.summary}`, preflight: verdict(), ...totals };
    }
    if (!(err instanceof SafePayError)) throw err;
    const totals = settle(null);
    return { ok: false, url, code: err.code, message: err.message, preflight: verdict() ?? (err.preflight ? { verdict: err.preflight.verdict, summary: err.preflight.summary } : null), reasons: (err.preflight?.reasons || []).filter((r) => r.level !== "info").map((r) => ({ level: r.level, code: r.code, message: r.message })), ...totals };
  }
}

async function init(args, { store, fetch }) {
  const { wallet, created } = await ensureWallet(store.home);
  const usdc = await usdcBalance(wallet.address, { fetch });
  return { ok: true, created, address: wallet.address, usdc_base: usdc, buy_usdc_url: buyUsdcUrl(wallet.address), linked: wallet.server ? { url: wallet.server.url, agent: wallet.server.agent } : null, file: path.join(store.home, "wallet.json") };
}

async function connect(args, { store, fetch, say, sleep }) {
  const { wallet } = await ensureWallet(store.home);
  const url = String(args.flags.server || WALLET_URL);
  const label = String(args.flags.name || `x402-safe-fetch on ${os.hostname()}`).slice(0, 40);
  const linked = await pair({
    address: wallet.address, label, url, fetch, sleep,
    onCode: ({ code, url: link }) => say(`Open this on your phone and approve:\n\n  ${link}\n\n  code ${code}  (valid 10 minutes)\n\nNo Fizzl wallet yet? One is made when you sign in. Waiting...`),
  });
  writeWallet(store.home, { ...wallet, server: linked });
  const usdc = await usdcBalance(wallet.address, { fetch });
  return { ok: true, address: wallet.address, linked: { url: linked.url, agent: linked.agent }, usdc_base: usdc, buy_usdc_url: buyUsdcUrl(wallet.address) };
}

async function walletInfo(args, { store, fetch }) {
  const wallet = readWallet(store.home);
  if (!wallet) return { ok: false, code: "no_wallet", message: "no wallet yet: run  npx x402-safe-fetch connect  (or init)" };
  const usdc = await usdcBalance(wallet.address, { fetch });
  return { ok: true, address: wallet.address, usdc_base: usdc, buy_usdc_url: buyUsdcUrl(wallet.address), linked: wallet.server ? { url: wallet.server.url, agent: wallet.server.agent } : null };
}

function spent(args, { store }) {
  const s = store.read();
  const daily = money(args.flags.daily, "daily") ?? 1;
  return { ok: true, day: s.day, spent_today_usd: s.spentUsd, calls: s.calls || 0, daily_limit_usd: daily, left_usd: Math.max(0, Math.round((daily - s.spentUsd) * 1e6) / 1e6), blocked_endpoints: Object.keys(s.failed).map((k) => k.replace(/^GET /, "")), state: store.file };
}

function text(cmd, r) {
  const lines = [];
  if (cmd === "find") {
    if (!r.pick) return r.message || "Nothing found.";
    const p = r.pick;
    lines.push(`${p.method} ${p.url}`, `  $${p.price_usd} per call · delivered ${p.delivered ?? "?"} · ${p.description || ""}`.trimEnd());
    if (r.alternatives?.length) lines.push("Also:", ...r.alternatives.map((a) => `  $${a.price_usd} ${a.method} ${a.url}`));
    lines.push(`Pay it: npx x402-safe-fetch pay "${p.url}"`);
  } else if (cmd === "check") {
    lines.push(r.message || `HTTP 402 at ${r.url}`);
    for (const o of r.options || []) lines.push(`  ${o.network}: ${o.price_usd === null ? "?" : `$${o.price_usd}`} to ${o.pay_to}`);
    if (r.doctor) {
      lines.push(`x402 Doctor's free check: ${String(r.doctor.overall).toUpperCase()}${r.doctor.message ? ` (${r.doctor.message})` : ""}`);
      for (const p of (r.doctor.problems || []).slice(0, 6)) lines.push(`  ${p.status}: ${p.message}`);
      if (r.doctor.report) lines.push(`  ${r.doctor.report}`);
    }
    if (r.status === 402) lines.push("Nothing was paid. The paid preflight (go / caution / no-go, $0.001) runs with pay.");
  } else if (cmd === "pay") {
    if (r.preflight) lines.push(`x402 Doctor: ${String(r.preflight.verdict).toUpperCase()}: ${r.preflight.summary || ""}`.trimEnd());
    if (r.ok) {
      lines.push(`Paid $${r.paid_usd} (preflight included)${r.transaction ? ` · tx ${r.transaction}` : ""}`);
      if (r.answer_check) lines.push(`Answer check: ${r.answer_check}`);
      lines.push(typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2));
    } else {
      lines.push(`Not done (${r.code}): ${r.message}`);
      for (const x of r.reasons || []) lines.push(`  ${x.level}: ${x.message}`);
      if (r.status && r.body !== undefined) lines.push(typeof r.body === "string" ? r.body.slice(0, 600) : JSON.stringify(r.body).slice(0, 600));
    }
    if (r.spent_today_usd !== undefined) lines.push(`Today: $${r.spent_today_usd} of $${r.daily_limit_usd}`);
  } else if (cmd === "init" || cmd === "connect" || cmd === "wallet") {
    if (!r.ok) return r.message;
    if (cmd === "init" && r.created) lines.push("Made a wallet for this computer (the key stays here, readable by you only).");
    if (cmd === "connect") lines.push(`Linked to your Fizzl wallet${r.linked?.agent ? ` as "${r.linked.agent}"` : ""}: your limits and approvals now apply.`);
    lines.push(`Address: ${r.address}`, `USDC on Base: ${r.usdc_base === null ? "?" : `$${r.usdc_base}`}`);
    if (cmd !== "connect") lines.push(r.linked ? `Linked to ${r.linked.url}${r.linked.agent ? ` as "${r.linked.agent}"` : ""}` : "Not linked to a Fizzl wallet (run connect for limits and phone approvals).");
    if (!r.usdc_base) {
      lines.push(
        "To pay, add a few dollars of USDC on Base to the address above:",
        `  with a card (Coinbase, $5; open it in your browser): ${r.buy_usdc_url}`,
        "  or send USDC from Coinbase, a wallet app or an exchange (choose the Base network).",
      );
    }
    lines.push('Then: npx x402-safe-fetch find "what you need"');
  } else if (cmd === "spent") {
    lines.push(`${r.day}: $${r.spent_today_usd} paid in ${r.calls} call(s), $${r.left_usd} left of $${r.daily_limit_usd}`);
    if (r.blocked_endpoints.length) lines.push("Not paid again for now (took money without delivering):", ...r.blocked_endpoints.map((b) => `  ${b}`));
  }
  return lines.join("\n");
}

export async function main(argv, { fetch = globalThis.fetch, env = process.env, store = stateStore(), createPayingFetch, safeFetchOptions, sleep, out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.flags.help || cmd === "help") { out(HELP); return cmd || args.flags.help ? 0 : 2; }
  const commands = { connect, init, wallet: walletInfo, find, check, pay, spent };
  if (!commands[cmd]) { err(`unknown command "${cmd}"\n\n${HELP}`); return 2; }
  try {
    const say = args.flags.json ? () => {} : (s) => err(s);
    const r = await commands[cmd](args, { fetch, env, store, createPayingFetch, safeFetchOptions, say, sleep });
    out(args.flags.json ? JSON.stringify(r) : text(cmd === "pay" && args.flags["dry-run"] ? "check" : cmd, r));
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) { err(e.message); return 2; }
    err(`error: ${e.message}`);
    return 2;
  }
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
