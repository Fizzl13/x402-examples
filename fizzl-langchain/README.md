# fizzl-langchain

Safety checks for [LangChain.js](https://js.langchain.com) and [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) agents that pay. The JavaScript twin of the [official LangChain integration](https://docs.langchain.com/oss/python/integrations/tools) `fizzl` for Python.

Docs: [fizzl.eu/agents/langchain-js](https://fizzl.eu/agents/langchain-js/)

Nine LangChain tools you pass to `createAgent`, `createReactAgent` or `model.bindTools`:

| Tool | What the agent checks | Service | Price |
|---|---|---|---|
| `check_before_signing` | a transaction, token approval or signature **before signing it**: green / orange / red with reason codes (drainers, unlimited approvals to unknown spenders, look-alike tokens, Permit/Permit2/Seaport signatures that hand over tokens). With `from` (the agent's wallet) a transaction is simulated, so a hidden approval, an NFT leaving or a transaction that would fail shows up; with `intent` (one sentence) signing something else than meant is caught; with `x402` (the accepts entry being paid) a payment that pays more or someone else is red | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 |
| `check_xrpl_transaction` | an **XRP Ledger** transaction before signing it: account takeover (SetRegularKey, SignerListSet, master key off), AccountDelete, fake RLUSD (red); partial payments, destinations that refuse or need a tag, risky issuers, DEX orders far below the order book or AMM price (orange) | presign-guard | $0.01 |
| `check_solana_transaction` | a **Solana** transaction before signing it: every instruction is read and the transaction simulated. Token account takeover (SetAuthority), System Assign (red); unlimited delegates, durable nonces, closing to someone else, hidden owner or delegate changes, a failing transaction (orange) | presign-guard | $0.01 |
| `check_message` | a plain message before `personal_sign` / `eth_sign`: eth_sign, a Sign-In with Ethereum message for another site (red); unreadable bytes, a sign-in for another URI, address or chain (orange) | presign-guard | $0.01 |
| `check_algorand_transaction` | an **Algorand** transaction or atomic group before signing it: every transaction your account sends is read and the group simulated. Rekey to another key, closing the account or an asset holding to someone else, fake USDC (red); clawbacks, risky opt-ins, app update/delete/clear-state, a partial group, a group that would fail (orange) | presign-guard | $0.01 |
| `check_token` | a token **before buying or accepting it**: honeypot, rug-pull signs, look-alikes (Solana, EVM, XRPL tokens as `CURRENCY.rIssuer`: clawback, freeze, transfer fee, fake RLUSD, and Algorand assets by id: fake USDC, clawback, default-frozen) | presign-guard | $0.01 |
| `check_wallet_approvals` | every open approval of a wallet and which to revoke | presign-guard | $0.02 |
| `screen_wallet` | a wallet address **before paying it or accepting money from it**: any chain's address (EVM, Solana, Tron, Bitcoin, XRPL, Algorand) against the OFAC SDN sanctions list, synced from the US Treasury, plus theft and phishing reports for EVM (red names the SDN entry) | presign-guard | $0.01 |
| `check_endpoint_before_paying` | an x402 or MPP paid API **before paying it**: go / caution / no_go, the cheapest option that settles, budget, track record, bait signs (fake brands, airdrop lures, output that doesn't match) | [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 |

The tools only check. They never sign, pay or move anything themselves. A failed check comes back to the model as `{ "error", "message" }`, so the agent can tell the user instead of crashing. Each tool returns its answer as a JSON string.

## Install

```sh
npm install fizzl-langchain @langchain/core zod
npm install @x402/fetch @x402/evm viem   # to pay for the full checks over x402
```

## Try it without a wallet

```js
import { fizzlTools } from "fizzl-langchain";

const [checkToken] = fizzlTools({ only: ["check_token"] });
console.log(await checkToken.invoke({ chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }));
// {"verdict":"green","grade":"SAFE","free":true,"note":"Free quick check: the verdict only, a few per hour. ..."}
```

With no paying fetch and no credit keys, `check_token`, `check_before_signing`, `check_solana_transaction`, `check_algorand_transaction`, `check_message` and `check_endpoint_before_paying` fall back to the free quick checks: the verdict only (green / orange / red, or go / caution / no_go with the problems found), a few per hour, marked `free: true` with a note on what the full check costs. `check_wallet_approvals` and `check_xrpl_transaction` have no free version. Pass `free: false` to get `payment_required` instead.

## Use in an agent

```js
import { createAgent } from "langchain";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { fizzlTools } from "fizzl-langchain";

// Pays for the checks over x402 (USDC on Base). Cap it: a check never costs more than $0.02.
const payer = new x402Client().setSpendControls({ maxAmountPerPayment: "$0.02" });
payer.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(process.env.AGENT_KEY)));
const pay = wrapFetchWithPayment(fetch, payer);

const agent = createAgent({
  model: yourChatModel, // any chat model with tool calling
  tools: [...fizzlTools({ fetch: pay }), ...yourOtherTools],
  systemPrompt: "Before you pay any API, call check_endpoint_before_paying. Before you sign anything, call check_before_signing. Never continue on red or no_go.",
});

const result = await agent.invoke({ messages: [{ role: "user", content: "Buy the BTC funding rate from https://api.example.com/funding for at most $0.05" }] });
```

With LangGraph: `createReactAgent({ llm, tools: fizzlTools({ fetch: pay }) })` from `@langchain/langgraph/prebuilt`.

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
| `only` | all nine | Tool names to include |
| `free` | `true` | Fall back to the free quick check (verdict only) when a check can't be paid |
| `timeoutMs` | 30000 | Per check |
| `presignUrl`, `doctorUrl` | the fizzl.eu services | For tests or self-hosting |

Works with `@langchain/core` 0.3.58+ and 1.x, zod 3.25+ or 4. The checks themselves come from [presign-guard-ai-sdk](https://www.npmjs.com/package/presign-guard-ai-sdk), the same tools for the Vercel AI SDK.

## Want the agent to stop itself, not just be told?

The tools inform the model; a model can still ignore them. To make red and over-budget payments impossible, guard the wallet itself with [presign-guard-wallet](https://www.npmjs.com/package/presign-guard-wallet): every signature then goes through presign-guard and your spending limits, with Telegram approval above them. Both together: the agent knows why, and the wallet enforces it.

## License

MIT
