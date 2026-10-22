// A tiny in-process chain for the contract tests: @ethereumjs/evm with a clock we control.
import { createEVM } from "@ethereumjs/evm";
import { createAddressFromString, createZeroAddress, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { encodeFunctionData, decodeFunctionResult, encodeDeployData, decodeErrorResult, decodeEventLog } from "viem";
import { readFileSync } from "node:fs";

export const artifact = (name) => JSON.parse(readFileSync(new URL(`../build/${name}.json`, import.meta.url), "utf8"));
export const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;

export async function chain() {
  const evm = await createEVM();
  let time = 1_800_000_000n;
  const block = () => ({ header: { number: 1n, timestamp: time, coinbase: createZeroAddress(), difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, getBlobGasPrice: () => 0n } });
  const run = (from, to, data) => evm.runCall({ caller: createAddressFromString(from), ...(to ? { to: createAddressFromString(to) } : {}), data: hexToBytes(data), gasLimit: 10_000_000n, block: block() });

  async function deploy(name, from, args = []) {
    const { abi, bytecode } = artifact(name);
    const r = await run(from, null, encodeDeployData({ abi, bytecode, args }));
    if (r.execResult.exceptionError) throw new Error(`deploy ${name} failed: ${r.execResult.exceptionError.error}`);
    const address = r.createdAddress.toString();
    const decodeLogs = (logs) => logs.filter(([a]) => bytesToHex(a).toLowerCase() === address.toLowerCase()).map(([, topics, data]) => decodeEventLog({ abi, topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(data) }));
    return {
      address,
      // A transaction: resolves to { events } or throws an error carrying the contract's revert name.
      async send(from, functionName, args = []) {
        const r = await run(from, address, encodeFunctionData({ abi, functionName, args }));
        if (r.execResult.exceptionError) {
          const data = bytesToHex(r.execResult.returnValue);
          let reason = r.execResult.exceptionError.error;
          try { const e = decodeErrorResult({ abi, data }); reason = e.errorName === "Error" ? e.args[0] : e.errorName; } catch { if (data.startsWith("0x08c379a0")) reason = Buffer.from(data.slice(138), "hex").toString().replace(/\0+$/, ""); }
          throw Object.assign(new Error(`${functionName} reverted: ${reason}`), { reason });
        }
        return { events: decodeLogs(r.execResult.logs ?? []), gas: r.execResult.executionGasUsed };
      },
      async read(functionName, args = []) {
        const r = await run(addr(1), address, encodeFunctionData({ abi, functionName, args }));
        if (r.execResult.exceptionError) throw new Error(`${functionName} reverted`);
        return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) });
      },
    };
  }
  // A JSON-RPC endpoint over this chain, as the wallet server sees Base: eth_call (no state change),
  // transactions from `send(from, to, data)`, receipts, balances.
  const receipts = new Map();
  let n = 0;
  async function send(from, to, data) {
    const r = await run(from, to, data);
    const hash = `0x${(++n).toString(16).padStart(64, "0")}`;
    receipts.set(hash, { status: r.execResult.exceptionError ? "0x0" : "0x1", blockNumber: "0x1", logs: [], contractAddress: r.createdAddress ? r.createdAddress.toString() : null });
    return hash;
  }
  async function rpc(method, params) {
    if (method === "eth_call") {
      const { from, to, data } = params[0];
      await evm.stateManager.checkpoint();
      try {
        const r = await run(from ?? addr(1), to, data);
        if (r.execResult.exceptionError) throw Object.assign(new Error("execution reverted"), { data: bytesToHex(r.execResult.returnValue) });
        return bytesToHex(r.execResult.returnValue);
      } finally { await evm.stateManager.revert(); }
    }
    if (method === "eth_getTransactionReceipt") return receipts.get(params[0]) ?? null;
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_getBlockByNumber") return { timestamp: `0x${time.toString(16)}` };
    throw new Error(`rpc: ${method} not supported`);
  }
  // A fetch for the wallet server's billing.fetch.
  const fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    try { return Response.json({ jsonrpc: "2.0", id, result: await rpc(method, params) }); }
    catch (err) { return Response.json({ jsonrpc: "2.0", id, error: { code: 3, message: err.message, data: err.data } }); }
  };

  // Put a deployed contract's code at another address (e.g. a mock token at the real USDC address).
  async function copyCode(from, to) {
    await evm.stateManager.putCode(createAddressFromString(to), await evm.stateManager.getCode(createAddressFromString(from)));
  }

  return {
    deploy,
    send,
    copyCode,
    rpc,
    fetch,
    get now() { return time; },
    wait: (seconds) => { time += BigInt(seconds); },
  };
}
