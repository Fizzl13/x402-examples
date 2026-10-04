# presign-guard-wallet-mcp

A wallet with spending limits for AI agents, as an [MCP](https://modelcontextprotocol.io) server. Add it to Claude Desktop, Claude Code, Cursor or any other MCP client, and your agent can:
- pay for x402 APIs, and MPP APIs that take USDC (method `evm`);
- send USDC.

It can only do that within the budget you set:

- **You set the limits.** For example: up to 5 USDC per payment and 20 USDC a day, and the agent is free to spend within them.
- **Above a limit, you decide.** You get a Telegram message with Approve / Deny, or the request shows up on your [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) dashboard. No answer means no payment.
- **Every signature is checked first by [presign-guard](https://presign-guard.fizzl.eu).** It checks for known drainers, sanctioned addresses and look-alike tokens. A red verdict is never signed.
- **When in doubt, nothing is signed.** If the check, Telegram or the server can't be reached, the wallet stops.

The key stays on your machine; the server only decides whether a signature is allowed. Each check costs $0.01, paid in USDC on Base from the same wallet, or from prepaid credits.

See the dashboard (demo data): **https://wallet.fizzl.eu/demo**

## Tools

| Tool | What it does |
|---|---|
| `wallet_status` | Address, balances, limits, what is left today, how approvals work |
| `find_services` | Search the public x402 catalog ([Coinbase's x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar)) for paid APIs this wallet can pay (USDC on its chain, within the price cap), best match first |
| `pay_x402` | Call an API that answers 402 Payment Required, pay it in USDC, return the response (with a price cap per call). Pays x402, and MPP (Machine Payments Protocol) charges with the `evm` method in USDC on the wallet's chain: the same EIP-3009 signature, checked by presign-guard and counted toward your limits. When an API offers both, x402 is used |
| `send_usdc` | Send USDC to an address |
| `send_native` | Send ETH / POL / BNB to an address |
| `pause_spending` | The agent stops itself when something looks wrong; nothing is signed until you restart or resume |

## Set up

1. **Make a separate wallet for the agent.** Put only what it may spend in it: a few dollars of USDC on Base, plus a little ETH for gas if it will send transfers. Never use your main wallet.
2. **Optional: phone approvals.**
   - Create a bot with [@BotFather](https://t.me/BotFather), send it `/start`.
   - Get your chat id from [@userinfobot](https://t.me/userinfobot).
3. **Add it to your MCP client.** For Claude Desktop, put this in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wallet": {
      "command": "npx",
      "args": ["-y", "presign-guard-wallet-mcp"],
      "env": {
        "AGENT_KEY": "0x…the agent wallet's private key…",
        "LIMIT_USDC_PER_TX": "5",
        "LIMIT_USDC_PER_DAY": "20",
        "TELEGRAM_BOT_TOKEN": "123456:ABC…",
        "TELEGRAM_CHAT_ID": "123456789"
      }
    }
  }
}
```

For Claude Code:

```sh
claude mcp add wallet -e AGENT_KEY=0x… -e LIMIT_USDC_PER_TX=5 -e LIMIT_USDC_PER_DAY=20 -- npx -y presign-guard-wallet-mcp
```

Then ask your agent, for example: *"Check my wallet, then get the BTC signal from https://ichimoku-signal.fizzl.eu/signal/BTC-USDT"*.

Or let it find a service itself: *"Find a paid API for a bitcoin trend signal under $0.10 and buy one"*. The agent searches the x402 catalog with `find_services`, picks one and pays it with `pay_x402`, within your limits.

### One budget for all your agents

Run the [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) and make an agent key on its dashboard. It gives you:
- one price rule and one daily budget for all your agents;
- approvals on the dashboard and on Telegram;
- an activity log.

Then use these variables instead of `LIMIT_*` and `TELEGRAM_*`:

```json
"env": {
  "AGENT_KEY": "0x…",
  "WALLET_SERVER_URL": "https://your-wallet-server.example",
  "WALLET_SERVER_KEY": "awk_…"
}
```

## Configuration

| Variable | |
|---|---|
| `AGENT_KEY` | **required**: private key of the agent's own wallet |
| `LIMIT_USDC_PER_TX`, `LIMIT_USDC_PER_DAY` | USDC limits (payments and transfers together). Limits or a wallet server are required |
| `LIMIT_NATIVE_PER_TX`, `LIMIT_NATIVE_PER_DAY` | limits for the native coin; without them, sending it needs approval |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | approvals on Telegram; without them, anything over a limit is refused |
| `WALLET_SERVER_URL`, `WALLET_SERVER_KEY` | a wallet server instead of the above |
| `CHAIN` | `base` (default), `ethereum`, `optimism`, `arbitrum`, `polygon` or `bsc` |
| `MAX_PAYMENT_USD` | most one `pay_x402` call may cost (default `1`); a cap on top of the limits |
| `X402_DISCOVERY_URL` | the x402 catalog `find_services` searches (default Coinbase's Bazaar discovery API) |
| `PRESIGN_CREDIT_KEY` | pay the $0.01 checks from [prepaid credits](https://presign-guard.fizzl.eu) (`pgc_…`) |
| `RPC_URL` | your own RPC for the chain |
| `AGENT_LABEL` | the name shown in Telegram approval messages (default `mcp-agent`) |

One Telegram bot serves one running server at a time, and the bot must not have a webhook. To run several agents on one bot, use the wallet server.

## Receipts

Every payment carries what it was for: the URL for `pay_x402`, and the agent's `reason` if it gives one. With a wallet server, that shows on the receipt for each payment, together with:
- the amount and recipient;
- presign-guard's signed verdict;
- the approval;
- the x402 settlement;
- what the agent got back: the API's answer (up to 16,000 characters), shown in plain form on the receipt.

Telegram approval requests say what the payment is for too. See a receipt in the [demo](https://wallet.fizzl.eu/demo): click a purchase under "Purchases".

## When something is refused

The tool returns an error the agent can read and pass on to you. Examples:
- `Not done (over_limit): 8 USDC is over the limit of 5 per transaction (denied by the owner)`;
- `Not done (red): not signed: red (known_drainer)`.

## Also available

- [presign-guard-wallet](https://github.com/Fizzl13/x402-examples/tree/main/guard-wallet): the same guard for your own viem code.
- [presign-guard-agentkit](https://github.com/Fizzl13/x402-examples/tree/main/agentkit-guard): for Coinbase AgentKit agents.

## License

MIT
