# presign-guard-solana-agent-kit

Spending limits and phone approvals for [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) agents (SendAI).

Wrap your agent's wallet in one line. Every transaction it signs then goes through [presign-guard](https://presign-guard.fizzl.eu) first, and through your limits. That covers transfers, swaps, token launches and staking, from every plugin, because they all sign through the wallet.

- **Red is never signed.** presign-guard reads every instruction and simulates the transaction. Handing a token account to someone else (SetAuthority) or a System Assign of the wallet is red. The agent gets the reason back and can tell the user.
- **Orange waits.** An unlimited token delegate, a durable nonce (signable much later), closing a token account to someone else, or an owner or delegate change the instructions don't show is not signed by default (`onOrange` decides).
- **Under your limit, the agent is free to act.** What the simulation shows leaving the wallet counts: SOL beyond the network fee toward `SOL`, USDC toward `USDC`. Example: up to 0.1 SOL per transaction and 0.5 SOL a day.
- **Over the limit, it waits for you.** You get a Telegram message with Approve / Deny, or decide on the [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) dashboard. No answer means no signature.
- **Nothing is signed when something fails.** If the check can't be done or the simulation is incomplete, the spending counts as unknown and goes to you.

The key stays in your wallet. This package only decides whether a signature is allowed. Each check costs $0.01, paid in USDC on Base over x402 or from prepaid credits.

## Install

```sh
npm install presign-guard-solana-agent-kit
```

## Use

```js
import { Keypair } from "@solana/web3.js";
import { KeypairWallet, SolanaAgentKit } from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import { guardSolanaWallet, GuardPlugin } from "presign-guard-solana-agent-kit";
import { telegramApprover } from "presign-guard-wallet/telegram";

const rpcUrl = process.env.RPC_URL;
const wallet = guardSolanaWallet(new KeypairWallet(Keypair.fromSecretKey(secretKey), rpcUrl), {
  pay,     // an x402-paying fetch for the $0.01 checks (wrapFetchWithPayment from @x402/fetch), or creditKey
  limits: { tokens: { SOL: { perTx: "0.1", perDay: "0.5" }, USDC: { perTx: "5", perDay: "20" } } },
  onOverLimit: telegramApprover({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }),
});

const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(TokenPlugin).use(GuardPlugin);
```

A refused transaction throws `PresignBlockedError` with a `code`: `red`, `orange`, `over_limit`, `paused`, `check_failed` or `unchecked`. The action fails with that message, so the agent can tell the user why.

### Limits on the wallet server instead

```js
guardSolanaWallet(wallet, {
  pay,
  server: { url: process.env.WALLET_SERVER_URL, key: process.env.WALLET_SERVER_KEY }, // instead of limits / onOverLimit
});
```

All options of [presign-guard-wallet](https://github.com/Fizzl13/x402-examples/tree/main/guard-wallet#options) work here too, including `onOrange`, `origin`, `onVerdict`, `store` and `onSpend`. Also: `network` (`"mainnet"`, default, or `"devnet"`) and `rpcUrl` (to send with, when the wallet has none).

## What is covered

| Wallet method | Used by | Guarded |
|---|---|---|
| `signTransaction`, `signAllTransactions` | `signOrSendTX` (signOnly), the plugins | checked, counts toward limits |
| `signAndSendTransaction` | `signOrSendTX`, the plugins | checked and counted, then the signed bytes are sent |
| `sendTransaction` | | checked and counted (KeypairWallet's own would sign again) |
| `signMessage` | sign-in messages | **refused**: a Solana message can't be checked (`allowRawSign: true` to permit) |
| `payer` (KeypairWallet's keypair) | | **hidden**: the raw key would sign around the guard (`allowRawSign: true` to permit) |
| `publicKey`, `rpcUrl` | | passed through |

Legacy and versioned transactions are both covered. A signature already on a transaction (a new mint's keypair, say) stays.

## The agent's own actions

`GuardPlugin` adds two actions:

- **`GET_SPENDING_LIMITS`**: the agent sees its limits and what is left today, so it can tell the user before something needs approval.
- **`PAUSE_SPENDING`**: the agent can stop itself when something looks wrong, for example an unexpected request to delegate tokens. Nothing is signed until you resume it with `wallet.guard.resume()` or on the dashboard.

## Costs and coverage

Each check is $0.01 (or 100 for $0.80 as prepaid credits). presign-guard covers Solana mainnet; on devnet the simulation runs against mainnet and usually fails (orange), so use devnet for trying the wiring, not the verdicts.

These limits live in your agent's software: they stop a confused or manipulated agent, not someone who has the private key.

Part of [Fizzl](https://fizzl.eu). Same guard for [Coinbase AgentKit](https://www.npmjs.com/package/presign-guard-agentkit), [MCP agents](https://www.npmjs.com/package/presign-guard-wallet-mcp) and [your own code](https://www.npmjs.com/package/presign-guard-wallet).
