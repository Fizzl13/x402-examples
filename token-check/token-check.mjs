// Token check: before an agent buys, holds or accepts a token, it pays $0.01 for a
// verdict from presign-guard and acts on it: green = go, orange = ask your user,
// red = stop.
//
// Pays with x402 in USDC, on Solana or on Base:
//   SOLANA_PRIVATE_KEY  base58 secret key (as Phantom exports it) or a JSON byte array
//   EVM_PRIVATE_KEY     0x-prefixed private key
// With both set, Solana is used unless you pass --pay-on base.
// On Solana the facilitator pays the network fee: the wallet needs USDC only.
//
// Usage (in this folder, after npm install):
//   node token-check.mjs solana DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --dry-run   # the price, pays nothing
//   SOLANA_PRIVATE_KEY=... node token-check.mjs solana <mint>
//   EVM_PRIVATE_KEY=0x... node token-check.mjs base 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed --pay-on base
//   ... --json   # the full verdict and the payment receipt as JSON
//
// Use a dedicated wallet with a few cents of USDC. Not financial advice: a green
// verdict means no known red flags, not that a token will hold its value.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";

export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const BASE = "eip155:8453";
const SERVICE = (process.env.TOKEN_VERDICT_URL || "https://presign-guard.onrender.com").replace(/\/$/, "");
export const CHAINS = ["solana", "base", "ethereum", "arbitrum", "optimism", "polygon", "bsc"];

// What an agent does with the verdict.
export function decide(result) {
  if (result.verdict === "red") return { action: "stop", why: "red flags on the token itself" };
  if (result.verdict === "orange") return { action: "ask", why: "risks a person should weigh first" };
  if (result.verdict === "green") return { action: "go", why: "no known red flags" };
  return { action: "stop", why: "no verdict" };
}

// Which network pays: --pay-on wins, else Solana when its key is set, else Base.
export function payNetwork(env, payOn) {
  if (payOn === "solana" || payOn === "base") return payOn === "solana" ? SOLANA : BASE;
  if (payOn) throw new Error("--pay-on must be solana or base");
  if (env.SOLANA_PRIVATE_KEY) return SOLANA;
  if (env.EVM_PRIVATE_KEY) return BASE;
  return null;
}

// Phantom exports a base58 string; Solana CLI keypair files are a JSON array of 64 bytes.
export async function solanaKeyBytes(secret) {
  const s = String(secret).trim();
  if (s.startsWith("[")) return new Uint8Array(JSON.parse(s));
  const { getBase58Encoder } = await import("@solana/kit");
  return new Uint8Array(getBase58Encoder().encode(s));
}

export function explorerUrl(network, tx) {
  if (!tx) return null;
  return network === SOLANA ? `https://solscan.io/tx/${tx}` : `https://basescan.org/tx/${tx}`;
}

export function tokenUrl(chain, address) {
  return `${SERVICE}/v1/token?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`;
}

async function payingFetch(network) {
  const client = new x402Client((_version, accepts) => {
    const pick = accepts.find((a) => a.network === network);
    if (!pick) throw new Error(`the service does not offer payment on ${network}`);
    return pick;
  }).setSpendControls({ maxAmountPerPayment: "$0.02" }); // the verdict costs $0.01; never pay more than twice that
  if (network === SOLANA) {
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const { ExactSvmScheme } = await import("@x402/svm/exact/client");
    const signer = await createKeyPairSignerFromBytes(await solanaKeyBytes(process.env.SOLANA_PRIVATE_KEY));
    client.register(SOLANA, new ExactSvmScheme(signer, process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined));
    return { fetch: wrapFetchWithPayment(fetch, client), payer: signer.address };
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
  client.register(BASE, new ExactEvmScheme(account));
  return { fetch: wrapFetchWithPayment(fetch, client), payer: account.address };
}

async function priceOnly(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status !== 402) return { status: res.status, body: await res.json().catch(() => null) };
  const header = res.headers.get("payment-required");
  const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json();
  return {
    status: 402,
    accepts: challenge.accepts.map((a) => ({ network: a.network, usdc: Number(a.amount) / 1e6, payTo: a.payTo })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--pay-on");
  const [chain, address] = positional;
  if (!CHAINS.includes(chain) || !address) {
    console.error(`usage: node token-check.mjs <${CHAINS.join("|")}> <token address> [--dry-run] [--json] [--pay-on solana|base]`);
    process.exit(2);
  }
  const url = tokenUrl(chain, address);

  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(await priceOnly(url), null, 2));
    return;
  }

  const network = payNetwork(process.env, flag("--pay-on"));
  if (!network) {
    console.error("Set SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY (a dedicated wallet with a few cents of USDC), or use --dry-run.");
    process.exit(2);
  }
  const { fetch: pay, payer } = await payingFetch(network);
  const res = await pay(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  const header = res.headers.get("payment-response");
  const receipt = header ? decodePaymentResponseHeader(header) : null;
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    process.exit(1);
  }

  const decision = decide(body);
  const out = {
    token: body.token,
    verdict: body.verdict,
    grade: body.grade,
    one_liner: body.one_liner,
    decision,
    reasons: body.reasons,
    market: body.market,
    payment: {
      network,
      payer,
      transaction: receipt?.transaction ?? null,
      explorer: explorerUrl(network, receipt?.transaction),
    },
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const sym = body.token?.symbol ? `${body.token.symbol} ` : "";
  console.log(`${sym}(${chain}): ${body.one_liner}`);
  console.log(`Agent action: ${decision.action.toUpperCase()} (${decision.why})`);
  for (const r of body.reasons.filter((x) => x.severity !== "info")) console.log(`  - ${r.severity}: ${r.code}`);
  console.log(`Paid $0.01 on ${network === SOLANA ? "Solana" : "Base"} from ${payer}${out.payment.explorer ? `: ${out.payment.explorer}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
