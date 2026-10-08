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
// Pays with x402 in USDC, on Base, Solana or Algorand (the same keys as token-check):
//   EVM_PRIVATE_KEY     0x-prefixed or bare hex private key (MetaMask exports it bare)
//   SOLANA_PRIVATE_KEY  base58 secret key, or a JSON byte array
//   SOLANA_SEED         or: a long random password the Solana wallet is derived from
//   ALGORAND_MNEMONIC   the 25-word mnemonic of an Algorand account that has opted in to USDC (ASA 31566704),
//                       or the 24-word recovery phrase of a Pera wallet (HD, ARC-52): then the first of its accounts
//                       that holds USDC pays (ALGORAND_ADDRESS picks one). The seller's facilitator pays the network
//                       fee, so the account needs no ALGO beyond the minimum balance
//
// Usage (in this folder, after npm install):
//   node safe-pay.mjs https://ichimoku-signal.fizzl.eu/signal/BTC-USDT --dry-run   # prices only, pays nothing
//   EVM_PRIVATE_KEY=... node safe-pay.mjs https://ichimoku-signal.fizzl.eu/signal/BTC-USDT --max-usd 0.05
//   SOLANA_SEED=... node safe-pay.mjs "https://presign-guard.fizzl.eu/v1/token?chain=solana&address=<mint>" --pay-on solana
//   ... --method POST --body '{"type":"approval",...}'   # for POST endpoints
//   ... --json                                          # everything as JSON
//
// Use a dedicated wallet with a few cents of USDC.

import { createHash } from "node:crypto";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";

export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const BASE = "eip155:8453";
export const ALGORAND = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
// Where the Fizzl services are paid on Algorand. A paying wallet must never also control it.
export const FIZZL_ALGORAND_PAY_TO = "LOYVFSQ6ZTS2YWUW4GQ5L6VPP2TPIOXWYDACK53CPOHQQHLDMEMKJDXAX4";
const ALGORAND_USDC = 31566704;
const DOCTOR = (process.env.DOCTOR_URL || "https://x402-doctor.fizzl.eu").replace(/\/$/, "");
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
  const byName = { base: BASE, solana: SOLANA, algorand: ALGORAND };
  if (payOn) {
    if (!byName[payOn]) throw new Error("--pay-on must be base, solana or algorand");
    return byName[payOn];
  }
  if (env.EVM_PRIVATE_KEY) return BASE;
  if (env.SOLANA_PRIVATE_KEY || env.SOLANA_SEED) return SOLANA;
  if (env.ALGORAND_MNEMONIC) return ALGORAND;
  return null;
}

// The base64 secret key @x402/avm wants (32-byte seed + 32-byte public key), from a 25-word Algorand mnemonic.
export const mnemonicWords = (mnemonic) => String(mnemonic).toLowerCase().match(/[a-z]+/g) || [];

// Wallets copy it in different shapes ("1. word", commas, capitals, one word per line): only the words count.
// Errors never include a word, since the message ends up in a workflow log.
export async function algorandKey(mnemonic) {
  const { seedFromMnemonic, NOT_IN_WORDS_LIST_ERROR_MSG } = await import("@algorandfoundation/algokit-utils/algo25");
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const words = mnemonicWords(mnemonic);
  if (words.length !== 25) throw new Error(`ALGORAND_MNEMONIC has ${words.length} words, an Algorand mnemonic has 25`);
  let raw;
  try { raw = seedFromMnemonic(words.join(" ")); } catch (e) {
    throw new Error(e.message === NOT_IN_WORDS_LIST_ERROR_MSG
      ? "ALGORAND_MNEMONIC has a word that is not in the Algorand word list (a typo?)"
      : "ALGORAND_MNEMONIC: the 25 words don't add up (the last one is a checksum); check the order and spelling");
  }
  const seed = Buffer.from(raw);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([seed, pub]).toString("base64");
}

// Pera's newer wallets are HD wallets (ARC-52): a 24-word BIP39 recovery phrase, account n at m/44'/283'/n'/0/i.
// ARC-52 has two derivation modes (Peikert, the libraries' default, and Khovratovich); which one a wallet used isn't
// visible from the words, so both are derived and the account that holds USDC decides.
export const HD_PATHS = [...Array.from({ length: 10 }, (_, a) => [a, 0]), [0, 1], [0, 2], [0, 3], [0, 4]];

export async function algorandHdAccounts(mnemonic, paths = HD_PATHS) {
  const { validateMnemonic, mnemonicToSeedSync } = await import("@scure/bip39");
  const { wordlist } = await import("@scure/bip39/wordlists/english");
  const phrase = mnemonicWords(mnemonic).join(" ");
  if (!validateMnemonic(phrase, wordlist)) throw new Error("ALGORAND_MNEMONIC: the 24 words are not a valid recovery phrase; check the order and spelling");
  const { XHDWalletAPI, fromSeed, KeyContext, BIP32DerivationType } = await import("@algorandfoundation/xhd-wallet-api");
  const xhd = new XHDWalletAPI();
  const root = fromSeed(Buffer.from(mnemonicToSeedSync(phrase)));
  const accounts = [];
  for (const mode of ["Peikert", "Khovratovich"]) {
    const type = BIP32DerivationType[mode];
    for (const [account, index] of paths) {
      accounts.push({
        mode, account, index,
        ed25519Pubkey: await xhd.keyGen(root, KeyContext.Address, account, index, type),
        rawEd25519Signer: (bytes) => xhd.signAlgoTransaction(root, KeyContext.Address, account, index, bytes, type),
      });
    }
  }
  return accounts;
}

// The same ClientAvmSigner as @x402/avm's toClientAvmSigner, for a key that isn't a plain 32-byte seed.
export async function avmSigner({ ed25519Pubkey, rawEd25519Signer }) {
  const { generateAddressWithSigners, decodeTransaction } = await import("@algorandfoundation/algokit-utils/transact");
  const { ALGOKIT_SIGNER } = await import("@x402/avm");
  const signers = generateAddressWithSigners({ ed25519Pubkey, rawEd25519Signer });
  const signer = {
    address: signers.addr.toString(),
    signTransactions: (txns, indexesToSign) => Promise.all(txns.map(async (txn, i) =>
      indexesToSign && !indexesToSign.includes(i) ? null : (await signers.signer([decodeTransaction(txn)], [0]))[0])),
  };
  Object.defineProperty(signer, ALGOKIT_SIGNER, { value: signers, enumerable: false, writable: false });
  return signer;
}

async function holdsUsdc(address, algodUrl) {
  const res = await fetch(`${algodUrl}/v2/accounts/${address}`);
  if (!res.ok) return false;
  const { assets = [] } = await res.json();
  return assets.some((a) => a["asset-id"] === ALGORAND_USDC && a.amount > 0);
}

// The signer for ALGORAND_MNEMONIC: a 25-word account as is; from a 24-word HD wallet, ALGORAND_ADDRESS or the first
// account that holds USDC. Refuses a wallet that also controls the Fizzl pay-to address.
export async function algorandSigner(mnemonic, { algodUrl, address, holds = holdsUsdc } = {}) {
  if (mnemonicWords(mnemonic).length !== 24) {
    const { toClientAvmSigner } = await import("@x402/avm");
    return toClientAvmSigner(await algorandKey(mnemonic));
  }
  const signers = await Promise.all((await algorandHdAccounts(mnemonic)).map(avmSigner));
  if (signers.some((s) => s.address === FIZZL_ALGORAND_PAY_TO)) {
    throw new Error(`ALGORAND_MNEMONIC also controls ${FIZZL_ALGORAND_PAY_TO}, where Fizzl is paid; use a separate wallet with its own recovery phrase`);
  }
  if (address) {
    const picked = signers.find((s) => s.address === address);
    if (!picked) throw new Error(`ALGORAND_ADDRESS ${address} is not one of the first accounts of this wallet`);
    return picked;
  }
  for (const s of signers) if (await holds(s.address, algodUrl)) return s;
  throw new Error(`none of the first accounts of this wallet holds USDC: ${signers.map((s) => s.address).join(", ")}`);
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
  if (network === ALGORAND) return `https://allo.info/tx/${tx}`;
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
  if (network === ALGORAND) {
    const { ExactAvmScheme } = await import("@x402/avm/exact/client");
    const algodUrl = process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud";
    const signer = await algorandSigner(process.env.ALGORAND_MNEMONIC, { algodUrl, address: process.env.ALGORAND_ADDRESS });
    client.register(ALGORAND, new ExactAvmScheme(signer, { algodUrl }));
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
    console.error("usage: node safe-pay.mjs <https URL of an x402 endpoint> [--method GET|POST] [--body JSON] [--max-usd 0.05] [--pay-on base|solana|algorand] [--accept-caution] [--dry-run] [--json]");
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
