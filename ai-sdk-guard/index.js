// Fizzl safety checks as Vercel AI SDK tools: an agent built with the AI SDK (generateText, streamText,
// ToolLoopAgent) can check a transaction or signature before signing, a token before buying, a wallet's open
// approvals, and an x402 endpoint before paying it. Each tool calls a paid Fizzl API (presign-guard or
// x402 Doctor) through the fetch you pass: an x402-paying fetch (@x402/fetch) or prepaid credit keys.
//
// The tools only check; they never sign, pay or move anything themselves. A failed check comes back as
// { error } so the model can tell the user, never as an exception that ends the run.
import { z } from "zod";

export const PRESIGN_URL = "https://presign-guard.fizzl.eu";
export const DOCTOR_URL = "https://x402-doctor.fizzl.eu";
export const PRICES = { check_before_signing: "$0.01", check_token: "$0.01", check_wallet_approvals: "$0.02", check_endpoint_before_paying: "$0.001" };

const EVM_CHAIN_IDS = [1, 10, 56, 137, 8453, 42161];
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);

async function call(fetchImpl, url, { method = "GET", body, creditKey, timeoutMs }) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { accept: "application/json", "user-agent": "presign-guard-ai-sdk/0.1.0", ...(body ? { "content-type": "application/json" } : {}), ...(creditKey ? { "x-credit-key": creditKey } : {}) },
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

/**
 * The Fizzl tools for the AI SDK: pass the result as `tools` to generateText/streamText or an agent.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetch that pays x402 (wrapFetchWithPayment from @x402/fetch); plain fetch works with credit keys
 * @param {{ presign?: string, doctor?: string }} [options.creditKeys] prepaid credit keys (x-credit-key) per service
 * @param {string[]} [options.only] the tool names to include (default: all four)
 * @param {string} [options.presignUrl] @param {string} [options.doctorUrl] @param {number} [options.timeoutMs]
 */
export function fizzlTools({ fetch: fetchImpl = globalThis.fetch, creditKeys = {}, only, presignUrl = PRESIGN_URL, doctorUrl = DOCTOR_URL, timeoutMs = 30000 } = {}) {
  const presign = (path, opts) => call(fetchImpl, `${presignUrl}${path}`, { creditKey: creditKeys.presign, timeoutMs, ...opts });
  const doctor = (path, opts) => call(fetchImpl, `${doctorUrl}${path}`, { creditKey: creditKeys.doctor, timeoutMs, ...opts });

  const all = {
    check_before_signing: {
      description: `Check a transaction, token approval or signature BEFORE signing it (presign-guard, ${PRICES.check_before_signing}). Returns verdict green/orange/red with reason codes: known drainers, unlimited approvals to unknown spenders, look-alike tokens, Permit/Permit2/Seaport signatures that hand over tokens, x402 payments to the wrong place. Never sign on red; ask the user on orange.`,
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
      }),
      execute: async (input) => presign("/v1/check", { method: "POST", body: input }),
    },
    check_token: {
      description: `Check a token BEFORE buying, holding or accepting it (presign-guard, ${PRICES.check_token}): honeypot, rug-pull signs (mint or freeze authority, unlocked liquidity, buy/sell tax), look-alikes of known tokens. Solana and EVM chains.`,
      inputSchema: z.object({
        chain: z.enum(["solana", "base", "ethereum", "arbitrum", "optimism", "polygon", "bsc"]),
        address: z.string().min(20).describe("Solana mint (base58) or EVM token contract (0x…)"),
      }),
      execute: async ({ chain, address }) => presign(`/v1/token?${new URLSearchParams({ chain, address })}`, {}),
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
        return doctor(`/api/v1/preflight?${q}`, {});
      },
    },
  };
  if (!only) return all;
  const unknown = only.filter((n) => !(n in all));
  if (unknown.length) throw new Error(`unknown Fizzl tool(s): ${unknown.join(", ")}`);
  return Object.fromEntries(only.map((n) => [n, all[n]]));
}
