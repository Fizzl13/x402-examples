// Swaps for the connector (Frits, 17 Nov 2026: "Voor iedereen en bouw"). An agent asks to swap a token on Base; the
// owner signs it in their own wallet, like a payment: Fizzl never holds a key.
//
// What the server does before the owner sees it:
// - Only Base, only USDC, EURC and WETH, only Uniswap's official SwapRouter02 (exactInputSingle) at the best of its fee
//   tiers, quoted on-chain with Uniswap's QuoterV2 (no third-party API, no key).
// - The minimum out is the quote less the owner's slippage (default 0.5%); the recipient is always the owner.
// - When the router may not yet spend the token, an approval of exactly the amount comes first, never unlimited.
// - The owner's swap limits (off by default; $50 per swap, $100 per day by default), counted in USD of the input.
// - Every transaction is checked by presign-guard (internal access, FIZZL_INTERNAL_KEY) and must come back with a
//   verdict bound to exactly that transaction (presign-guard#291): checkBinding must say MATCH. Red is refused;
//   orange is shown to the owner with its reasons. Without the key, swaps are off: no unchecked swap is offered.
import { encodeFunctionData, decodeFunctionResult, parseAbi, getAddress, formatUnits, parseUnits } from "viem";
import { checkBinding } from "presign-guard-wallet/binding";

export const CHAIN_ID = 8453;
export const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // Uniswap SwapRouter02 on Base
export const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"; // Uniswap QuoterV2 on Base
export const TOKENS = {
  USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, usd: true },
  EURC: { symbol: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 },
  WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
};
const ALIASES = { ETH: "WETH" }; // the agent says ETH; it gets WETH (wrapped ETH, an ERC-20)
const FEES = [100, 500, 3000, 10000];
export const SWAP_DEFAULTS = { on: false, perSwapUsd: 50, perDayUsd: 100, slipBps: 50 };
export const SWAP_MAX = { perSwapUsd: 1000, perDayUsd: 5000, slipBps: 300 };

const ERC20 = parseAbi(["function approve(address spender,uint256 amount)", "function allowance(address owner,address spender) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]);
const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
const ROUTER_ABI = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"]);

/** The token for a symbol the agent used ("usdc", "ETH"), or null. */
export function tokenOf(symbol) {
  const s = String(symbol ?? "").trim().toUpperCase();
  return TOKENS[ALIASES[s] ?? s] ?? null;
}

/** The owner's swap settings, cleaned: within SWAP_MAX, defaults where missing. */
export function cleanSwapSettings(s = {}) {
  const num = (v, d, max, min = 0) => (Number.isFinite(Number(v)) && Number(v) >= min ? Math.min(Number(v), max) : d);
  return {
    on: s.on === true,
    perSwapUsd: num(s.perSwapUsd, SWAP_DEFAULTS.perSwapUsd, SWAP_MAX.perSwapUsd, 1),
    perDayUsd: num(s.perDayUsd, SWAP_DEFAULTS.perDayUsd, SWAP_MAX.perDayUsd, 1),
    slipBps: Math.round(num(s.slipBps, SWAP_DEFAULTS.slipBps, SWAP_MAX.slipBps, 1)),
  };
}

/** Parse the agent's ask; an error text or the swap. */
export function parseSwap({ from_token, to_token, amount } = {}) {
  const tokenIn = tokenOf(from_token), tokenOut = tokenOf(to_token);
  if (!tokenIn || !tokenOut) return { error: `Swaps take ${Object.keys(TOKENS).join(", ")} (or ETH, swapped as WETH) on Base.` };
  if (tokenIn === tokenOut) return { error: "from_token and to_token are the same." };
  let amountIn;
  try { amountIn = parseUnits(String(amount ?? "").trim(), tokenIn.decimals); } catch { return { error: `amount: a number of ${tokenIn.symbol}, like "40".` }; }
  if (amountIn <= 0n) return { error: "amount must be more than 0." };
  return { tokenIn, tokenOut, amountIn };
}

/**
 * The swap engine. `rpc(method, params)` reads Base; `presign(tx, intent)` returns presign-guard's signed answer for a
 * transaction (or throws); `now()` is the clock.
 */
export function createSwaps({ rpc, presign, now = () => Date.now(), signers } = {}) {
  const call = async (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

  async function quote(tokenIn, tokenOut, amountIn) {
    let best = null;
    for (const fee of FEES) {
      try {
        const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee, sqrtPriceLimitX96: 0n }] });
        const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: await call(QUOTER, data) });
        if (!best || amountOut > best.amountOut) best = { fee, amountOut };
      } catch { /* no pool at this fee */ }
    }
    return best;
  }

  /** What the input is worth in USD (USDC 1:1, else quoted to USDC), for the limits. */
  async function usdOf(tokenIn, amountIn) {
    if (tokenIn.usd) return Number(formatUnits(amountIn, tokenIn.decimals));
    const q = await quote(tokenIn, TOKENS.USDC, amountIn);
    return q ? Number(formatUnits(q.amountOut, 6)) : null;
  }

  /** The transactions for a swap: an approval of exactly the amount when needed, then exactInputSingle to the owner. */
  async function build({ owner, tokenIn, tokenOut, amountIn, slipBps }) {
    const from = getAddress(owner);
    const q = await quote(tokenIn, tokenOut, amountIn);
    if (!q || q.amountOut === 0n) return { error: `No Uniswap pool on Base swaps ${tokenIn.symbol} to ${tokenOut.symbol} for this amount.` };
    const minOut = (q.amountOut * BigInt(10_000 - slipBps)) / 10_000n;
    const [allowance, balance] = await Promise.all([
      call(tokenIn.address, encodeFunctionData({ abi: ERC20, functionName: "allowance", args: [from, ROUTER] })).then((d) => BigInt(d)),
      call(tokenIn.address, encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [from] })).then((d) => BigInt(d)),
    ]);
    if (balance < amountIn) return { error: `The owner's wallet ${from.slice(0, 6)}…${from.slice(-4)} has ${formatUnits(balance, tokenIn.decimals)} ${tokenIn.symbol} on Base, less than ${formatUnits(amountIn, tokenIn.decimals)}.` };
    const txs = [];
    if (allowance < amountIn) {
      txs.push({ kind: "approve", tx: { chainId: CHAIN_ID, from, to: tokenIn.address, value: "0", data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [ROUTER, amountIn] }) } });
    }
    txs.push({ kind: "swap", tx: { chainId: CHAIN_ID, from, to: ROUTER, value: "0", data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee: q.fee, recipient: from, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }) } });
    return {
      fee: q.fee, amountOut: q.amountOut, minOut, txs,
      view: { pay: `${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`, expected: `${formatUnits(q.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`, atLeast: `${formatUnits(minOut, tokenOut.decimals)} ${tokenOut.symbol}`, route: `Uniswap v3 · ${q.fee / 10_000}% pool · Base`, slip: `${slipBps / 100}%`, approval: txs[0].kind === "approve" ? `exactly ${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}` : "not needed" },
    };
  }

  /** presign-guard's verdict on each transaction, bound to it. Red, or anything not MATCH, stops the swap. */
  async function check(txs, intent) {
    const out = [];
    for (const t of txs) {
      let answer;
      try { answer = await presign(t.tx, intent); } catch (err) { return { error: `presign-guard could not check the ${t.kind}: ${err.message}. Nothing was offered.` }; }
      const b = checkBinding(t.tx, answer, { ...(signers ? { signers } : {}), now: now() });
      if (b.result !== "MATCH") return { error: `presign-guard's verdict on the ${t.kind} is ${b.result}${b.reason ? ` (${b.reason})` : ""}. Nothing was offered.` };
      if (answer.verdict === "red") return { error: `presign-guard says red for the ${t.kind}: ${(answer.reasons ?? []).filter((r) => r.severity !== "info").map((r) => r.code).join(", ") || "do not sign"}. Nothing was offered.`, red: true };
      out.push({ ...t, verdict: answer.verdict, reasons: (answer.reasons ?? []).filter((r) => r.severity !== "info").map((r) => ({ code: r.code, message: r.message ?? null })), validUntil: b.valid_until, receiptId: answer.receipt?.request_id ?? null, answer });
    }
    return { checked: out };
  }

  return { quote, usdOf, build, check };
}

/** presign-guard over HTTP with internal access (no x402 payment between Fizzl's own services). */
export function presignClient({ url, key, fetch: fetchImpl = globalThis.fetch }) {
  if (!url || !key || String(key).length < 32) return null;
  return async (tx, intent) => {
    const res = await fetchImpl(`${url}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fizzl-internal": key, "user-agent": "fizzl-wallet-swap" },
      body: JSON.stringify({ type: "transaction", chainId: tx.chainId, from: tx.from, to: tx.to, value: tx.value, data: tx.data, ...(intent ? { intent } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

/** A JSON-RPC reader for Base. */
export function rpcClient(url, fetchImpl = globalThis.fetch) {
  let n = 0;
  return async (method, params) => {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }), signal: AbortSignal.timeout(15_000) });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message ?? "rpc error");
    return j.result;
  };
}
