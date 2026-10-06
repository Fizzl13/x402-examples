# presign-guard-ai-sdk

Safety checks for [Vercel AI SDK](https://ai-sdk.dev) agents that pay.

Five tools you add to `generateText`, `streamText` or an agent in one line:

| Tool | What the agent checks | Service | Price |
|---|---|---|---|
| `check_before_signing` | a transaction, token approval or signature **before signing it**: green / orange / red with reason codes (drainers, unlimited approvals to unknown spenders, look-alike tokens, Permit/Permit2/Seaport signatures that hand over tokens) | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 |
| `check_xrpl_transaction` | an **XRP Ledger** transaction before signing it: account takeover (SetRegularKey, SignerListSet, master key off), AccountDelete, fake RLUSD (red); partial payments, destinations that refuse or need a tag, risky issuers, DEX orders far below the order book or AMM price (orange) | presign-guard | $0.01 |
| `check_token` | a token **before buying or accepting it**: honeypot, rug-pull signs, look-alikes (Solana, EVM, and XRPL tokens as `CURRENCY.rIssuer`: clawback, freeze, transfer fee, fake RLUSD) | presign-guard | $0.01 |
| `check_wallet_approvals` | every open approval of a wallet and which to revoke | presign-guard | $0.02 |
| `check_endpoint_before_paying` | an x402 or MPP paid API **before paying it**: go / caution / no_go, the cheapest option that settles, budget, track record, bait signs (fake brands, airdrop lures, output that doesn't match) | [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 |

The tools only check. They never sign, pay or move anything themselves. A failed check comes back to the model as `{ error, message }`, so the agent can tell the user instead of crashing.

## See it in 10 seconds (offline, free)

```sh
git clone https://github.com/Fizzl13/x402-examples && cd x402-examples/ai-sdk-guard
npm install && npm run demo
```

A scripted model and stand-in APIs, no keys and no money:

```
▶ check_endpoint_before_paying
   → caution: Payable, with caution: $0.02 on Base. It presents itself as an official service of a well-known brand that does not own this domain (judged by TypeSafe Jev).

▶ check_before_signing
   → red: Unlimited USDC approval to an unknown contract.

Agent: I did not pay: the API pretends to be Coinbase, and the approval it asked for is unlimited to an unknown contract (red).
```

## Install

```sh
npm install presign-guard-ai-sdk ai zod @x402/fetch @x402/evm viem
```

## Use

```js
import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { fizzlTools } from "presign-guard-ai-sdk";

// Pays for the checks over x402 (USDC on Base). Cap it: a check never costs more than $0.02.
const payer = new x402Client().setSpendControls({ maxAmountPerPayment: "$0.02" });
payer.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(process.env.AGENT_KEY)));
const pay = wrapFetchWithPayment(fetch, payer);

const result = await generateText({
  model: anthropic(process.env.ANTHROPIC_MODEL), // any AI SDK model
  tools: { ...fizzlTools({ fetch: pay }), ...yourOtherTools },
  system: "Before you pay any API, call check_endpoint_before_paying. Before you sign anything, call check_before_signing. Never continue on red or no_go.",
  prompt: "Buy the BTC funding rate from https://api.example.com/funding for at most $0.05",
  stopWhen: stepCountIs(8),
});
```

**Try it without a wallet:** with no paying fetch and no credit keys, `check_token`, `check_before_signing` and `check_endpoint_before_paying` fall back to the free quick checks: the verdict only (green / orange / red, or go / caution / no_go with the problems found), a few per hour, marked `free: true` with a note on what the full check costs. `check_wallet_approvals` and `check_xrpl_transaction` have no free version. Pass `free: false` to get `payment_required` instead.

**Prepaid credits instead of a payment per check:** buy a pack once ([presign-guard](https://presign-guard.fizzl.eu/v1/credits): 100 checks for $0.80; [x402 Doctor](https://x402-doctor.fizzl.eu/api/v1/credits): 1000 preflights for $0.80), then pass the keys and a plain `fetch`:

```js
fizzlTools({ creditKeys: { presign: process.env.PRESIGN_CREDIT_KEY, doctor: process.env.DOCTOR_CREDIT_KEY } });
```

**Only some tools:** `fizzlTools({ fetch: pay, only: ["check_endpoint_before_paying", "check_before_signing"] })`.

## Options

| Option | Default | |
|---|---|---|
| `fetch` | global `fetch` | An x402-paying fetch (`wrapFetchWithPayment` from `@x402/fetch`), or plain fetch with credit keys |
| `creditKeys` | none | `{ presign, doctor }`, sent as `x-credit-key` |
| `only` | all five | Tool names to include |
| `free` | `true` | Fall back to the free quick check (verdict only) when a check can't be paid |
| `timeoutMs` | 30000 | Per check |
| `presignUrl`, `doctorUrl` | the fizzl.eu services | For tests or self-hosting |

Works with AI SDK 5, 6 and 7: the tools are plain `{ description, inputSchema, execute }` objects, as `tool()` returns them, with zod 3.25+ or 4 schemas.

## Want the agent to stop itself, not just be told?

The tools inform the model; a model can still ignore them. To make red and over-budget payments impossible, guard the wallet itself with [presign-guard-wallet](https://www.npmjs.com/package/presign-guard-wallet): every signature then goes through presign-guard and your spending limits, with Telegram approval above them. Both together: the agent knows why, and the wallet enforces it.

## License

MIT
