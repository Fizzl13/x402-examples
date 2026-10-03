# presign-guard-agentkit

Spending limits and phone approvals for [Coinbase AgentKit](https://github.com/coinbase/agentkit) agents.

Wrap your AgentKit wallet provider in one line. Every action that spends then goes through [presign-guard](https://presign-guard.fizzl.eu) first, and through your limits. That covers transfers, swaps, token approvals, Permit/Permit2 signatures and x402 payments.

- **Red is never signed.** That covers known drainers, unlimited approvals to unknown spenders and look-alike tokens. The agent gets the reason back and can tell the user.
- **Under your limit, the agent is free to buy.** Example: up to 5 USDC per purchase and 20 USDC a day.
- **Over the limit, it waits for you.** You get a Telegram message with Approve / Deny, or decide on the [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) dashboard. No answer means no signature.
- **Nothing is signed when something fails.** If the check can't be done or the server can't be reached, the wallet stops.

The keys stay where they are: in your CDP wallet, Privy wallet or viem key. This package only decides whether a signature is allowed. Each check costs $0.01, paid over x402 or from prepaid credits.

Try the dashboard (demo data): **https://wallet.fizzl.eu/demo**

## See it in 30 seconds (offline, free)

```sh
git clone https://github.com/Fizzl13/x402-examples && cd x402-examples/agentkit-guard
npm install && npm run demo
```

No keys, no network, no money: the wallet and presign-guard are stand-ins. It shows exactly what your agent gets back:

```
▶ Pay 2 USDC to an API (within the 5 USDC limit)
   ✓ signed: 0xabab…

▶ Approve unlimited USDC to a known drainer
   ✕ not signed (red): not signed: red (known_drainer)

▶ Pay 8 USDC (over the 5 USDC limit: asks you)
   (you'd get a Telegram message: "8 USDC is over the limit of 5 per transaction". Here: denied.)
   ✕ not signed (over_limit): not signed: 8 USDC is over the limit of 5 per transaction

▶ The agent checks its own budget (get_spending_limits):
   {"limits":[{"token":"USDC","perTx":"5","perDay":"20","used":"2","left":"18"}],"paused":false}

▶ Pay 1 USDC while paused
   ✕ not signed (paused): wallet is paused; nothing was signed
```

The code is in [example/demo.mjs](https://github.com/Fizzl13/x402-examples/blob/main/agentkit-guard/example/demo.mjs): swap the stand-ins for your real provider and `pay` (below) and that's your agent.

## What your agent sees

| Situation | The wallet provider | The agent gets |
|---|---|---|
| Green, within limits | signs as usual | the transaction hash or signature |
| Red (drainer, sanctioned, look-alike token, unlimited approval to an unknown spender) | refuses | `not signed: red (<reason codes>)` |
| Over a limit | asks you (Telegram or dashboard); no answer is no | the hash if you approve, else `not signed: … over the limit …` |
| Paused (by you or by the agent) | refuses | `wallet is paused; nothing was signed` |
| presign-guard or your server unreachable | refuses | `not signed (check_failed): …` |

AgentKit returns these messages to the model like any other tool result, so the agent can explain to the user why it didn't pay.

## Install

```sh
npm install presign-guard-agentkit @coinbase/agentkit
```

## Use

```js
import { AgentKit, CdpEvmWalletProvider, walletActionProvider, erc20ActionProvider, x402ActionProvider } from "@coinbase/agentkit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { guardWalletProvider, walletGuardActionProvider } from "presign-guard-agentkit";
import { telegramApprover } from "presign-guard-wallet/telegram";

const provider = await CdpEvmWalletProvider.configureWithWallet({ networkId: "base-mainnet" /* , … */ });

// Pays for the checks ($0.01 each). Build it from the original provider, not the wrapped one.
const payer = new x402Client().setSpendControls({ maxAmountPerPayment: "$0.02" });
payer.register("eip155:8453", new ExactEvmScheme(provider.toSigner()));
const pay = wrapFetchWithPayment(fetch, payer);

const walletProvider = guardWalletProvider(provider, {
  pay,
  limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } },
  onOverLimit: telegramApprover({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, label: "shopping-agent" }),
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [walletActionProvider(), erc20ActionProvider(), x402ActionProvider(), walletGuardActionProvider()],
});
```

Everything else in your agent stays the same, whether you use LangChain, the Vercel AI SDK or MCP.

### One budget for all your agents

With the [wallet server](https://github.com/Fizzl13/x402-examples/tree/main/wallet-server) you get one price rule and one daily budget for all your agents, approvals on a dashboard and on Telegram, and a log of what they bought:

```js
const walletProvider = guardWalletProvider(provider, {
  pay,
  server: { url: process.env.WALLET_SERVER_URL, key: process.env.WALLET_SERVER_KEY }, // instead of limits / onOverLimit
});
```

### Prepaid credits instead of x402

```js
guardWalletProvider(provider, { creditKey: process.env.PRESIGN_CREDIT_KEY, pay }); // pay = fallback when the credits run out
```

All options of [presign-guard-wallet](https://github.com/Fizzl13/x402-examples/tree/main/guard-wallet#options) work here too, including `onOrange`, `origin`, `onVerdict`, `store` and `onSpend`.

## What is covered

| Wallet provider method | Used by | Guarded |
|---|---|---|
| `sendTransaction` | transfers, swaps, approvals, contract calls | checked, counts toward limits |
| `nativeTransfer` | `walletActionProvider` | checked (re-routed through `sendTransaction`) |
| `signTypedData` | Permit, Permit2, x402 payments | checked, counts toward limits |
| `signTransaction` | | checked, counts toward limits |
| `toSigner()`, `toEip1193Provider()` | x402 actions, other libraries | built from the guarded methods |
| `sign(hash)` | | **refused**: a raw hash can't be checked (`allowRawSign: true` to permit) |
| `getClient()` | CDP swap / spend-permission actions | **refused**: the CDP client signs around the guard (`allowUnguardedClient: true` to permit) |
| `signMessage` | sign-in messages | not checked (plain text, no spending) |
| reads (`getBalance`, `readContract`, …) | | passed through |

Only EVM wallets are covered (Ethereum, Base, Optimism, Arbitrum, Polygon and BNB Chain). Solana providers are refused.

## The agent's own actions

`walletGuardActionProvider()` adds two actions:

- **`get_spending_limits`**: the agent sees its limits and what is left today, so it can tell the user before it buys something that needs approval.
- **`pause_spending`**: the agent can stop itself when something looks wrong, for example an unexpected request to approve tokens. Nothing is signed until you resume it with `walletProvider.guard.resume()` or on the dashboard.

You can also pause from your own code: `walletProvider.guard.pause()`, `.resume()`, `.paused()`, `.spending()`.

## When something is refused

Instead of signing, the wallet throws a `PresignBlockedError`. AgentKit passes the message on to the agent, for example `not signed: over the 5 USDC per-transaction limit (denied by the owner)`. `err.code` is one of:

- `red`;
- `orange`;
- `over_limit`;
- `paused`;
- `check_failed`;
- `limit_unavailable`;
- `unsupported_chain`;
- `bad_receipt`;
- `unchecked`.

## License

MIT
