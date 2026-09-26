// Safe pay: before an agent pays an x402 endpoint it has never used, it pays
// $0.001 for a preflight from x402 Doctor and acts on it:
//   no_go   → stop (the payment would fail, is over budget, or should not be made)
//   caution → stop and ask the user (or pay anyway with --accept-caution)
//   go      → pay the endpoint, on the option Doctor recommends, within the budget
//
// The preflight reads the endpoint's 402 challenge and checks, among others:
// the price against your budget and against what the service advertises, that
// the option is payable on your network (USDC, a valid payout address, a Solana
// payout account that exists), HTTPS, and whether it is listed in the CDP Bazaar.
//
// Pays with x402 in USDC, on Base or Solana (the same keys as token-check):
//   EVM_PRIVATE_KEY     0x-prefixed or bare hex private key (MetaMask exports it bare)
//   SOLANA_PRIVATE_KEY  base58 secret key, or a JSON byte array
//   SOLANA_SEED         or: a long random password the Solana wallet is derived from
//
// Usage (in this folder, after npm install):
//   node safe-pay.mjs https://ichimoku-signal.onrender.com/signal/BTC-USDT --dry-run   # prices only, pays nothing
//   EVM_PRIVATE_KEY=... node safe-pay.mjs https://ichimoku-signal.onrender.com/signal/BTC-USDT --max-usd 0.05
//   SOLANA_SEED=... node safe-pay.mjs "https://presign-guard.onrender.com/v1/token?chain=solana&address=<mint>" --pay-on solana
//   ... --method POST --body '{"type":"approval",...}'   # for POST endpoints
//   ... --json                                          # everything as JSON
//
// Use a dedicated wallet with a few cents of USDC.

import { createHash } from "node:crypto";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";

export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const BASE = "eip155:8453";
const DOCTOR = (process.env.DOCTOR_URL || "https://x402-doctor.onrender.com").replace(/\/$/, "");
export const PREFLIGHT_CAP = "$0.002"; // the preflight costs $0.001; never pay more than twice that

// What the agent does with the preflight.
export function decide(preflight, { acceptCaution = false } = {}) {
  if (!preflight || !preflight.verdict) return { action: "stop", why: "no preflight verdict" };
  if (preflight.verdict === "no_go") return { action: "stop", why: preflight.summary || "Doctor says do not pay" };
  if (preflight.verdict === "caution" && !acceptCaution) return { action: "ask", why: preflight.summary || "payable, with caution" };
  return { action: "pay", why: preflight.summary || "OK to pay" };
}

export function preflightUrl(target, { method, maxUsd, network } = {}) {
  const q = new URLSearchParams({ url: target });
  if (method) q.set("method", method);
  if (maxUsd) q.set("max_usd", String(maxUsd));
  if (network) q.set("network", network);
  return `${DOCTOR}/api/v1/preflight?${q}`;
}

// A USD amount as the spend-control string x402 expects: "$0.05".
export function usdCap(maxUsd) {
  const n = Number(maxUsd);
  if (!(n > 0)) throw new Error("--max-usd must be a positive number, e.g. 0.05");
  if (n > 1) throw new Error("--max-usd above $1 is refused in this example");
  return `$${Number(n.toFixed(6))}`;
}

// Which network pays: --pay-on wins, else Base when its key is set, else Solana.
export function payNetwork(env, payOn) {
  if (payOn === "solana" || payOn === "base") return payOn === "solana" ? SOLANA : BASE;
  if (payOn) throw new Error("--pay-on must be base or solana");
  if (env.EVM_PRIVATE_KEY) return BASE;
  if (env.SOLANA_PRIVATE_KEY || env.SOLANA_SEED) return SOLANA;
  return null;
}

export function evmKey(key) {
  const k = String(key).trim();
  return k.startsWith("0x") ? k : `0x${k}`;
}

export function seedBytes(seed) {
  const s = String(seed).trim();
  if (s.length < 32) throw new Error("SOLANA_SEED must be at least 32 characters of random text");
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

async function solanaSigner(env) {
  const kit = await import("@solana/kit");
  if (env.SOLANA_SEED && !env.SOLANA_PRIVATE_KEY) return kit.createKeyPairSignerFromPrivateKeyBytes(seedBytes(env.SOLANA_SEED));
  const s = String(env.SOLANA_PRIVATE_KEY || "").trim();
  const bytes = s.startsWith("[") ? new Uint8Array(JSON.parse(s)) : new Uint8Array(kit.getBase58Encoder().encode(s));
  if (bytes.length !== 64) throw new Error(`SOLANA_PRIVATE_KEY must be a 64-byte secret key (got ${bytes.length} bytes${bytes.length === 32 ? ": that looks like the wallet address" : ""})`);
  return kit.createKeyPairSignerFromBytes(bytes);
}

export function explorerUrl(network, tx) {
  if (!tx) return null;
  return network === SOLANA ? `https://solscan.io/tx/${tx}` : `https://basescan.org/tx/${tx}`;
}

// A fetch that pays on one network, never more than `cap` per call.
async function payingFetch(network, cap) {
  const client = new x402Client((_version, accepts) => {
    const pick = accepts.find((a) => a.network === network);
    if (!pick) throw new Error(`no payment option on ${network}`);
    return pick;
  }).setSpendControls({ maxAmountPerPayment: cap });
  if (network === SOLANA) {
    const { ExactSvmScheme } = await import("@x402/svm/exact/client");
    const signer = await solanaSigner(process.env);
    client.register(SOLANA, new ExactSvmScheme(signer, process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined));
    return { fetch: wrapFetchWithPayment(fetch, client), payer: signer.address };
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const account = privateKeyToAccount(evmKey(process.env.EVM_PRIVATE_KEY));
  client.register(BASE, new ExactEvmScheme(account));
  return { fetch: wrapFetchWithPayment(fetch, client), payer: account.address };
}

async function priceOf(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.headers || {}) } });
  if (res.status !== 402) return { status: res.status };
  const header = res.headers.get("payment-required");
  const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json();
  return { status: 402, accepts: challenge.accepts.map((a) => ({ network: a.network, usd: Number(a.amount) / 1e6, payTo: a.payTo })) };
}

const receiptOf = (res, network) => {
  const header = res.headers.get("payment-response");
  const r = header ? decodePaymentResponseHeader(header) : null;
  return { network, transaction: r?.transaction ?? null, explorer: explorerUrl(network, r?.transaction) };
};

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const valued = new Set(["--method", "--body", "--max-usd", "--pay-on"]);
  const target = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  if (!target || !/^https:\/\//.test(target)) {
    console.error("usage: node safe-pay.mjs <https URL of an x402 endpoint> [--method GET|POST] [--body JSON] [--max-usd 0.05] [--pay-on base|solana] [--accept-caution] [--dry-run] [--json]");
    process.exit(2);
  }
  const method = (flag("--method") || "GET").toUpperCase();
  const body = flag("--body");
  const maxUsd = flag("--max-usd") || "0.05";
  const cap = usdCap(maxUsd);
  const init = method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: body ?? "{}" };

  if (args.includes("--dry-run")) {
    const [pre, tgt] = await Promise.all([priceOf(preflightUrl(target, { method, maxUsd })), priceOf(target, init)]);
    console.log(JSON.stringify({ preflight: pre, endpoint: tgt, budget_usd: Number(maxUsd) }, null, 2));
    return;
  }

  const network = payNetwork(process.env, flag("--pay-on"));
  if (!network) {
    console.error("Set EVM_PRIVATE_KEY, SOLANA_SEED or SOLANA_PRIVATE_KEY (a dedicated wallet with a few cents of USDC), or use --dry-run.");
    process.exit(2);
  }

  // 1. The preflight, $0.001.
  const doctor = await payingFetch(network, PREFLIGHT_CAP);
  const preRes = await doctor.fetch(preflightUrl(target, { method, maxUsd, network }), { headers: { accept: "application/json" } });
  const preflight = await preRes.json().catch(() => null);
  if (!preRes.ok) {
    console.error(`preflight failed: HTTP ${preRes.status} ${JSON.stringify(preflight)}`);
    process.exit(1);
  }
  const decision = decide(preflight, { acceptCaution: args.includes("--accept-caution") });
  const out = {
    target,
    preflight: { verdict: preflight.verdict, summary: preflight.summary, reasons: preflight.reasons, signals: preflight.signals, payment: receiptOf(preRes, network) },
    decision,
    payer: doctor.payer,
  };

  // 2. The endpoint itself, only on "pay", never above the budget.
  if (decision.action === "pay") {
    const pay = await payingFetch(network, cap);
    const res = await pay.fetch(target, init);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
    out.endpoint = { status: res.status, payment: res.ok ? receiptOf(res, network) : null, response: data };
  }

  if (args.includes("--json")) { console.log(JSON.stringify(out, null, 2)); return; }
  const prePaid = out.preflight.payment.explorer;
  console.log(`Preflight (paid $0.001${prePaid ? `: ${prePaid}` : ""}): ${preflight.verdict.toUpperCase()}: ${preflight.summary}`);
  for (const r of preflight.reasons || []) console.log(`  - ${r.level}: ${r.message}`);
  console.log(`Decision: ${decision.action.toUpperCase()} (${decision.why})`);
  if (out.endpoint) {
    console.log(`Endpoint: HTTP ${out.endpoint.status}${out.endpoint.payment?.explorer ? `, paid: ${out.endpoint.payment.explorer}` : ""}`);
    console.log(typeof out.endpoint.response === "string" ? out.endpoint.response : JSON.stringify(out.endpoint.response).slice(0, 400));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
