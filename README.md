# x402 examples

## Spending limits for AI agents, approved from your phone

Give your agents a wallet without giving them a blank cheque:

- **[presign-guard-wallet](guard-wallet)** (npm): a viem wallet that checks every signature with presign-guard first (drainers, sanctions, unlimited approvals), keeps to your **price per purchase and daily budget**, and asks you on **Telegram** for anything above them. `npm i presign-guard-wallet`
- **[fizzl](fizzl-py)** (PyPI): the same checks for **Python** agents, with ready-made **LangChain** tools. `pip install fizzl`
- **[fizzl-langchain](fizzl-langchain)** (npm): the same checks as **LangChain.js / LangGraph.js** tools, with a free quick check to try them without a wallet. `npm i fizzl-langchain`
- **[presign-guard-ai-sdk](ai-sdk-guard)** (npm): safety checks as **Vercel AI SDK** tools. Before signing, before buying a token and before paying an x402 endpoint, the agent checks first. `npm i presign-guard-ai-sdk`
- **[presign-guard-agentkit](agentkit-guard)** (npm): the same for **Coinbase AgentKit** agents. Wrap the wallet provider in one line, and every transfer, swap, approval, permit and x402 payment is checked and kept to your limits. `npm i presign-guard-agentkit`
- **[presign-guard-solana-agent-kit](solana-agent-kit-guard)** (npm): the same for **Solana Agent Kit** agents (SendAI). Wrap the wallet in one line, and every transfer, swap and token action from every plugin is checked (instructions decoded and simulated) and kept to your SOL and USDC limits. `npm i presign-guard-solana-agent-kit`
- **[presign-guard-wallet-mcp](wallet-mcp)** (npm, MCP server): a wallet with spending limits for **Claude, Cursor and any MCP client**. The agent can pay x402 APIs and send USDC within your budget, and asks you on Telegram above it. `npx -y presign-guard-wallet-mcp`
- **[presign-guard-payer-screen](payer-screen)** (npm): for **sellers**. Screens who pays your x402 API against the OFAC SDN sanctions list before the payment settles; a listed payer gets 451 and is never charged. EVM, Solana, Algorand, XRP Ledger, no dependencies. `npm i presign-guard-payer-screen`
- **[privy-sanctions-sync](privy-sanctions-sync)**: for **Privy** agent wallets. Keeps the condition sets behind Privy's x402 sanctions-screening policy in step with the OFAC SDN list: EVM addresses in both casings, Solana addresses plus their USDC and USDT token accounts. It adds before it removes and leaves a set alone when the list is stale.
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

## Research: do AI agents pay safely?

- **[agent-safety-bench](agent-safety-bench)**: an open benchmark of how an AI agent with a wallet handles x402 payments. It checks whether the agent pays honest sellers and refuses the traps: an overcharge, a sanctioned payee, a price over budget, the expensive one of two options, an instruction injected into an API's answer, and a seller that takes the money and asks again. Everything runs offline against simulated sellers with the official x402 client, and nothing is ever paid. It compares agents with and without x402 Doctor's preflight skill.

## Paid-API examples

Small, open examples of AI agents combining paid APIs with [x402](https://x402.org): each call is paid per request in USDC, with no accounts or API keys.

| Example | What it does | Services | Cost per run |
|---|---|---|---|
| [wallet-mcp](wallet-mcp) | **MCP server** `presign-guard-wallet-mcp`: wallet tools for any MCP client (pay x402 APIs, send USDC), every signature checked by presign-guard and kept to spending limits, Telegram or wallet-server approval above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked signature (or prepaid credits) |
| [fizzl-py](fizzl-py) | **PyPI package** `fizzl`: the four checks for Python agents (requests + x402), plus LangChain tools | [presign-guard](https://presign-guard.fizzl.eu), [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 to $0.02 per check (or prepaid credits) |
| [fizzl-langchain](fizzl-langchain) | **npm package** `fizzl-langchain`: the five checks as LangChain.js tools, for LangChain and LangGraph agents | [presign-guard](https://presign-guard.fizzl.eu), [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 to $0.02 per check (or prepaid credits) |
| [ai-sdk-guard](ai-sdk-guard) | **npm package** `presign-guard-ai-sdk`: four Vercel AI SDK tools (check before signing, token check, wallet approvals, endpoint preflight) | [presign-guard](https://presign-guard.fizzl.eu), [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 to $0.02 per check (or prepaid credits) |
| [agentkit-guard](agentkit-guard) | **npm package** `presign-guard-agentkit`: wraps a Coinbase AgentKit wallet provider so every spending action is checked by presign-guard and kept to spending limits, with Telegram or wallet-server approval above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked signature (or prepaid credits) |
| [solana-agent-kit-guard](solana-agent-kit-guard) | **npm package** `presign-guard-solana-agent-kit`: wraps a Solana Agent Kit wallet so every transaction is checked by presign-guard (decoded and simulated) and kept to SOL and USDC limits, with Telegram or wallet-server approval above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked transaction (or prepaid credits) |
| [guard-wallet](guard-wallet) | **npm package** `presign-guard-wallet`: a viem wallet that asks presign-guard before every signature, keeps to spending limits and asks you on Telegram above them | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 per checked signature (or prepaid credits) |
| [crowding-check](crowding-check) | Perp funding + CFTC leveraged-fund positioning + the Ichimoku cloud on 4h and 1d, combined into a short read ("crowded long + below the cloud = caution") | [Edge Agents](https://pay.edge-agents.ai), [Ichimoku Signal](https://ichimoku-signal.fizzl.eu) | $0.32 |
| [token-check](token-check) | Before buying, holding or accepting a token: a verdict (go / ask / stop) with reasons and market data, Solana and EVM tokens; pays on Solana or Base | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 |
| [payer-screen](payer-screen) | **npm package** `presign-guard-payer-screen`: for sellers. Express middleware that screens who pays your x402 API against the OFAC SDN list before the payment settles (EVM, Solana, Algorand, XRP Ledger); a listed payer gets 451 and is never charged | [presign-guard](https://presign-guard.fizzl.eu) open list (free) | free |
| [safe-fetch](safe-fetch) | **npm package** `x402-safe-fetch`: the safe-pay logic as a drop-in `fetch` for your own agent (preflight, go / caution / no_go, budget cap, trusted hosts, 10-minute verdict cache) | [x402 Doctor](https://x402-doctor.fizzl.eu) + the endpoint | $0.001 + the endpoint |
| [safe-pay](safe-pay) | Before paying an x402 endpoint it has never used, the agent pays $0.001 for a preflight and pays only on go, within a budget | [x402 Doctor](https://x402-doctor.fizzl.eu) + the endpoint | $0.001 + the endpoint |

Each example has a `--dry-run` that shows the prices without paying. Use a dedicated wallet with a little USDC, keep its key in your environment, and never commit it.

Check your own x402 endpoint for free with [x402 Doctor](https://x402-doctor.fizzl.eu).

These are examples of combining services, not trade advice.
