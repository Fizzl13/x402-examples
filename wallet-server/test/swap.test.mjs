// Swaps from the connector: Uniswap on Base, the owner's limits, presign-guard's verdict bound to each transaction,
// and the owner's own wallet sending it (src/swap.js, src/connector-swap.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "x402-safe-fetch";
import { normaliseTx, txSha256 } from "presign-guard-wallet/binding";
import { memoryStore } from "../src/store.js";
import { createSwaps, parseSwap, cleanSwapSettings, TOKENS, ROUTER, QUOTER } from "../src/swap.js";
import { createSwapRequests } from "../src/connector-swap.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
const ERC20 = parseAbi(["function approve(address spender,uint256 amount)", "function allowance(address owner,address spender) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]);
const ROUTER_ABI = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"]);

/** A fake Base: QuoterV2 (best at the 0.05% pool), allowance, balance, and sent transactions. */
function fakeBase({ allowance = 0n, balance = 1_000_000_000n, chain = {} } = {}) {
  return async (method, params) => {
    if (method === "eth_call") {
      const { to, data } = params[0];
      if (to === QUOTER) {
        const { args } = decodeFunctionData({ abi: QUOTER_ABI, data });
        const p = args[0];
        const out = p.fee === 500 ? (p.amountIn * 555_000_000_000n) : p.fee === 3000 ? (p.amountIn * 550_000_000_000n) : null;
        if (out === null) throw new Error("no pool");
        return encodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", result: [out, 0n, 0, 0n] });
      }
      const call = decodeFunctionData({ abi: ERC20, data });
      if (call.functionName === "allowance") return `0x${allowance.toString(16).padStart(64, "0")}`;
      if (call.functionName === "balanceOf") return `0x${balance.toString(16).padStart(64, "0")}`;
    }
    if (method === "eth_getTransactionByHash") return chain[params[0]]?.tx ?? null;
    if (method === "eth_getTransactionReceipt") return chain[params[0]]?.receipt ?? null;
    throw new Error(`unexpected ${method}`);
  };
}

/** A fake presign-guard: a signed answer whose binding covers exactly the checked tx. */
function fakePresign({ verdict = "green", bindTo = null, now = () => Date.now() } = {}) {
  const calls = [];
  const fn = async (tx) => {
    calls.push(tx);
    const t = normaliseTx(bindTo ?? tx);
    const body = { verdict, reasons: verdict === "green" ? [] : [{ code: "UNLIMITED_APPROVAL", severity: verdict === "red" ? "high" : "medium", message: "test" }] };
    const receipt = { request_id: `r${calls.length}`, route: "POST /v1/check", input_sha256: "x", binding: { scope: "evm-tx-v1", tx: t, tx_sha256: txSha256(t), valid_until: new Date(now() + 120_000).toISOString() }, signed_at: new Date(now()).toISOString(), signer: signer.address, algorithm: "eip191-canonical-json-v1" };
    const signature = await signer.signMessage({ message: canonicalJson({ ...body, receipt }) });
    return { ...body, receipt: { ...receipt, signature } };
  };
  fn.calls = calls;
  return fn;
}

test("swap ask: only USDC, EURC, WETH (ETH as WETH), positive amounts; settings within bounds", () => {
  assert.equal(parseSwap({ from_token: "usdc", to_token: "ETH", amount: "40" }).tokenOut, TOKENS.WETH);
  assert.equal(parseSwap({ from_token: "usdc", to_token: "ETH", amount: "40" }).amountIn, 40_000_000n);
  assert.match(parseSwap({ from_token: "DOGE", to_token: "USDC", amount: "1" }).error, /USDC, EURC, WETH/);
  assert.match(parseSwap({ from_token: "USDC", to_token: "USDC", amount: "1" }).error, /same/);
  assert.match(parseSwap({ from_token: "USDC", to_token: "WETH", amount: "0" }).error, /more than 0/);
  assert.deepEqual(cleanSwapSettings({}), { on: false, perSwapUsd: 50, perDayUsd: 100, slipBps: 50 });
  assert.deepEqual(cleanSwapSettings({ on: true, perSwapUsd: 99999, perDayUsd: -1, slipBps: 5000 }), { on: true, perSwapUsd: 1000, perDayUsd: 100, slipBps: 300 });
});

test("swap build: the best pool, minimum out after slippage, an approval of exactly the amount, the owner as recipient", async () => {
  const swaps = createSwaps({ rpc: fakeBase(), presign: fakePresign(), signers: [signer.address] });
  const b = await swaps.build({ owner: OWNER, tokenIn: TOKENS.USDC, tokenOut: TOKENS.WETH, amountIn: 40_000_000n, slipBps: 50 });
  assert.equal(b.fee, 500, "the 0.05% pool quotes best");
  assert.deepEqual(b.txs.map((t) => t.kind), ["approve", "swap"]);
  const approve = decodeFunctionData({ abi: ERC20, data: b.txs[0].tx.data });
  assert.deepEqual([approve.functionName, approve.args[0], approve.args[1]], ["approve", ROUTER, 40_000_000n], "exactly the amount, to the router");
  const swap = decodeFunctionData({ abi: ROUTER_ABI, data: b.txs[1].tx.data }).args[0];
  assert.equal(swap.recipient, OWNER);
  assert.equal(swap.amountOutMinimum, (40_000_000n * 555_000_000_000n * 9950n) / 10000n);
  assert.equal(b.txs[1].tx.to, ROUTER);
  const enough = createSwaps({ rpc: fakeBase({ allowance: 10n ** 30n }), presign: fakePresign(), signers: [signer.address] });
  assert.deepEqual((await enough.build({ owner: OWNER, tokenIn: TOKENS.USDC, tokenOut: TOKENS.WETH, amountIn: 40_000_000n, slipBps: 50 })).txs.map((t) => t.kind), ["swap"], "no approval when allowed already");
  const poor = createSwaps({ rpc: fakeBase({ balance: 1n }), presign: fakePresign(), signers: [signer.address] });
  assert.match((await poor.build({ owner: OWNER, tokenIn: TOKENS.USDC, tokenOut: TOKENS.WETH, amountIn: 40_000_000n, slipBps: 50 })).error, /less than/);
});

test("swap check: every tx needs presign-guard's verdict bound to exactly it; red and unbound are refused", async () => {
  const ok = createSwaps({ rpc: fakeBase(), presign: fakePresign(), signers: [signer.address] });
  const b = await ok.build({ owner: OWNER, tokenIn: TOKENS.USDC, tokenOut: TOKENS.WETH, amountIn: 40_000_000n, slipBps: 50 });
  const c = await ok.check(b.txs);
  assert.deepEqual(c.checked.map((t) => [t.kind, t.verdict]), [["approve", "green"], ["swap", "green"]]);
  const red = createSwaps({ rpc: fakeBase(), presign: fakePresign({ verdict: "red" }), signers: [signer.address] });
  assert.match((await red.check(b.txs)).error, /red/);
  const elsewhere = createSwaps({ rpc: fakeBase(), presign: fakePresign({ bindTo: { ...b.txs[1].tx, to: "0x6666666666666666666666666666666666666666" } }), signers: [signer.address] });
  assert.match((await elsewhere.check(b.txs)).error, /CHANGED/, "a verdict for another transaction");
  const stranger = createSwaps({ rpc: fakeBase(), presign: fakePresign(), signers: ["0x2222222222222222222222222222222222222222"] });
  assert.match((await stranger.check(b.txs)).error, /UNTRUSTED/, "not signed by presign-guard");
});

test("swap request: off by default, limits, then the owner's page sends it and a changed transaction is caught", async () => {
  const store = memoryStore().global;
  let settings = {};
  const told = [];
  const accounts = { swapSettings: async () => settings, payer: async () => OWNER, tellOwner: async (_id, m) => told.push(m) };
  const usage = { record() {} };
  const chain = {};
  const rpc = fakeBase({ chain });
  const swaps = createSwaps({ rpc, presign: fakePresign(), signers: [signer.address] });
  const s = createSwapRequests({ accounts, store, usage, csp: "default-src 'self'", swapHtml: "<html></html>", engine: swaps, rpc, statusWaitMs: 0 });
  const ctx = { account: "acc1", agent: { id: "ag1", name: "Agent" }, origin: "https://wallet.example" };

  assert.match((await s.request(ctx, { from_token: "USDC", to_token: "ETH", amount: "40" })).error, /hasn't turned on swaps/);
  settings = { on: true };
  assert.match((await s.request(ctx, { from_token: "USDC", to_token: "ETH", amount: "60" })).error, /above your user's limit of \$50/);
  const r = await s.request(ctx, { from_token: "USDC", to_token: "ETH", amount: "40", reason: "gas money" });
  assert.equal(r.status, "waiting");
  assert.equal(r.approve_url, `https://wallet.example/swap/${r.swap_id}`);
  assert.equal(r.txs.length, 2);
  assert.match(told.at(-1).text, /bound to exactly these transactions/);

  const app = express();
  app.use(s.router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/connector/swaps/${r.swap_id}`)).json();
    assert.equal(page.status, "waiting");
    // The wallet sends the approval exactly as checked.
    const approve = page.txs[0].tx, swap = page.txs[1].tx;
    const h1 = `0x${"a1".repeat(32)}`, h2 = `0x${"b2".repeat(32)}`;
    chain[h1] = { tx: { chainId: "0x2105", from: approve.from, to: approve.to, value: "0x0", input: approve.data }, receipt: { status: "0x1" } };
    const early = await fetch(`${base}/connector/swaps/${r.swap_id}/sent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "swap", hash: h2 }) });
    assert.equal(early.status, 409, "the approval comes first");
    const a1 = await (await fetch(`${base}/connector/swaps/${r.swap_id}/sent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "approve", hash: h1 }) })).json();
    assert.equal(a1.status, "approving");
    // Then a swap whose recipient was changed on the way: caught, the owner is told.
    const evil = decodeFunctionData({ abi: ROUTER_ABI, data: swap.data }).args[0];
    const { encodeFunctionData } = await import("viem");
    chain[h2] = { tx: { chainId: "0x2105", from: swap.from, to: swap.to, value: "0x0", input: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ ...evil, recipient: "0x7777777777777777777777777777777777777777" }] }) }, receipt: { status: "0x1" } };
    const changed = await (await fetch(`${base}/connector/swaps/${r.swap_id}/sent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "swap", hash: h2 }) })).json();
    assert.equal(changed.status, "changed");
    assert.match(told.at(-1).text, /not the one presign-guard checked/);

    // A clean run: approval already given, the swap sent as checked, confirmed, counted for the day.
    const r2 = await s.request(ctx, { from_token: "USDC", to_token: "ETH", amount: "40" });
    const p2 = await (await fetch(`${base}/connector/swaps/${r2.swap_id}`)).json();
    const sw = p2.txs.find((t) => t.kind === "swap").tx, ap = p2.txs.find((t) => t.kind === "approve")?.tx;
    const h3 = `0x${"c3".repeat(32)}`, h4 = `0x${"d4".repeat(32)}`;
    if (ap) {
      chain[h3] = { tx: { chainId: "0x2105", from: ap.from, to: ap.to, value: "0x0", input: ap.data }, receipt: { status: "0x1" } };
      await fetch(`${base}/connector/swaps/${r2.swap_id}/sent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "approve", hash: h3 }) });
    }
    chain[h4] = { tx: { chainId: "0x2105", from: sw.from, to: sw.to, value: "0x0", input: sw.data }, receipt: { status: "0x1" } };
    const done = await (await fetch(`${base}/connector/swaps/${r2.swap_id}/sent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "swap", hash: h4 }) })).json();
    assert.equal(done.status, "done");
    assert.match(told.at(-1).text, /Swapped 40 USDC/);
    // $40 done today: another $40 would pass the $100 day limit? No: 80 <= 100. A third would.
    await s.request(ctx, { from_token: "USDC", to_token: "ETH", amount: "40" });
    settings = { on: true, perDayUsd: 70 };
    assert.match((await s.request(ctx, { from_token: "USDC", to_token: "ETH", amount: "40" })).error, /limit of \$70 a day \(\$40\.00 used today\)/);
    const recent = await s.recent("acc1");
    assert.ok(recent.some((x) => x.status === "done" && x.tx === h4));
    const st = await s.status(ctx, r2.swap_id);
    assert.equal(st.status, "done");
    assert.equal((await s.status({ ...ctx, agent: { id: "other", name: "x" } }, r2.swap_id)).error, "No such swap request (they are kept an hour).");
  } finally { server.close(); }
});
