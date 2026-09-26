// One-off live test for coinbase/agentkit#1522: the x402Doctor action provider, called the
// way an agent calls it (AgentKit.getActions), with a real wallet on Base mainnet.
const path = require("path");
const ak = require(path.join(process.env.AGENTKIT_DIR, "typescript/agentkit/dist/index.js"));
const viem = require(path.join(process.env.AGENTKIT_DIR, "typescript/agentkit/node_modules/viem"));
const { privateKeyToAccount } = require(path.join(process.env.AGENTKIT_DIR, "typescript/agentkit/node_modules/viem/accounts"));
const { base } = require(path.join(process.env.AGENTKIT_DIR, "typescript/agentkit/node_modules/viem/chains"));

// AgentKit fires analytics events without awaiting them; a failed event (HTTP 400 from its
// analytics endpoint on this runner) would otherwise end the process as an unhandled rejection.
process.on("unhandledRejection", (e) => console.warn("(AgentKit analytics event failed, ignored:", e && e.message, ")"));

(async () => {
  const key = String(process.env.EVM_PRIVATE_KEY || "").trim();
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const client = viem.createWalletClient({ account, chain: base, transport: viem.http() });
  const walletProvider = new ak.ViemWalletProvider(client);
  const agentkit = await ak.AgentKit.from({ walletProvider, actionProviders: [ak.x402ActionProvider(), ak.x402DoctorActionProvider()] });
  const actions = agentkit.getActions();
  const preflight = actions.find((a) => a.name.endsWith("preflight_x402_endpoint"));
  console.log("Network:", JSON.stringify(walletProvider.getNetwork()));
  console.log("Action:", preflight.name);
  for (const args of [
    { url: "https://ichimoku-signal.onrender.com/signal/BTC-USDT", maxUsd: 0.05 },
    { url: "https://ichimoku-signal.onrender.com/signal/BTC-USDT", maxUsd: 0.01 },
  ]) {
    console.log("\nInput:", JSON.stringify(args));
    console.log(await preflight.invoke(args));
  }
})().catch((e) => { console.error(e); process.exit(1); });
