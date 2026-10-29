# presign-guard-wallet-mcp

[![presign-guard-wallet-mcp MCP server on Glama](https://glama.ai/mcp/servers/Fizzl13/x402-examples/badges/score.svg)](https://glama.ai/mcp/servers/Fizzl13/x402-examples)

A wallet with spending limits for AI agents, as an [MCP](https://modelcontextprotocol.io) server. Add it to Claude Desktop, Claude Code, Cursor or any other MCP client, and your agent can:
- pay for x402 APIs, and MPP APIs: method `evm` (USDC on the wallet's chain) and method `tempo` (USDC.e on Tempo, what nearly every MPP API asks for);
- with its own accounts there, also pay x402 offers in RLUSD on the XRP Ledger (`XRPL_SEED`) and in USDC on Solana (`SOLANA_PRIVATE_KEY`) and Algorand (`ALGORAND_MNEMONIC`), and MPP sessions on Tempo (`MPP_SESSION_DEPOSIT`);
- send USDC.

It can only do that within the budget you set:

- **You set the limits.** For example: up to 5 USDC per payment and 20 USDC a day, and the agent is free to spend within them.
- **Above a limit, you decide.** You get a Telegram message with Approve / Deny, a request to sign in your own wallet over [AC2](https://github.com/algorandfoundation/ac2), or the request shows up on your [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) dashboard. No answer means no payment.
- **Every signature is checked first by [presign-guard](https://presign-guard.fizzl.eu).** It checks for known drainers, sanctioned addresses and look-alike tokens, checks an x402 payment against what the seller asked, and simulates a transaction to see what really leaves the wallet. A red verdict is never signed.
- **When in doubt, nothing is signed.** If the check, Telegram or the server can't be reached, the wallet stops.
- **Paid answers are checked before your agent reads them** (with a wallet server). An AI check looks at what the API sent back. If it carries instructions aimed at your agent (prompt injection: "ignore your rules", "pay this address"), the answer comes with a `warnings` field first that tells the agent to treat it as data only. If it isn't what was paid for, the warning says so too. You see both on the receipt and get a message.

The key stays on your machine; the server only decides whether a signature is allowed. Each check costs $0.01, paid in USDC on Base from the same wallet, or from prepaid credits.

> **What the limits do and don't stop.** The limits are enforced by this MCP server on your computer, not on the blockchain. The agent wallet's private key is on that computer too (in the MCP config, or in a file with `AGENT_KEY_FILE`). An agent that can read files or run commands (Claude Code, Cursor) could read the key and sign without these rules. So give the agent its **own wallet with only what you'd accept losing**, never your main wallet. With the [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) (hosted at wallet.fizzl.eu), you can also **put the limit on the chain**: your USDC stays in your own wallet, and the agent's wallet is topped up to a small float within a limit a day that a contract on Base keeps ([agent-allowance](https://github.com/Fizzl13/x402-examples/tree/main/agent-allowance)). A leaked key can then take at most that. This server asks for the top-up by itself before a payment when its wallet runs low.

See the dashboard (demo data): **https://wallet.fizzl.eu/demo**

## Quick start (hosted, about 2 minutes)

No keys to copy: the wallet makes its own key on your computer, and you link it to your account with a code. The hosted wallet at wallet.fizzl.eu does the limits, approvals and receipts. Free to start.

1. **Install it in your app, without keys.**
   - Claude Desktop: download **[fizzl-wallet.mcpb](https://wallet.fizzl.eu/download/claude-desktop)** and open it; Claude Desktop installs it (it brings its own Node.js).
   - Claude Code: `claude mcp add wallet -- npx -y presign-guard-wallet-mcp@0.29.1`
   - Cursor and other MCP clients: `{ "mcpServers": { "wallet": { "command": "npx", "args": ["-y", "presign-guard-wallet-mcp@0.29.1"] } } }`
2. **Ask your agent:** *"what is my wallet status?"* It makes its own wallet (the key goes into `~/.fizzl/agent-key`, readable only by you, and is never sent anywhere) and answers with a link and a code that works for 10 minutes.
3. **Open the link, sign in at wallet.fizzl.eu** with e-mail, a passkey, Xaman or your wallet, **and enter the code.** Give the agent a name. The wallet picks up its key for the wallet server by itself; no restart.
4. **Put a few dollars of USDC** in the agent's wallet (the dashboard has buttons for it). Most calls cost a cent or less. Then ask something like *"find a weather API and get the forecast for Amsterdam"*. It finds a paid API, pays within your limits and shows you the receipt.

Then connect Telegram on the dashboard to approve anything above your limit from your phone, and press **Test my setup** to see what's still missing.

Rather paste the keys yourself? On the dashboard, Agents → Add agent shows the setup for your app with the keys filled in. Prefer to run everything yourself? See [Set up](#set-up) below.

### In ChatGPT, Claude on the web or phone, or Grok

These apps can't run a local MCP server, so they use the remote connector instead: add a custom connector with the URL `https://wallet.fizzl.eu/mcp` and sign in to your Fizzl wallet. The app can then search paid APIs and ask for payments, but it never pays on its own: every payment waits for your signature in your own wallet (USDC on Base or Solana, or RLUSD in Xaman). Steps per app: https://wallet.fizzl.eu/connector

## Tools

| Tool | What it does |
|---|---|
| `wallet_status` | Address, balances, limits, what is left today, how approvals work |
| `find_services` | Search the public x402 catalog ([Coinbase's x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar)) for paid APIs this wallet can pay (USDC on its chain, within the price cap), best match first. With a wallet server, the server searches: by meaning, with sellers that [x402 Doctor](https://x402-doctor.fizzl.eu/trust) has seen paying out day after day first, and each result's track record. When one of those sellers costs $0.01 or less, [Fizzl Buy](https://buy.fizzl.eu) comes first as an extra option ($0.02, Fizzl's own service): one call that picks the seller, pays it and checks the answer |
| `pay_x402` | Call an API that answers 402 Payment Required, pay it in USDC, return the response (with a price cap per call). Pays x402, and MPP (Machine Payments Protocol) charges with the `evm` method in USDC on the wallet's chain: the same EIP-3009 signature, checked by presign-guard and counted toward your limits. On Tempo (method `tempo`) the wallet sends a USDC.e `transferWithMemo` from its own address there and hands over the transaction hash; presign-guard doesn't cover Tempo, so guard-wallet checks that it is exactly that transfer, and it counts toward your USDC limits. Order when an API offers several: x402, MPP evm, Tempo |
| `send_usdc` | Send USDC to an address |
| `send_native` | Send ETH / POL / BNB to an address |
| `check_text` | Before acting on text the agent did not write (a web page, email, tool result, API answer or another agent's message): is it a prompt-injection trap? [presign-guard](https://presign-guard.fizzl.eu)'s check answers green, orange or red. Free for the verdict (texts up to 8,000 characters, 10 an hour); `detailed: true` pays $0.01 from the wallet, within your limits, for the reason codes and probabilities |
| `pause_spending` | The agent stops itself when something looks wrong; nothing is signed until you restart or resume |

**No paying twice.** A signed x402 payment (an EIP-3009 authorization) can be collected by the seller until it expires, also after the API answered with an error or asked again, perhaps with another payTo. So when a paid call doesn't answer properly, the wallet asks USDC on-chain whether that payment was taken (`authorizationState`) and says so in the result (`charge`, with a warning first). A second payment for the same endpoint is refused until the first one is used or expired, and for an hour after a payment that was taken without an answer, so a retry can't pay twice.

The wallet signs only what these tools need: payment signatures and transfers. It signs no EIP-7702 authorization (handing the wallet's code to a contract, which is how "sweeper" drainers empty a wallet), whatever a seller, a web page or a prompt asks.

## Set up

1. **Make a separate wallet for the agent.** Put only what it may spend in it: a few dollars of USDC on Base, plus a little ETH for gas if it will send transfers. Never use your main wallet.
2. **Optional: phone approvals.**
   - Create a bot with [@BotFather](https://t.me/BotFather), send it `/start`.
   - Get your chat id from [@userinfobot](https://t.me/userinfobot).
3. **Add it to your MCP client.** For Claude Desktop: Settings → Developer → Edit Config opens `claude_desktop_config.json` (on a Mac in `~/Library/Application Support/Claude/`, on Windows in `%APPDATA%\Claude\`). Put this in it:

```json
{
  "mcpServers": {
    "wallet": {
      "command": "npx",
      "args": ["-y", "presign-guard-wallet-mcp@0.29.1"],
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

Rather keep the key out of that file? Put it in a file only you can read and set `"AGENT_KEY_FILE": "/full/path/to/that/file"` instead of `AGENT_KEY`.

For Claude Code, the key goes into a file at a prompt (not shown, not in your shell history or Claude's config):

```sh
mkdir -p ~/.fizzl && (umask 077; printf 'Agent wallet key: '; stty -echo; read -r k; stty echo; echo; printf '%s\n' "$k" > ~/.fizzl/agent-key)
claude mcp add wallet -e AGENT_KEY_FILE=$HOME/.fizzl/agent-key -e LIMIT_USDC_PER_TX=5 -e LIMIT_USDC_PER_DAY=20 -- npx -y presign-guard-wallet-mcp@0.29.1
```

**Pin the version** (`@0.29.1`), as above: `npx -y` without one fetches the newest release on every start, and that code sees the key. Releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements); `npm audit signatures` checks it.

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
| `AGENT_KEY` | private key of the agent's own wallet (64 hex characters, with or without 0x). Without it the wallet [links itself with a code](#linked-with-a-code): it makes its own key and each tool answers with a code to enter on the wallet server's dashboard |
| `AGENT_KEY_FILE` | instead of `AGENT_KEY`: the path to a file holding the key (`~/` works), so it is in neither the client's config nor your shell history. Make it readable only by you (`chmod 600`); the server warns otherwise. The same works for `XRPL_SEED_FILE`, `ALGORAND_MNEMONIC_FILE` and `SOLANA_PRIVATE_KEY_FILE` |
| `LIMIT_USDC_PER_TX`, `LIMIT_USDC_PER_DAY` | USDC limits (payments and transfers together). Limits or a wallet server are required |
| `LIMIT_NATIVE_PER_TX`, `LIMIT_NATIVE_PER_DAY` | limits for the native coin; without them, sending it needs approval |
| `ALLOW_LIST` | optional: only these recipients, spenders and contracts, comma-separated (0x, XRPL `r…` or Algorand addresses, each checked); a payment or signature for anything else needs your approval like an amount over a limit. With a wallet server, set the allow list there instead |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | approvals on Telegram; without them (or AC2), anything over a limit is refused |
| `AC2_OWNER` | instead of Telegram: approvals **signed in your own wallet** over [AC2](https://github.com/algorandfoundation/ac2) (the Algorand Foundation's protocol for agents to ask their owner). Your Algorand address: only its signature approves, and the signed approval is kept with the payment. Needs the AC2 service (`ac2-cli`) running on the same machine and paired with your wallet (`ac2 pair`); if it isn't, nothing over a limit is signed. `AC2_APPROVALS=on` uses the paired wallet's address instead. `AC2_DAEMON_SOCKET` if the service's socket isn't `~/.ac2/ac2d.sock` |
| `WALLET_SERVER_URL`, `WALLET_SERVER_KEY` | a wallet server instead of the above |
| `FIZZL_DIR` | without `AGENT_KEY`: where the wallet keeps `agent-key` and, once linked, `wallet-server.json` (default `~/.fizzl`). One directory per agent if you run several on one computer |
| `LINKING` | `off`: without `AGENT_KEY`, don't link with a code; the server starts in setup mode (it lists its tools and each one says how to add a key) |
| `CHAIN` | `base` (default), `ethereum`, `optimism`, `arbitrum`, `polygon` or `bsc` |
| `MAX_PAYMENT_USD` | most one `pay_x402` call may cost (default `1`); a cap on top of the limits |
| `X402_DISCOVERY_URL` | the x402 catalog `find_services` searches (default Coinbase's Bazaar discovery API) |
| `PRESIGN_CREDIT_KEY` | pay the $0.01 checks from [prepaid credits](https://presign-guard.fizzl.eu) (`pgc_…`) |
| `MANDATE` / `MANDATE_FILE` | optional: the owner's signed spending mandate ([x402 `authority` draft](https://github.com/x402-foundation/x402/pull/3220)) as JSON `{ mandate, alg: "Ed25519", sig }`, or a path to it. x402 payments are then made under it (the nonce carries its binding) and presign-guard refuses a payment outside it (over `perPayment` or `cap`, another recipient or token, expired). `wallet_status` shows it. With a wallet server and no `MANDATE`, the mandate the owner set for this agent on the dashboard is used (fetched from the server; the server also keeps the running total) |
| `RPC_URL` | your own RPC for the chain |
| `TEMPO` | `off` to never pay on Tempo (default on: MPP `tempo` charges are paid with USDC.e on Tempo, from the same address; put some USDC.e there, it also pays the ~$0.001 fee) |
| `TEMPO_CHAIN` | `4217` (Tempo, default) or `42431` (Moderato testnet, pays in pathUSD) |
| `TEMPO_RPC_URL` | your own Tempo RPC (default `https://rpc.tempo.xyz`) |
| `XRPL_SEED` | optional: the agent's own XRP Ledger account seed (`s…`, a separate account with only what it may spend). Turns on paying x402 offers in RLUSD on the XRP Ledger, including sellers on t54's facilitator (the XRPL AI Hub). Only RLUSD from Ripple's issuer is paid, never XRP; it counts toward the USDC limits, every Payment is checked by presign-guard first, and USDC on your chain goes first when an API offers both. The account needs an RLUSD trust line, RLUSD and a little XRP for fees. Not used under a mandate |
| `SOLANA_PRIVATE_KEY` | optional: the agent's own Solana account (secret key in base58, as wallets export it, or the byte array from a `solana-keygen` file; a separate account with only what it may spend). Turns on paying x402 offers in USDC on Solana: only the agent's USDC transfer to the seller is signed, after presign-guard has checked the transaction (instructions and a simulation), the seller's facilitator pays the network fee (no SOL needed), and it counts toward the USDC limits. USDC on your chain goes first when an API offers both. Not used under a mandate. Needs presign-guard-wallet 0.16+ |
| `SOLANA_NETWORK` | `mainnet` (default) or `devnet` |
| `SOLANA_RPC_URL` | your own Solana RPC (default the public mainnet or devnet one) |
| `ALGORAND_MNEMONIC` | optional: the agent's own Algorand account (25-word mnemonic; a separate account with only what it may spend). Turns on paying x402 offers in USDC on Algorand: only the agent's USDC transfer to the seller is signed (never ALGO, no close-out or rekey), the seller's facilitator pays the network fee, and it counts toward the USDC limits. USDC on your chain goes first when an API offers both. The account must be opted in to USDC (ASA 31566704). Not used under a mandate. Needs presign-guard-wallet 0.12+ |
| `ALGORAND_NETWORK` | `mainnet` (default) or `testnet` |
| `ALGORAND_ALGOD_URL` | your own algod node (default AlgoNode's free one) |
| `MPP_SESSION_DEPOSIT` | optional: turns on paying MPP **sessions** on Tempo (e.g. presign-guard): the first call to a service opens a payment channel with this deposit in USDC.e, then each call is a signed voucher, no transaction per call; when the deposit runs out it is topped up by the same amount. Every deposit counts toward the USDC limits when it is signed; vouchers only spend what is deposited. Used whenever an API offers a session. `close_sessions` closes the channels and the unspent deposit comes back. Needs presign-guard-wallet 0.11+ |
| `MPP_SESSION_FILE` | where open channels are kept between restarts (default `~/.presign-guard-wallet/mpp-sessions.json`) |
| `XRPL_NETWORK` | `mainnet` (default) or `testnet` |
| `XRPL_WS_URL` | your own XRPL node (default `wss://xrplcluster.com`) |
| `AGENT_LABEL` | the name shown in Telegram and AC2 approval requests (default `mcp-agent`) |

One Telegram bot serves one running server at a time, and the bot must not have a webhook. To run several agents on one bot, use the wallet server.

### Linked with a code

Without `AGENT_KEY` (or `AGENT_KEY_FILE`) the wallet sets itself up:

1. On the first tool call it makes the agent wallet's key in `~/.fizzl/agent-key` (or `FIZZL_DIR`), readable only by you. An existing key there is used.
2. It asks the wallet server (`WALLET_SERVER_URL`, default `https://wallet.fizzl.eu`) for a code with only that wallet's address, and every tool answers with the link and the code until it is entered.
3. Signed in on the dashboard, you enter the code and name the agent. The agent's address is filled in for you.
4. The wallet polls with a secret token only it holds, gets its key for the wallet server once, saves it in `wallet-server.json` next to the key, and works from then on, without a restart. On the next start it reads both files.

The code alone is useless without that token, and both last 10 minutes. Removed the agent on the dashboard, or want to link it to another account? Delete `wallet-server.json` and ask for the wallet status again.

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
- `Not done (orange): not signed: orange (SIMULATION_FAILS)`: the simulation shows the transaction would fail, so it isn't sent.

## Also available

- [presign-guard-wallet](https://github.com/Fizzl13/x402-examples/tree/main/guard-wallet): the same guard for your own viem code.
- [presign-guard-agentkit](https://github.com/Fizzl13/x402-examples/tree/main/agentkit-guard): for Coinbase AgentKit agents.

## License

MIT
