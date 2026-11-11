// The command line's own wallet, and its link to a Fizzl Agent Wallet (wallet.fizzl.eu).
//
// init makes a dedicated wallet for the command line: a new key in ~/.x402-safe-fetch/wallet.json (readable by you
// only), so nobody has to paste a private key. connect links that wallet to the owner's Fizzl Agent Wallet with a
// code the owner approves on their phone (the same link Claude Desktop's wallet uses: /v1/pair). Once linked, every
// payment is first reserved on the wallet server: the owner's limits apply, and above them the owner is asked
// (Telegram or the dashboard) before anything is signed. The key never leaves this computer.

import fs from "node:fs";
import path from "node:path";
import { SafePayError } from "./index.js";

export const WALLET_URL = "https://wallet.fizzl.eu";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = "https://mainnet.base.org";
export const ONRAMP_URL = "https://x402-doctor.fizzl.eu/api/onramp";

// A link to buy USDC on Base with a card at Coinbase, delivered to `address`. Each visit starts a new Coinbase session
// (x402 Doctor asks Coinbase Onramp for it); the buyer pays Coinbase and Fizzl never holds the money.
export function buyUsdcUrl(address, { amount = 5 } = {}) {
  return `${ONRAMP_URL}?${new URLSearchParams({ address, amount: String(amount) })}`;
}

export function walletFile(home) {
  return path.join(home, "wallet.json");
}

export function readWallet(home) {
  try {
    const w = JSON.parse(fs.readFileSync(walletFile(home), "utf8"));
    return /^0x[0-9a-fA-F]{64}$/.test(w?.privateKey ?? "") ? w : null;
  } catch {
    return null;
  }
}

export function writeWallet(home, wallet) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = walletFile(home);
  fs.writeFileSync(file, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not on every file system */ }
}

// A wallet for this computer: the existing one, or a new key. Needs viem (a peer dependency of x402-safe-fetch).
export async function ensureWallet(home) {
  const existing = readWallet(home);
  if (existing) return { wallet: existing, created: false };
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const wallet = { address: privateKeyToAccount(privateKey).address, privateKey, createdAt: new Date().toISOString() };
  writeWallet(home, wallet);
  return { wallet, created: true };
}

// USDC on Base held by `address`, in dollars (null when the network can't be read).
export async function usdcBalance(address, { fetch = globalThis.fetch, rpc = BASE_RPC } = {}) {
  try {
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: BASE_USDC, data }, "latest"] }) });
    const j = await res.json();
    return typeof j?.result === "string" && j.result.startsWith("0x") ? Number(BigInt(j.result)) / 1e6 : null;
  } catch {
    return null;
  }
}

async function call(fetch, base, key, method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`wallet server ${p}: ${data?.message ?? data?.error ?? `HTTP ${res.status}`}`);
  return data;
}

/**
 * Links this wallet to a Fizzl Agent Wallet: asks for a code, shows it (onCode), and waits until the owner approves it
 * where they are signed in. Returns { url, key, agent }. The code is useless without the token kept here.
 */
export async function pair({ address, label = "x402-safe-fetch", url = WALLET_URL, fetch = globalThis.fetch, onCode, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const base = url.replace(/\/$/, "");
  const start = await call(fetch, base, null, "POST", "/v1/pair/start", { address, label });
  if (!start?.code || !start?.token) throw new Error("wallet server: no pairing code");
  const link = start.url || `${base}/pair?code=${start.code}`;
  onCode?.({ code: start.code, url: link, expiresIn: start.expiresIn ?? 600 });
  const until = now() + (Number(start.expiresIn) || 600) * 1000;
  const every = Math.max(1, Number(start.interval) || 3) * 1000;
  while (now() < until) {
    await sleep(every);
    const p = await call(fetch, base, null, "POST", "/v1/pair/poll", { token: start.token });
    if (p?.status === "linked" && typeof p.key === "string") return { url: base, key: p.key, agent: p.agent ?? null };
  }
  throw new Error("the code expired before it was approved (10 minutes); run connect again");
}

/**
 * A signer that asks the owner's wallet server before each signature (reserve), waits for the owner's approval when
 * a limit is reached, and reports what was signed afterwards (finish). Throws SafePayError wallet_denied or
 * wallet_paused when the server says no; `denied` keeps the last refusal for the caller.
 */
export function serverSigner({ account, server, fetch = globalThis.fetch, purchase, onWait, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const base = server.url.replace(/\/$/, "");
  const reserved = [];
  const state = { denied: null };
  const deny = (code, summary) => {
    state.denied = { code, summary };
    throw new SafePayError(`not paid: your Fizzl wallet says no: ${summary}`, { code });
  };
  return {
    address: account.address,
    state,
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData;
      const request = { type: "signature", chainId: Number(domain?.chainId ?? 8453), typedData: { domain, types, primaryType, message } };
      let r = await call(fetch, base, server.key, "POST", "/v1/reserve", { method: "signTypedData", request, verdict: null, purchase });
      if (r.status === "pending") {
        onWait?.(r.summary);
        const deadline = (r.expiresAt ?? now() + 600_000) + 10_000;
        let a = null;
        while (now() < deadline) {
          a = await call(fetch, base, server.key, "GET", `/v1/approvals/${encodeURIComponent(r.approvalId)}?wait=25`);
          if (a.status !== "pending") break;
          await sleep(1000);
        }
        if (a?.status === "approved") r = { status: "ok", entries: a.entries ?? [], purchaseId: a.purchaseId ?? null };
        else deny("wallet_denied", `${r.summary} (${a?.status === "denied" ? "denied by the owner" : "no answer in time"})`);
      }
      if (r.status === "paused") deny("wallet_paused", r.summary || "paused");
      if (r.status === "denied") deny("wallet_denied", r.summary || "over a hard limit");
      if (r.status !== "ok") throw new Error(`wallet server: unexpected answer ${r.status}`);
      reserved.push({ entries: r.entries ?? [], purchaseId: r.purchaseId ?? null });
      return account.signTypedData(typedData);
    },
    // After the call: every signed payment counts as spent (a signed authorization can be settled by the seller).
    async finish(result) {
      for (const r of reserved.splice(0)) {
        if (!r.entries.length) continue;
        await call(fetch, base, server.key, "POST", "/v1/spent", { entries: r.entries, result: String(result ?? ""), ...(r.purchaseId ? { purchaseId: r.purchaseId } : {}) }).catch(() => {});
      }
    },
  };
}
