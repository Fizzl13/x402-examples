// Fizzl safety checks as Vercel AI SDK tools: an agent built with the AI SDK (generateText, streamText,
// ToolLoopAgent) can check a transaction or signature before signing, a token before buying, a wallet's open
// approvals, and an x402 endpoint before paying it. Each tool calls a paid Fizzl API (presign-guard or
// x402 Doctor) through the fetch you pass: an x402-paying fetch (@x402/fetch) or prepaid credit keys.
//
// The tools only check; they never sign, pay or move anything themselves. A failed check comes back as
// { error } so the model can tell the user, never as an exception that ends the run.
import { z } from "zod";

export const VERSION = "0.4.0";
export const PRESIGN_URL = "https://presign-guard.fizzl.eu";
export const DOCTOR_URL = "https://x402-doctor.fizzl.eu";
export const PRICES = { check_before_signing: "$0.01", check_xrpl_transaction: "$0.01", check_token: "$0.01", check_wallet_approvals: "$0.02", check_endpoint_before_paying: "$0.001" };

const EVM_CHAIN_IDS = [1, 10, 56, 137, 8453, 42161];
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);

async function call(fetchImpl, url, { method = "GET", body, creditKey, timeoutMs }) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { accept: "application/json", "user-agent": `presign-guard-ai-sdk/${VERSION}`, ...(body ? { "content-type": "application/json" } : {}), ...(creditKey ? { "x-credit-key": creditKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 402) return { error: "payment_required", message: "This check is paid (x402). Pass an x402-paying fetch (wrapFetchWithPayment from @x402/fetch) or a prepaid credit key to fizzlTools()." };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) return { error: `http_${res.status}`, message: String(json?.error ?? json?.message ?? text).slice(0, 300) };
    if (!json || typeof json !== "object") return { error: "bad_response", message: "The check did not answer JSON." };
    // The signed receipt is for audits, not for the model: leave it out of the tool result.
    const { receipt, ...rest } = json;
    return rest;
  } catch (err) {
    return { error: "check_failed", message: `${err.name}: ${err.message}` };
  }
}

// Free quick checks, used when a paid check can't be paid (no payer or credit key yet, or the payment failed):
// the verdict only, rate-limited per hour by the services. They let an agent (and its developer) try the tools
// before setting up payment; the answer says so and what the full check costs.
const FREE_NOTE = (price) => `Free quick check: the verdict only, a few per hour. The full check (reasons and details) costs ${price} via x402 or prepaid credits.`;

async function freePresignCheck(fetchImpl, presignUrl, input, timeoutMs) {
  try {
    const res = await fetchImpl(`${presignUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": `presign-guard-ai-sdk/${VERSION}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "presign_quick_check", arguments: input } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    const line = raw.trimStart().startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) || "").slice(5);
    const text = JSON.parse(line)?.result?.content?.[0]?.text;
    const out = JSON.parse(text);
    return out && typeof out === "object" && out.verdict ? out : null;
  } catch { return null; }
}

async function freeTokenCheck(fetchImpl, presignUrl, { chain, address }, timeoutMs) {
  try {
    const res = await fetchImpl(`${presignUrl}/v1/token/quick?${new URLSearchParams({ chain, address })}`, { headers: { accept: "application/json", "user-agent": `presign-guard-ai-sdk/${VERSION}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const out = await res.json();
    return out && out.verdict ? out : null;
  } catch { return null; }
}

// The free web check of x402 Doctor: overall pass/warn/fail, read as go/caution/no_go, with the problems found.
async function freeEndpointCheck(fetchImpl, doctorUrl, { url, method }, timeoutMs) {
  try {
    const res = await fetchImpl(`${doctorUrl}/api/diagnose`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": `presign-guard-ai-sdk/${VERSION}` }, body: JSON.stringify({ url, ...(method ? { method } : {}) }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const d = await res.json();
    const verdict = { pass: "go", warn: "caution", fail: "no_go" }[d?.overall];
    if (!verdict) return null;
    const problems = (d.checks || []).filter((c) => c.status === "fail" || c.status === "warn").slice(0, 6).map((c) => ({ status: c.status, id: c.id, message: c.message }));
    return { verdict, problems, report: d.share_url };
  } catch { return null; }
}

/**
 * The Fizzl tools for the AI SDK: pass the result as `tools` to generateText/streamText or an agent.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetch that pays x402 (wrapFetchWithPayment from @x402/fetch); plain fetch works with credit keys
 * @param {{ presign?: string, doctor?: string }} [options.creditKeys] prepaid credit keys (x-credit-key) per service
 * @param {string[]} [options.only] the tool names to include (default: all four)
 * @param {boolean} [options.free] fall back to the free quick checks when a check can't be paid (default true)
 * @param {string} [options.presignUrl] @param {string} [options.doctorUrl] @param {number} [options.timeoutMs]
 */
export function fizzlTools({ fetch: fetchImpl = globalThis.fetch, creditKeys = {}, only, free = true, presignUrl = PRESIGN_URL, doctorUrl = DOCTOR_URL, timeoutMs = 30000 } = {}) {
  // A paid answer, or (when it can't be paid and `free` is on) the free quick check with a note.
  const orFree = async (paid, price, quick) => {
    if (paid?.error !== "payment_required" || !free) return paid;
    const q = await quick();
    return q ? { ...q, free: true, note: FREE_NOTE(price), payment: paid.message } : paid;
  };
  const presign = (path, opts) => call(fetchImpl, `${presignUrl}${path}`, { creditKey: creditKeys.presign, timeoutMs, ...opts });
  const doctor = (path, opts) => call(fetchImpl, `${doctorUrl}${path}`, { creditKey: creditKeys.doctor, timeoutMs, ...opts });

  const all = {
    check_before_signing: {
      description: `Check a transaction, token approval or signature BEFORE signing it (presign-guard, ${PRICES.check_before_signing}). Returns verdict green/orange/red with reason codes: known drainers, unlimited approvals to unknown spenders, look-alike tokens, Permit/Permit2/Seaport signatures that hand over tokens, x402 payments to the wrong place. Pass from (your wallet) with a transaction to simulate it, intent to catch signing something else than you meant, and x402 (the accepts entry) when paying an x402 challenge. Never sign on red; ask the user on orange.`,
      inputSchema: z.object({
        type: z.enum(["approval", "transaction", "signature"]).describe("What is about to be signed"),
        chainId: z.number().int().refine((n) => EVM_CHAIN_IDS.includes(n), "supported: 1, 10, 56, 137, 8453, 42161").describe("EVM chain id, e.g. 8453 for Base"),
        token: z.string().optional().describe("approval: token contract"),
        spender: z.string().optional().describe("approval: who gets the allowance"),
        amount: z.string().optional().describe("approval: amount in base units (0 = revoke)"),
        to: z.string().optional().describe("transaction: target contract or recipient"),
        data: hex.optional().describe("transaction: 0x-prefixed calldata"),
        value: z.string().optional().describe("transaction: native value in wei"),
        typedData: z.union([z.record(z.string(), z.any()), z.string()]).optional().describe("signature: the eth_signTypedData_v4 payload"),
        origin: z.string().optional().describe("the site asking for the signature or transaction, if any"),
        from: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("transaction: your wallet address; the transaction is then simulated, so you see what really leaves the wallet (orange HIDDEN_APPROVAL, SIMULATION_NFT_OUT, SIMULATION_FAILS)"),
        intent: z.string().max(500).optional().describe("what you are trying to do, in one sentence (e.g. \"swap 10 USDC for ETH\"); orange INTENT_MISMATCH when signing does more or something else"),
        x402: z.record(z.string(), z.any()).optional().describe("signature paying an x402 challenge: the accepts entry you chose ({ accepted: { scheme, network, amount, asset, payTo, maxTimeoutSeconds } }); red when the signature pays more, someone else, another token or chain"),
      }),
      execute: async (input) => orFree(await presign("/v1/check", { method: "POST", body: input }), PRICES.check_before_signing, () => freePresignCheck(fetchImpl, presignUrl, input, timeoutMs)),
    },
    check_xrpl_transaction: {
      description: `Check an XRP Ledger transaction BEFORE signing it (presign-guard, ${PRICES.check_xrpl_transaction}). Red: handing the account to another key (SetRegularKey, SignerListSet, disabling the master key), AccountDelete, fake RLUSD. Orange: partial payments, destinations that refuse or need a destination tag, trust lines or DEX buys of tokens whose issuer can claw back, freeze or charge fees, DEX orders far below the order book or AMM price, escrows and NFT giveaways. Never sign on red; ask the user on orange.`,
      inputSchema: z.object({
        tx: z.record(z.string(), z.any()).refine((t) => typeof t.TransactionType === "string" && typeof t.Account === "string", "tx needs TransactionType and Account").describe("The unsigned transaction JSON (TransactionType, Account, ...)"),
        network: z.enum(["xrpl:0", "xrpl:1"]).optional().describe("xrpl:0 mainnet (default) or xrpl:1 testnet"),
        origin: z.string().optional().describe("the site asking for the signature, if any"),
      }),
      execute: async ({ tx, network, origin }) => presign("/v1/check", { method: "POST", body: { type: "xrpl", tx, ...(network && { network }), ...(origin && { origin }) } }),
    },
    check_token: {
      description: `Check a token BEFORE buying, holding or accepting it (presign-guard, ${PRICES.check_token}): honeypot, rug-pull signs (mint or freeze authority, unlocked liquidity, buy/sell tax), look-alikes of known tokens. Solana, EVM chains and the XRP Ledger (issuer clawback, freeze, transfer fee, fake RLUSD).`,
      inputSchema: z.object({
        chain: z.enum(["solana", "base", "ethereum", "arbitrum", "optimism", "polygon", "bsc", "xrpl"]),
        address: z.string().min(20).describe("Solana mint (base58), EVM token contract (0x…), or an XRPL token as CURRENCY.rIssuer (e.g. RLUSD.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De)"),
      }),
      execute: async ({ chain, address }) => orFree(await presign(`/v1/token?${new URLSearchParams({ chain, address })}`, {}), PRICES.check_token, () => freeTokenCheck(fetchImpl, presignUrl, { chain, address }, timeoutMs)),
    },
    check_wallet_approvals: {
      description: `List every open token approval of an EVM wallet and which ones to revoke (presign-guard, ${PRICES.check_wallet_approvals}).`,
      inputSchema: z.object({
        chain: z.enum(["base", "ethereum", "arbitrum", "optimism", "polygon", "bsc"]),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Wallet address (0x…)"),
      }),
      execute: async ({ chain, address }) => presign(`/v1/approvals?${new URLSearchParams({ chain, address })}`, {}),
    },
    check_endpoint_before_paying: {
      description: `Check an x402 or MPP paid API BEFORE paying it (x402 Doctor, ${PRICES.check_endpoint_before_paying}): go / caution / no_go, the cheapest option that will settle, whether it is over your budget, its track record, and bait signs (fake brands, airdrop lures, output that does not match). Do not pay on no_go; tell the user on caution.`,
      inputSchema: z.object({
        url: z.string().url().describe("The paid endpoint you are about to pay"),
        max_usd: z.number().positive().optional().describe("Your budget for this call in USD"),
        network: z.string().optional().describe("CAIP-2 network you want to pay on, e.g. eip155:8453"),
        method: z.enum(["GET", "POST"]).optional(),
      }),
      execute: async ({ url, max_usd, network, method }) => {
        const q = new URLSearchParams({ url });
        if (max_usd !== undefined) q.set("max_usd", String(max_usd));
        if (network) q.set("network", network);
        if (method) q.set("method", method);
        return orFree(await doctor(`/api/v1/preflight?${q}`, {}), PRICES.check_endpoint_before_paying, () => freeEndpointCheck(fetchImpl, doctorUrl, { url, method }, timeoutMs));
      },
    },
  };
  if (!only) return all;
  const unknown = only.filter((n) => !(n in all));
  if (unknown.length) throw new Error(`unknown Fizzl tool(s): ${unknown.join(", ")}`);
  return Object.fromEntries(only.map((n) => [n, all[n]]));
}
