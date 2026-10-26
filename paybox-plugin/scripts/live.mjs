// Live check of every tool against the real Fizzl services, without paying: calls the built dist/plugin.mjs over
// stdio, then for each x402 proposal sends the same request unpaid and checks what PayBox will check, that the
// endpoint answers 402 with a USDC option on the proposal's chain asking at most the proposal's maxAmount.
// node scripts/live.mjs   (after pnpm build; needs network access)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2026-07-28";
const KEY = "io.paybox/transactionProposal";
const CAIP = { "eip155:8453": "eip155:8453", "solana:mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };
const CASES = [
  ["x402_trust_record", { url: "https://presign-guard.fizzl.eu/v1/check" }],
  ["pick_api", { need: "bitcoin price in usd" }],
  ["x402_preflight", { url: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", maxUsd: "0.05" }],
  ["x402_preflight", { url: "https://ichimoku-signal.fizzl.eu/signal/BTC-USDT", chain: "solana" }],
  ["check_transaction", { chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: "0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba30000000000000000000000000000000000000000000000000000000000000001" }],
  ["check_solana_transaction", { transaction: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB" }],
  ["check_token", { tokenChain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
  ["screen_address", { address: "0x6B0F4651eD42893ab58139938175E4a69f175F25" }],
  ["buy_answer", { need: "bitcoin price in usd", chain: "solana" }],
];

function call(tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${tool}: no answer in 10 s`)); }, 10_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== 1) return;
      clearTimeout(timer); child.kill();
      msg.error ? reject(new Error(`${tool}: ${msg.error.message}`)) : resolve(msg.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientInfo": { name: "fizzl-live", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
    } } })}\n`);
  });
}

async function checkProposal(p) {
  const { url, method, body } = p.request;
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (res.status !== 402) return `answered ${res.status}, not 402`;
  const header = res.headers.get("payment-required");
  if (!header) return "402 without a PAYMENT-REQUIRED header";
  const accepts = JSON.parse(Buffer.from(header, "base64").toString()).accepts || [];
  const option = accepts.find((a) => a.network === CAIP[p.chain] && String(a.asset).toLowerCase() === p.payment.asset.toLowerCase());
  if (!option) return `no USDC option on ${p.chain}`;
  if (BigInt(option.amount) > BigInt(p.payment.maxAmount)) return `asks ${option.amount}, above maxAmount ${p.payment.maxAmount}`;
  return null;
}

let failed = 0;
for (const [tool, args] of CASES) {
  try {
    const result = await call(tool, args);
    const proposal = result.structuredContent?.[KEY];
    const problem = result.isError ? `error: ${result.content?.[0]?.text}` : proposal ? await checkProposal(proposal) : null;
    if (problem) failed++;
    console.log(`${problem ? "FAIL" : "ok  "} ${tool} ${proposal ? `${proposal.chain} ${proposal.request.method} ${proposal.request.url.slice(0, 90)} max ${proposal.payment.maxAmount}` : result.content[0].text.slice(0, 140)}${problem ? ` -> ${problem}` : ""}`);
  } catch (err) { failed++; console.log(`FAIL ${tool} -> ${err.message}`); }
}
process.exit(failed ? 1 : 0);
