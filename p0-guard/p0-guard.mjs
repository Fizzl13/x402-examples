// P0 + presign-guard: Project 0 builds the transaction, presign-guard checks it, your wallet signs.
//
// Project 0 (https://ai.0.xyz, MCP or REST) builds unsigned Solana transactions for lending
// actions: deposit, withdraw, borrow, repay, loop, close-position. The agent's own wallet signs.
// This script puts an independent check in between: each transaction goes to presign-guard
// ($0.01 a check, paid with x402 in USDC on Solana), which decodes it, simulates it, and screens
// the accounts involved. Only on green does the wallet sign.
//
//   SOLANA_PRIVATE_KEY  base58 secret key (as Phantom exports it) or a JSON byte array
//   SOLANA_SEED         or: any long random password (32+ characters); the wallet is derived
//                       from it. `--address` prints that wallet's address, to fund it.
//   SOLANA_RPC_URL      optional: the RPC that sends the transactions (default: public mainnet)
//
// Usage (in this folder, after npm install):
//   node p0-guard.mjs deposit bank=2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB amount=1 --authority <wallet> --dry-run
//   SOLANA_SEED=... node p0-guard.mjs deposit bank=<bank> amount=1          # checks (pays $0.01 each), signs nothing
//   SOLANA_SEED=... node p0-guard.mjs deposit bank=<bank> amount=1 --send   # checks, then signs and sends each green step
//   ... --json   # the whole report as JSON
//
// Without --send nothing is signed or sent. P0 returns "sequential" steps (for example: create
// the account, then deposit): each is checked just before it is signed, after the step before has
// landed, so without --send only the first step is checked. "bundle" steps (one Jito bundle) are
// all checked but never sent by this script.
//
// Use a dedicated wallet: USDC for the checks and the action, a little SOL for network fees.

import { createHash } from "node:crypto";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const P0 = (process.env.P0_URL || "https://ai.0.xyz").replace(/\/$/, "");
const GUARD = (process.env.PRESIGN_GUARD_URL || "https://presign-guard.fizzl.eu").replace(/\/$/, "");
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
export const ACTIONS = ["create-account", "deposit", "withdraw", "borrow", "repay", "loop", "close-position"];

// `deposit bank=… amount=1 --send` → the action, P0's parameters (numbers and booleans typed) and the flags.
export function parseArgs(argv) {
  const flags = { dryRun: argv.includes("--dry-run"), send: argv.includes("--send"), json: argv.includes("--json"), address: argv.includes("--address") };
  const i = argv.indexOf("--authority");
  if (i >= 0) flags.authority = argv[i + 1];
  const words = argv.filter((a, j) => !a.startsWith("--") && argv[j - 1] !== "--authority");
  const params = {};
  for (const w of words.slice(1)) {
    const eq = w.indexOf("=");
    if (eq < 1) throw new Error(`"${w}": give P0's parameters as name=value, e.g. amount=1`);
    const v = w.slice(eq + 1);
    params[w.slice(0, eq)] = v === "true" ? true : v === "false" ? false : v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return { action: words[0], params, flags };
}

// P0's REST builder: POST /v1/tx/<action>. An error comes back as { error, code, details }.
export async function p0Build(action, params, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${P0}/v1/tx/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || !Array.isArray(body.transactions)) {
    throw new Error(`Project 0 built nothing: ${body?.code ? `${body.code}: ` : ""}${body?.error ?? `HTTP ${res.status}`}`);
  }
  return body;
}

// What the agent says it is doing, in one sentence: presign-guard compares it with what signing does.
export function intentOf(env) {
  const what = env.amount_ui != null && env.symbol ? ` ${env.amount_ui} ${env.symbol}` : "";
  const lev = env.leverage ? ` at ${env.leverage}x leverage` : "";
  return `${env.action ?? "act"}${what}${lev} on Project 0 (lending)`;
}

// Which steps to check now. Sequential: one at a time, each after the one before has landed, so
// without --send only the first. Bundle: all of them, and none is sent.
export function stepsToCheck(env, send) {
  const n = env.transactions.length;
  if (env.submit === "bundle") return [...Array(n).keys()];
  return send ? [...Array(n).keys()] : [0];
}

// What the agent does with a verdict. On a later sequential step, orange with missingAccounts means
// the step before it hasn't landed yet: not a risk, but nothing to sign now either.
export function decide(result, index = 0) {
  const fails = result?.reasons?.find((r) => r.code === "SIMULATION_FAILS");
  if (result?.verdict === "green") return { action: "go", why: "no red flags; the simulation shows what leaves the wallet" };
  if (result?.verdict === "orange" && index > 0 && fails?.details?.missingAccounts?.length && result.reasons.every((r) => r.severity !== "orange" || r.code === "SIMULATION_FAILS")) {
    return { action: "wait", why: "it needs the step before it on-chain first; check it again after that one has landed" };
  }
  if (result?.verdict === "orange") return { action: "ask", why: "risks a person should weigh first" };
  if (result?.verdict === "red") return { action: "stop", why: "red flags: never sign this" };
  return { action: "stop", why: "no verdict" };
}

// One paid check ($0.01): the wire transaction, the wallet that signs, and the intent.
export async function checkTx(base64, { pay, from, intent }) {
  const res = await pay(`${GUARD}/v1/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "solana", transaction: base64, from, intent }) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(`presign-guard: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// The price of a check, from the 402 (nothing paid).
export async function checkPrice(base64, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GUARD}/v1/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "solana", transaction: base64 }) });
  if (res.status !== 402) return null;
  const header = res.headers.get("payment-required");
  const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json();
  const sol = challenge.accepts.find((a) => a.network === SOLANA);
  return sol ? Number(sol.amount) / 1e6 : null;
}

// Signs P0's unsigned transaction with the wallet, only when the wallet is one of its signers.
export async function signTx(base64, signer) {
  const kit = await import("@solana/kit");
  const tx = kit.getTransactionDecoder().decode(kit.getBase64Encoder().encode(base64));
  if (!(signer.address in tx.signatures)) throw new Error(`this transaction is not for ${signer.address}: it wants ${Object.keys(tx.signatures).join(", ")}`);
  const signed = await kit.partiallySignTransaction([signer.keyPair], tx);
  return { base64: kit.getBase64EncodedWireTransaction(signed), signature: kit.getBase58Decoder().decode(signed.signatures[signer.address]) };
}

async function rpc(method, params, fetchImpl) {
  const res = await fetchImpl(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`Solana RPC: ${body.error.message}`);
  return body.result;
}

// Sends a signed transaction and waits until it is confirmed. A landed transaction with an error
// counts as failed (P0's docs say the same).
export async function sendAndConfirm({ base64, signature }, { fetchImpl = fetch, timeoutMs = 60_000, pollMs = 1500 } = {}) {
  await rpc("sendTransaction", [base64, { encoding: "base64", preflightCommitment: "confirmed" }], fetchImpl);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = (await rpc("getSignatureStatuses", [[signature]], fetchImpl))?.value?.[0];
    if (st?.err) throw new Error(`the transaction landed with an error: ${JSON.stringify(st.err)} (https://solscan.io/tx/${signature})`);
    if (st && ["confirmed", "finalized"].includes(st.confirmationStatus)) return signature;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`not confirmed within ${timeoutMs / 1000} s: https://solscan.io/tx/${signature}`);
}

// The whole flow: P0 builds, presign-guard checks each step, the wallet signs and sends on green
// (with send). Returns a report; nothing is signed when a step is not green.
export async function run({ action, params, authority, send = false, fetchImpl = fetch, pay, signer, sender = sendAndConfirm }) {
  const env = await p0Build(action, { ...params, authority }, { fetchImpl });
  const intent = intentOf(env);
  const report = { action: env.action, authority, account: env.account ?? null, submit: env.submit, intent, p0_simulation: env.simulation ?? null, steps: [] };
  const willSend = send && env.submit !== "bundle";
  for (const i of stepsToCheck(env, send)) {
    const t = env.transactions[i];
    const result = await checkTx(t.base64, { pay, from: authority, intent });
    const decision = decide(result, i);
    const step = { index: i, type: t.type ?? null, label: t.label ?? null, verdict: result.verdict, decision, reasons: (result.reasons ?? []).filter((r) => r.severity !== "info").map((r) => r.code), changes: result.simulation?.changes ?? null };
    report.steps.push(step);
    if (decision.action !== "go") { report.stopped = { at: i, ...decision }; break; }
    if (willSend) step.sent = await sender(await signTx(t.base64, signer), { fetchImpl });
  }
  if (env.submit === "bundle") report.next = "bundle: sign all with the returned blockhash and send them together as one Jito bundle; this script does not send bundles";
  else if (!report.stopped && report.steps.length < env.transactions.length) {
    report.not_checked = env.transactions.length - report.steps.length;
    report.next = "the next steps are checked after this one has landed: run with --send";
  }
  report.paid_usd = report.steps.length * 0.01;
  report.ok = !report.stopped;
  return report;
}

// Phantom exports a base58 string; Solana CLI keypair files are a JSON array of 64 bytes.
export async function solanaKeyBytes(secret) {
  const s = String(secret).trim();
  let bytes;
  if (s.startsWith("[")) bytes = new Uint8Array(JSON.parse(s));
  else {
    const { getBase58Encoder } = await import("@solana/kit");
    bytes = new Uint8Array(getBase58Encoder().encode(s));
  }
  if (bytes.length === 32) throw new Error("SOLANA_PRIVATE_KEY is 32 bytes: that looks like the wallet address (public key). Use the private key: in Phantom, Show private key (about 88 characters).");
  if (bytes.length !== 64) throw new Error(`SOLANA_PRIVATE_KEY must be a 64-byte secret key (got ${bytes.length} bytes)`);
  return bytes;
}

// SOLANA_SEED: a long random password becomes the wallet's 32-byte private key (SHA-256).
export const MIN_SEED_LENGTH = 32;
export function seedBytes(seed) {
  const s = String(seed).trim();
  if (s.length < MIN_SEED_LENGTH) throw new Error(`SOLANA_SEED must be at least ${MIN_SEED_LENGTH} characters of random text`);
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

export async function solanaSigner(env) {
  const kit = await import("@solana/kit");
  if (env.SOLANA_PRIVATE_KEY) return kit.createKeyPairSignerFromBytes(await solanaKeyBytes(env.SOLANA_PRIVATE_KEY));
  if (env.SOLANA_SEED) return kit.createKeyPairSignerFromPrivateKeyBytes(seedBytes(env.SOLANA_SEED));
  throw new Error("Set SOLANA_PRIVATE_KEY or SOLANA_SEED, or use --dry-run with --authority <wallet>");
}

async function payingFetch(signer) {
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const client = new x402Client((_version, accepts) => {
    const pick = accepts.find((a) => a.network === SOLANA);
    if (!pick) throw new Error("presign-guard does not offer payment on Solana");
    return pick;
  }).setSpendControls({ maxAmountPerPayment: "$0.02" }); // a check costs $0.01; never pay more than twice that
  client.register(SOLANA, new ExactSvmScheme(signer, process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined));
  return wrapFetchWithPayment(fetch, client);
}

function print(report) {
  console.log(`${report.intent} · account ${report.account ?? "new"} · ${report.submit}`);
  for (const s of report.steps) {
    const out = (s.changes ?? []).filter((c) => c.type === "sol" || c.type === "token").map((c) => `${c.change > 0 ? "+" : ""}${c.change} ${c.type === "sol" ? "SOL" : c.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? "USDC" : c.mint.slice(0, 6) + "…"}`);
    console.log(`  step ${s.index + 1} ${s.label ?? s.type ?? ""}: ${s.verdict} → ${s.decision.action.toUpperCase()}${out.length ? ` (wallet: ${out.join(", ")})` : ""}${s.reasons.length ? ` [${s.reasons.join(", ")}]` : ""}${s.sent ? ` sent: https://solscan.io/tx/${s.sent}` : ""}`);
  }
  if (report.stopped) console.log(`Stopped at step ${report.stopped.at + 1}: ${report.stopped.why}`);
  if (report.next) console.log(report.next);
  console.log(`Checks paid: $${report.paid_usd.toFixed(2)} (USDC on Solana)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { action, params, flags } = parseArgs(argv);
  if (flags.address) {
    const signer = await solanaSigner(process.env);
    console.log(`Wallet address: ${signer.address}\nFund it with USDC (for the checks and the action) and a little SOL (network fees): https://solscan.io/account/${signer.address}`);
    return;
  }
  if (!ACTIONS.includes(action)) {
    console.error(`usage: node p0-guard.mjs <${ACTIONS.join("|")}> name=value… [--dry-run --authority <wallet>] [--send] [--json]`);
    process.exit(2);
  }
  if (flags.dryRun) {
    const authority = flags.authority ?? (await solanaSigner(process.env)).address;
    const env = await p0Build(action, { ...params, authority });
    const price = await checkPrice(env.transactions[0].base64);
    const out = { action: env.action, authority, account: env.account ?? null, submit: env.submit, intent: intentOf(env), steps: env.transactions.map((t) => t.label ?? t.type), p0_simulation: env.simulation ?? null, check_price_usdc: price, nothing_paid: true };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const signer = await solanaSigner(process.env);
  const report = await run({ action, params, authority: signer.address, send: flags.send, pay: await payingFetch(signer), signer });
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
