# Fizzl agent wallet server

One budget and one set of rules for all your AI agents. Your agents buy on their own up to the price you set; above it they ask you, on the dashboard, in the app on your phone or on Telegram. Every purchase lands in an activity log.

**[Live demo with example data →](https://wallet.fizzl.eu/demo)**

The server **never holds keys or funds**: each agent signs and pays itself with [presign-guard-wallet](../guard-wallet), and only asks this server "may I?" first. If the server can't be reached, the agent stops instead of signing.

## What it does

- **Price rule and budget:** a max per purchase and a daily budget per token (USDC on six chains, ETH, BNB, POL, or any token by address), an optional allow list. Same format as presign-guard-wallet's `limits`, edited on the dashboard.
- **One budget for all agents:** checks run one at a time, so two agents can't both fit in the last of a budget.
- **Approvals:** over a limit, the agent waits (up to 10 minutes) while you approve or deny on the dashboard, from a notification on your phone or with the Telegram buttons. No answer means not signed.
- **Agents:** each gets its own key (`awk_…`, stored only as a hash); pause or remove one, or pause all.
- **Trust:** a presign-guard verdict counts only with its valid signature over exactly that request.

## Receipts

Every signature an agent makes gets a receipt. Click a line in the activity log, or "Receipt" on an approved request, to see:
- **what** was bought: the URL and description the agent gave with `withPurchase()` in presign-guard-wallet (0.6+);
- the **amount**, recipient and network, with explorer links;
- presign-guard's **verdict**, with its signed receipt ID; the server checks that signature;
- the **approval**: who decided, how and when;
- the **result**: the transaction or signature, the x402 settlement and the API's answer, or why it failed (the spending is then given back).

Receipts are kept for 90 days. The MCP server and agents using `withPurchase` fill in "what" automatically.

## Run it on Render

1. New Web Service from this repository, **Root Directory** `wallet-server` (or use `render.yaml`). Build `npm ci --omit=dev`, start `node server.js`. Run a single instance.
2. Environment variables (only in Render, never in code):
   | Variable | |
   |---|---|
   | `ADMIN_PASSWORD` | dashboard password, 12+ characters |
   | `WALLET_REDIS_URL` | a persistent Redis, e.g. a free Upstash database: `rediss://default:…@…upstash.io:6379`. Without it, everything is lost on a restart |
   | `PUBLIC_URL` | the service's URL, e.g. `https://wallet.fizzl.eu` |
   | `TELEGRAM_BOT_TOKEN` | optional: a bot **only this server uses** (the server sets a webhook on it, so it can't also be polled by `telegramApprover`) |
   | `TELEGRAM_CHAT_ID` | your Telegram user id |
   | `PRO_PAY_TO` | optional: the address customers' Pro payments go to |
   | `PRO_PRICE_USDC` | optional: Pro per 30 days (default 5) |
   | `SESSION_SECRET` | optional: signs dashboard sessions (default: derived from `ADMIN_PASSWORD`) |
   | `BASE_RPC_URL` | optional: the Base RPC used to check payments (default `https://mainnet.base.org`) |
   | `WALLET_SIGNIN` | `off` for a private server only you use (no customer sign-in) |
   | `OPERATOR_NAME` | who runs the service, shown in the privacy statement at `/privacy` |
   | `CONTACT_EMAIL` | where customers reach you about their data, shown in the privacy statement |
   | `SUBSCRIPTION_CONTRACT` | optional: the deployed [subscription contract](../subscription) for automatic Pro payments |
   | `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`, `POLYGON_RPC_URL` | optional: RPCs to check Pro payments made on those networks (public RPCs by default). Pro can be paid in USDC on Base, Arbitrum, Optimism, Polygon or Ethereum, to `PRO_PAY_TO` on each |
   | `SOLANA_PAY_TO` | optional: the Solana address that receives Pro payments. Turns on signing in with Phantom on Solana and paying Pro in USDC on Solana |
   | `SOLANA_RPC_URL` | optional: a Solana RPC to build and check those payments (default `https://api.mainnet-beta.solana.com`) |
   | `XRPL_PAY_TO` | the XRPL account that receives Pro paid in RLUSD (needs an RLUSD trust line; default Fizzl's account). `off` turns it off |
   | `XRPL_RPC_URL` | optional: an XRPL JSON-RPC node to check those payments (default `https://xrplcluster.com`) |
   | `XAMAN_API_KEY` | optional: the public API key of a Xaman app ([apps.xumm.dev](https://apps.xumm.dev), redirect URI `<PUBLIC_URL>/api/signin/xaman/callback`). Turns on "Sign in with Xaman": OAuth2 with PKCE, no secret needed; the XRPL account is the identity and pays Pro in RLUSD |
   | `CHARGER_KEY` | optional: private key of a **new, separate** wallet with a little ETH on Base that sends the monthly charges (never your payout wallet) |
3. Open the URL, log in, set your price rule, add an agent and copy its key.

## Customers (hosted)

Anyone can sign in with their wallet: MetaMask, Phantom, Coinbase Wallet, Rabby or any other EVM wallet in the browser (every installed wallet gets its own button, EIP-6963; "Sign-In with Ethereum"). It costs one free signature: no password, no transaction. Each customer gets their own space with their own agents, rules, approvals, receipts and log; nobody sees anyone else's. You keep signing in with the password, as the owner.

- **Telegram:** one bot for everyone. A customer clicks "Connect Telegram", presses Start, and their approval requests go to their chat. Only that Telegram user can tap Approve or Deny on them.
- **Outreach to sellers (owner only, optional):** short one-off e-mails to sellers whose paid endpoint is broken, with the fix and the gateway pilot. x402 Doctor hands in a draft when someone checks a broken endpoint that publishes a contact address (`POST /hooks/outreach-draft` with `OUTREACH_KEY`); you can also add one on the dashboard (Stats → Outreach to sellers). Claude can hand in a written message too (`POST /hooks/outreach-message` with `DRAFT_KEY`, a separate key; the `outreach-draft` workflow does it). Nothing is mailed until you press Send there or on Telegram. One mail per address, ever; at most `OUTREACH_DAILY_LIMIT` (10) a day; every mail ends with a "reply stop" line, and "Never mail" records a stop. Needs `RESEND_API_KEY`, `OUTREACH_FROM` (a fizzl.eu sender) and optionally `OUTREACH_REPLY_TO`.
- **Sign in with e-mail (optional):** with `RESEND_API_KEY` set, customers can also sign in with a 6-digit code mailed to them, no wallet needed (their agents keep their own wallets). Only a fingerprint of the address and a hint ("f…@gmail.com") are kept. A wallet account can add an e-mail to sign in with either; an e-mail account connects the wallet it pays Pro from with one free signature.
- **Face ID (passkeys):** once signed in, add Face ID, Touch ID or a fingerprint on the Account tab; then "Sign in with Face ID" needs nothing else. Standard WebAuthn, checked with node:crypto; only the public key is kept, and the device must confirm it's you (user verification required).
- **On your phone:** the dashboard installs as an app (iPhone: Safari → Share → Add to Home Screen; Android and computers: Install). Turn on notifications on the Account tab and approval requests and alerts arrive as notifications; a tap opens the approval, and on Android you can approve or deny right in the notification. Standard Web Push, encrypted end to end, no extra setup: the signing key comes from `VAPID_PRIVATE_KEY` or else from the session secret.
- **Free:** 1 agent, receipts kept 7 days.
- **Pro:** unlimited agents, receipts kept 90 days, $5 per 30 days (`PRO_PRICE_USDC`).
  - Paid in USDC on Base, Arbitrum, Optimism, Polygon or Ethereum (or on Solana with `SOLANA_PAY_TO`), straight from the customer's wallet to `PRO_PAY_TO`. The server checks each payment on-chain: from the signed-in address, to your address, at least the price, within 7 days, and used once. Or in RLUSD on the XRP Ledger (Xaman or any XRPL wallet), from any account: each account has its own destination tag; the customer pastes the transaction hash and the server checks the delivered RLUSD (Ripple's issuer, $1 each), the tag, within 7 days, used once.
  - Paying for 12 months at once adds a year.
  - A Telegram reminder goes out 3 days before Pro ends. After it ends there are 3 days of grace, then the account drops to free. Extra agents are paused, nothing is deleted.
- **Automatic payment:** with the [subscription contract](../subscription) deployed (one click on your dashboard), customers can turn on automatic payment.
  - They approve at most 12 months and subscribe. The contract can only pay you $5 per 30 days.
  - The server charges what is due every hour, reminds them on Telegram 3 days before each payment, and tells them if a charge can't go through (approval used up, not enough USDC).
  - They can turn it off any time.
- **Terms and privacy:** terms of service at `/terms` and a privacy statement at `/privacy` that matches what the server stores.
  - Customers can delete their account themselves. Payment records stay for 7 years.
  - Decided approval requests are deleted after 7 days.
  - Fonts are served by the server, so pages load nothing from third parties.
- **Bookkeeping:** as the owner, "Download Pro payments (CSV)" on your dashboard lists every payment.

## Connect an agent

```js
import { guardWallet } from "presign-guard-wallet";

const wallet = guardWallet(walletClient, {
  pay, // or creditKey: presign-guard checks every signature first
  server: { url: process.env.WALLET_SERVER_URL, key: process.env.WALLET_SERVER_KEY },
});
```

Everything else stays the same: red verdicts are never signed, `onOrange` still decides on orange, and with the server in place the limits, budget and approvals come from the dashboard.

## Mandates

Unusual purchases: once an agent has 5 or more purchases, every new one within the rules is compared with what it usually buys, by TypeSafe's Jev, in the background. Clearly out of character (85% or more, e.g. a market-data agent paying for an "airdrop claim") gives the owner a heads-up on Telegram and the phone, and a line in the log, at most once a day per agent and seller. It never blocks or delays a purchase; off without `TYPESAFE_API_KEY`.

Per agent, the owner can set a spending mandate on the dashboard ([x402 `authority` extension draft](https://github.com/x402-foundation/x402/pull/3220), `x402-mandate/1`): a total budget in USDC on Base, an optional maximum per payment, the sellers it may pay (or any), how many days, and what it is for. The server signs it for the owner with an Ed25519 key of the account, derived from `MANDATE_SECRET` (set it in Render; without it, mandates are off), and is the accountant: every spend of that agent is held to the terms, including the running total, and anything outside is stopped. The purpose is judged per purchase by TypeSafe's Jev (as the plain-words rule): outside it or unsure, the owner is asked. Agents fetch the signed mandate with `GET /v1/mandate`; presign-guard-wallet-mcp (0.10+) does that by itself, so its x402 payments carry the mandate's binding and presign-guard checks them too. New terms start a new mandate (spent back to 0); "end" removes it and the normal limits apply again.

## API (for agents)

`Authorization: Bearer awk_…`

| | |
|---|---|
| `POST /v1/reserve` `{ method, request, verdict, purchase? }` | `{ status: "ok", entries, purchaseId }`, `{ status: "pending", approvalId }`, `{ status: "denied" }` or `{ status: "paused" }` |
| `GET /v1/approvals/:id?wait=25` | long poll: `pending`, `approved` (with entries and purchaseId), `denied`, `expired` |
| `POST /v1/release` `{ entries, purchaseId?, error? }` | signing failed: give the spending back |
| `POST /v1/spent` `{ entries, result, purchaseId? }` | record the signed result |
| `POST /v1/purchases/annotate` `{ ids, outcome }` | what happened afterwards: `{ httpStatus, settlement: { transaction, network }, error }` |
| `GET /v1/spending`, `GET /v1/policy` | |
| `GET /v1/mandate?address=0x…` | the agent's signed spending mandate (`{ mandate, alg, sig, terms }`), or 404 without one |

MIT licensed.
