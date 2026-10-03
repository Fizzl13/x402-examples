// Offline demo: what an AgentKit agent sees when presign-guard-agentkit guards its wallet.
// No keys, no network, no money: the wallet provider and presign-guard are stand-ins here.
//
//   cd agentkit-guard && npm install && node example/demo.mjs
//
// For the real thing, see example/agent.mjs (a Base wallet, real checks at $0.01 each).
import { EvmWalletProvider } from "@coinbase/agentkit";
import { encodeFunctionData, erc20Abi, maxUint256, parseUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWalletProvider, walletGuardActionProvider } from "../index.js";

// AgentKit reports actions to Coinbase analytics; this demo stays offline.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith("https://cca-lite.coinbase.com/") ? new Response("{}") : realFetch(url, init));

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111"; // an API the agent buys from
const DRAINER = "0x2222222222222222222222222222222222222222"; // what presign-guard would flag

// Stand-in for CdpEvmWalletProvider / ViemWalletProvider: says what it would have signed.
class DemoProvider extends EvmWalletProvider {
  trackInitialization() {}
  getAddress() { return "0x9999999999999999999999999999999999999999"; }
  getNetwork() { return { protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }; }
  getName() { return "demo_wallet_provider"; }
  async getBalance() { return 0n; }
  async sign() { return "0x"; }
  async signMessage() { return "0x"; }
  async signTypedData() { return "0xsigned"; }
  async signTransaction() { return "0xsigned"; }
  async sendTransaction() { return "0x" + "ab".repeat(32); }
  async waitForTransactionReceipt() { return {}; }
  async readContract() { return 0n; }
  async nativeTransfer() { return "0x"; }
}

// Stand-in for presign-guard (normally https://presign-guard.fizzl.eu, $0.01 per check over x402).
// Like the real one, every verdict carries a signed receipt; here the signer is a throwaway key.
const demoSigner = privateKeyToAccount(generatePrivateKey());
const pay = async (_url, init) => {
  const input = JSON.parse(init.body), route = "POST /v1/check";
  const red = init.body.toLowerCase().includes(DRAINER.slice(2));
  const body = red
    ? { version: "2", verdict: "red", reasons: [{ code: "known_drainer", severity: "high", message: "The spender is a known wallet drainer." }] }
    : { version: "2", verdict: "green", reasons: [] };
  const receipt = { request_id: "demo", route, input_sha256: inputHash(route, input), signed_at: new Date().toISOString(), signer: demoSigner.address, algorithm: "eip191-canonical-json-v1" };
  return Response.json({ ...body, receipt: { ...receipt, signature: await demoSigner.signMessage({ message: canonicalJson({ ...body, receipt }) }) } });
};

const walletProvider = guardWalletProvider(new DemoProvider(), {
  pay,
  signers: [demoSigner.address], // only in this demo: trust the stand-in's key. Real use trusts presign-guard's published signer.
  limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } },
  onOverLimit: async ({ summary }) => { console.log(`   (you'd get a Telegram message: "${summary}". Here: denied.)`); return false; },
});
const tx = (to, data) => ({ to, data });
const usdc = (fn, args) => tx(USDC, encodeFunctionData({ abi: erc20Abi, functionName: fn, args }));

async function step(title, run) {
  console.log(`\n▶ ${title}`);
  try { console.log(`   ✓ signed: ${await run()}`); }
  catch (err) { console.log(`   ✕ not signed (${err.code}): ${err.message}`); }
}

await step("Pay 2 USDC to an API (within the 5 USDC limit)", () => walletProvider.sendTransaction(usdc("transfer", [SHOP, parseUnits("2", 6)])));
await step("Approve unlimited USDC to a known drainer", () => walletProvider.sendTransaction(usdc("approve", [DRAINER, maxUint256])));
await step("Pay 8 USDC (over the 5 USDC limit: asks you)", () => walletProvider.sendTransaction(usdc("transfer", [SHOP, parseUnits("8", 6)])));

const [limits, pause] = walletGuardActionProvider().getActions(walletProvider);
console.log("\n▶ The agent checks its own budget (get_spending_limits):");
console.log("  ", await limits.invoke({}));
console.log("\n▶ The agent stops itself (pause_spending):");
console.log("  ", await pause.invoke({ reason: "unexpected approval request" }));
await step("Pay 1 USDC while paused", () => walletProvider.sendTransaction(usdc("transfer", [SHOP, parseUnits("1", 6)])));
console.log("\nThese messages are what AgentKit hands back to the agent, which tells the user.\n");
