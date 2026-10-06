# x402 examples

## Spending limits for AI agents, approved from your phone

Give your agents a wallet without giving them a blank cheque:

- **[presign-guard-wallet](guard-wallet)** (npm): a viem wallet that checks every signature with presign-guard first (drainers, sanctions, unlimited approvals), keeps to your **price per purchase and daily budget**, and asks you on **Telegram** for anything above them. `npm i presign-guard-wallet`
- **[presign-guard-ai-sdk](ai-sdk-guard)** (npm): safety checks as **Vercel AI SDK** tools. Before signing, before buying a token and before paying an x402 endpoint, the agent checks first. `npm i presign-guard-ai-sdk`
- **[presign-guard-agentkit](agentkit-guard)** (npm): the same for **Coinbase AgentKit** agents. Wrap the wallet provider in one line, and every transfer, swap, approval, permit and x402 payment is checked and kept to your limits. `npm i presign-guard-agentkit`
- **[presign-guard-wallet-mcp](wallet-mcp)** (npm, MCP server): a wallet with spending limits for **Claude, Cursor and any MCP client**. The agent can pay x402 APIs and send USDC within your budget, and asks you on Telegram above it. `npx -y presign-guard-wallet-mcp`
- **[wallet-server](wallet-server)**: one budget and one set of rules for **all** your agents, a live dashboard, approvals on the dashboard, on your phone (installable app) or Telegram, pause one agent or all, an activity log. It never holds keys or funds: agents still sign and pay themselves.

**[See the dashboard live (demo, example data) →](https://wallet.fizzl.eu/demo)**

```js
import { guardWallet } from "presign-guard-wallet";

const wallet = guardWallet(walletClient, {
  pay, // a fetch that pays x402, or creditKey for prepaid presign-guard checks
  server: { url: process.env.WALLET_SERVER_URL, key: process.env.WALLET_SERVER_KEY },
});
// Under your price: signs. Above it: you get a request on the dashboard and on Telegram.
// Red verdict: never signed. Server unreachable: stops instead of signing.
```

Try it from your phone: Actions → **telegram-demo** → Run workflow (a pretend agent, a stub wallet, no money moves).

## Paid-API examples

Small, open examples of AI agents combining paid APIs with [x402](https://x402.org): each call is paid per request in USDC, with no accounts or API keys.

| Example | What it does | Services | Cost per run |
|---|---|---|---|
| [wallet-mcp](wallet-mcp) | **MCP server** `presign-guard-wallet-mcp`: wallet tools for any MCP client (pay x402 APIs, send USDC), every signature checked by presign-guard and kept to spending limits, Telegram or wallet-server approval above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked signature (or prepaid credits) |
| [ai-sdk-guard](ai-sdk-guard) | **npm package** `presign-guard-ai-sdk`: four Vercel AI SDK tools (check before signing, token check, wallet approvals, endpoint preflight) | [presign-guard](https://presign-guard.fizzl.eu), [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 to $0.02 per check (or prepaid credits) |
| [agentkit-guard](agentkit-guard) | **npm package** `presign-guard-agentkit`: wraps a Coinbase AgentKit wallet provider so every spending action is checked by presign-guard and kept to spending limits, with Telegram or wallet-server approval above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked signature (or prepaid credits) |
| [guard-wallet](guard-wallet) | **npm package** `presign-guard-wallet`: a viem wallet that asks presign-guard before every signature, keeps to spending limits and asks you on Telegram above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked signature (or prepaid credits) |
| [crowding-check](crowding-check) | Perp funding + CFTC leveraged-fund positioning + the Ichimoku cloud on 4h and 1d, combined into a short read ("crowded long + below the cloud = caution") | [Edge Agents](https://pay.edge-agents.ai), [Ichimoku Signal](https://ichimoku-signal.fizzl.eu) | $0.32 |
| [token-check](token-check) | Before buying, holding or accepting a token: a verdict (go / ask / stop) with reasons and market data, Solana and EVM tokens; pays on Solana or Base | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 |
| [safe-fetch](safe-fetch) | **npm package** `x402-safe-fetch`: the safe-pay logic as a drop-in `fetch` for your own agent (preflight, go / caution / no_go, budget cap, trusted hosts, 10-minute verdict cache) | [x402 Doctor](https://x402-doctor.fizzl.eu) + the endpoint | $0.001 + the endpoint |
| [safe-pay](safe-pay) | Before paying an x402 endpoint it has never used, the agent pays $0.001 for a preflight and pays only on go, within a budget | [x402 Doctor](https://x402-doctor.fizzl.eu) + the endpoint | $0.001 + the endpoint |

Each example has a `--dry-run` that shows the prices without paying. Use a dedicated wallet with a little USDC, keep its key in your environment, and never commit it.

Check your own x402 endpoint for free with [x402 Doctor](https://x402-doctor.fizzl.eu).

These are examples of combining services, not trade advice.
