// Attention check: Voxight coin attention + Ichimoku Signal's cloud in one read.
//
// An agent pays per call with x402 (USDC on Base):
//   1. Voxight coin attention: mentions in 9 windows (5 minutes to 7 days), who is talking   $0.16
//   2. Ichimoku Signal on 4h and 1d (two calls)                                               $0.02
// and combines them into a short read: is the talk about a coin running with the trend or against it?
// Every input keeps its own timestamp.
//
// Usage (in this folder, after npm install):
//   node attention-check.mjs SOL --dry-run   # prices only, pays nothing
//   EVM_PRIVATE_KEY=0x... node attention-check.mjs SOL
//   EVM_PRIVATE_KEY=0x... node attention-check.mjs PEPE --json
//
// Use a dedicated wallet with a dollar of USDC on Base; no ETH is needed.
// Not trade advice: this is an example of combining two x402 services.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "eip155:8453";
const VOXIGHT = (process.env.VOXIGHT_URL || "https://www.voxight.online").replace(/\/$/, "");
const ICHIMOKU = (process.env.SIGNAL_URL || "https://ichimoku-signal.fizzl.eu").replace(/\/$/, "");
const INTERVALS = ["4h", "1d"];

// Voxight names each window's direction. Rising talk: accelerating or building; fading: cooling or quiet.
export const RISING = new Set(["accelerating", "building"]);
export const FADING = new Set(["cooling", "quiet"]);
// The window that sets the lean: a day of talk, not a single burst. The 1h window is shown too.
export const LEAD_WINDOW = "24h";

const args = process.argv.slice(2);
const symbol = (args.find((a) => !a.startsWith("--")) || "SOL").toUpperCase().replace(/^\$/, "");
const dryRun = args.includes("--dry-run");
const asJson = args.includes("--json");

// ---------------------------------------------------------------- reading the inputs

export function readAttention(body) {
  const data = body?.data;
  const windows = Array.isArray(data?.windows) ? data.windows : [];
  if (!windows.length) return { available: false, reason: "no attention windows in the answer" };
  const byName = Object.fromEntries(windows.map((w) => [String(w.window), w]));
  const lead = byName[LEAD_WINDOW] || windows[Math.floor(windows.length / 2)];
  const voices = data.last_hour_voices || {};
  const trend = String(lead.trend || "unknown");
  return {
    available: true,
    at: data.at || null,
    lead: { window: lead.window, mentions: lead.mentions, changePct: lead.change_pct ?? null, trend },
    hour: byName["1h"] ? { mentions: byName["1h"].mentions, trend: byName["1h"].trend } : null,
    voices: {
      accounts: voices.distinct_accounts ?? null,
      duplicateShare: voices.duplicate_share ?? null,
      topAccountShare: voices.top_account_share ?? null,
      shillSuspected: voices.shill_suspected === true,
      shillReasons: Array.isArray(voices.shill_reasons) ? voices.shill_reasons : [],
    },
    lean: RISING.has(trend) ? "rising" : FADING.has(trend) ? "fading" : "flat",
  };
}

export function readCloud(signal) {
  return {
    interval: signal?.interval,
    timestamp: signal?.timestamp,
    price: signal?.price,
    cloud: signal?.cloud_position || "unknown",
    signal: signal?.signal,
  };
}

// ---------------------------------------------------------------- the read

export function combine({ attention, clouds }) {
  const below = clouds.filter((c) => c.cloud === "below_cloud").length;
  const above = clouds.filter((c) => c.cloud === "above_cloud").length;
  const trend = below === clouds.length ? "bearish" : above === clouds.length ? "bullish" : "mixed";
  const where = clouds.map((c) => `${c.cloud.replace("_", " ")} on ${c.interval}`).join(", ");

  if (!attention.available) return { verdict: "no_read", trend, read: `No attention data (${attention.reason}). Price is ${where}.` };
  const talk = `${attention.lead.window} talk ${attention.lead.trend}${attention.lead.changePct != null ? ` (${attention.lead.changePct >= 0 ? "+" : ""}${Math.round(attention.lead.changePct)}%)` : ""}`;

  // Coordinated talk comes first: a pump that looks like attention is the case to catch.
  if (attention.voices.shillSuspected) {
    return { verdict: "suspect_talk", trend, read: `The talk looks coordinated (${attention.voices.shillReasons.join("; ") || "Voxight flags it"}), ${talk}, while price is ${where}. Treat the attention as noise until it broadens.` };
  }
  if (attention.lean === "rising" && trend === "bearish") return { verdict: "hype_against_trend", trend, read: `${cap(talk)} while price is ${where}: attention is rising into a downtrend.` };
  if (attention.lean === "rising" && trend === "bullish") return { verdict: "talk_confirms_trend", trend, read: `${cap(talk)} and price is ${where}: attention and trend agree.` };
  if (attention.lean === "fading" && trend === "bullish") return { verdict: "quiet_uptrend", trend, read: `${cap(talk)} while price is ${where}: the trend holds without the crowd.` };
  if (attention.lean === "fading" && trend === "bearish") return { verdict: "fading_both", trend, read: `${cap(talk)} and price is ${where}: interest and trend are both fading.` };
  return { verdict: "no_clear_read", trend, read: `${cap(talk)}; price is ${where}. No clear lean.` };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- calls

function preferBase(_version, requirements) {
  const option = requirements.find((r) => r.network === BASE);
  if (!option) throw new Error(`no Base option offered (networks: ${requirements.map((r) => r.network).join(", ")})`);
  return option;
}

async function priceOf(url) {
  const res = await fetch(url);
  if (res.status !== 402) return `HTTP ${res.status} (expected 402)`;
  const header = res.headers.get("payment-required");
  const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json();
  const base = (challenge.accepts || []).find((a) => a.network === BASE);
  return base ? `$${Number(base.amount) / 1e6} USDC on Base` : "no Base option";
}

async function main() {
  const urls = {
    attention: `${VOXIGHT}/api/coin-attention?symbol=${encodeURIComponent(symbol)}`,
    ...Object.fromEntries(INTERVALS.map((i) => [`ichimoku_${i}`, `${ICHIMOKU}/signal/${symbol}-USDT?interval=${i}`])),
  };

  if (dryRun) {
    for (const [name, url] of Object.entries(urls)) console.log(`${name.padEnd(12)} ${await priceOf(url)}  ${url}`);
    return;
  }

  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) throw new Error("set EVM_PRIVATE_KEY (a dedicated wallet with USDC on Base), or use --dry-run");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const client = new x402Client(preferBase).register(BASE, new ExactEvmScheme(account)).setSpendControls({ maxAmountPerPayment: "$0.20" });
  const pay = wrapFetchWithPayment(fetch, client);

  const receipts = [];
  const get = async (name, url) => {
    const res = await pay(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const header = res.headers.get("payment-response");
    if (header) receipts.push({ call: name, tx: decodePaymentResponseHeader(header).transaction });
    return res.json();
  };

  // Ichimoku first: a pair it can't read (an unlisted coin) stops the run before the $0.16 call.
  const signals = await Promise.all(INTERVALS.map((i) => get(`ichimoku_${i}`, urls[`ichimoku_${i}`])));
  const attentionRaw = await get("attention", urls.attention);

  const attention = readAttention(attentionRaw);
  const clouds = signals.map(readCloud);
  const result = { symbol, ...combine({ attention, clouds }), inputs: { attention, clouds }, receipts, note: "Example of combining two x402 services; not trade advice." };

  if (asJson) return console.log(JSON.stringify(result, null, 2));
  console.log(`\n${symbol}: ${result.verdict.toUpperCase().replace(/_/g, " ")}\n${result.read}\n`);
  if (attention.available) {
    const v = attention.voices;
    console.log(`Attention   ${attention.lead.window}: ${attention.lead.mentions} mentions, ${attention.lead.trend}${attention.hour ? `; last hour ${attention.hour.mentions}, ${attention.hour.trend}` : ""}  [${attention.at || "live"}]`);
    console.log(`Voices      ${v.accounts ?? "?"} accounts in the last hour, duplicates ${pct(v.duplicateShare)}, top account ${pct(v.topAccountShare)}${v.shillSuspected ? ", coordinated talk suspected" : ""}`);
  } else {
    console.log(`Attention   unavailable (${attention.reason})`);
  }
  for (const c of clouds) console.log(`Ichimoku    ${c.interval}: ${c.cloud.replace("_", " ")}, signal ${c.signal}  [${c.timestamp}]`);
  console.log(`\nPaid: ${receipts.map((r) => `${r.call} ${r.tx}`).join(" · ")}`);
}

const pct = (n) => (n == null ? "?" : `${Math.round(n * 100)}%`);

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
