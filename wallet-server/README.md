# Fizzl agent wallet server

One budget and one set of rules for all your AI agents. Your agents buy on their own up to the price you set; above it they ask you, on the dashboard or on Telegram. Every purchase lands in an activity log.

The server **never holds keys or funds**: each agent signs and pays itself with [presign-guard-wallet](../guard-wallet), and only asks this server "may I?" first. If the server can't be reached, the agent stops instead of signing.

## What it does

- **Price rule and budget:** a max per purchase and a daily budget per token (USDC on six chains, ETH, BNB, POL, or any token by address), an optional allow list. Same format as presign-guard-wallet's `limits`, edited on the dashboard.
- **One budget for all agents:** checks run one at a time, so two agents can't both fit in the last of a budget.
- **Approvals:** over a limit, the agent waits (up to 10 minutes) while you approve or deny on the dashboard or with the Telegram buttons. No answer means not signed.
- **Agents:** each gets its own key (`awk_…`, stored only as a hash); pause or remove one, or pause all.
- **Trust:** a presign-guard verdict counts only with its valid signature over exactly that request.

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
3. Open the URL, log in, set your price rule, add an agent and copy its key.

## Connect an agent

```js
import { guardWallet } from "presign-guard-wallet";

const wallet = guardWallet(walletClient, {
  pay, // or creditKey: presign-guard checks every signature first
  server: { url: process.env.WALLET_SERVER_URL, key: process.env.WALLET_SERVER_KEY },
});
```

Everything else stays the same: red verdicts are never signed, `onOrange` still decides on orange, and with the server in place the limits, budget and approvals come from the dashboard.

## API (for agents)

`Authorization: Bearer awk_…`

| | |
|---|---|
| `POST /v1/reserve` `{ method, request, verdict }` | `{ status: "ok", entries }`, `{ status: "pending", approvalId }`, `{ status: "denied" }` or `{ status: "paused" }` |
| `GET /v1/approvals/:id?wait=25` | long poll: `pending`, `approved` (with entries), `denied`, `expired` |
| `POST /v1/release` `{ entries }` | signing failed: give the spending back |
| `POST /v1/spent` `{ entries, result }` | record the signed result |
| `GET /v1/spending`, `GET /v1/policy` | |

MIT licensed.
