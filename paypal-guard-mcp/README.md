# fizzl-paypal-guard-mcp

PayPal's [Agent Toolkit](https://github.com/paypal/agent-toolkit) as an [MCP](https://modelcontextprotocol.io) server for Claude Desktop, Claude Code, Cursor and other MCP clients, with [fizzl-paypal-guard](https://github.com/Fizzl13/x402-examples/tree/main/paypal-guard) between the model and PayPal.

It has the same 47 tools as PayPal's own MCP server (`@paypal/mcp`), under the same names. The difference: every call that moves or promises money is checked first.

- **Reads pass straight through.** Orders, invoices, transactions, disputes and refunds: look as much as you like.
- **Never more than is left.** A refund without an amount refunds everything that's left of a payment. The guard reads the payment at PayPal first. A refund of a payment that was already refunded in full is stopped, and so is a refund for more than is left.
- **Your limits.** By default up to $25 per refund, $100 and 10 refunds a day, and one refund per payment a day. Cancellations and bills have a number a day.
- **You decide the rest.** Above a limit, and for every accepted dispute, price change or invoice marked as paid, you get Approve and Deny: on your phone (Telegram, or the [Fizzl Agent Wallet](https://wallet.fizzl.eu)) or in the chat app itself. No answer means no.
- **A log the agent doesn't write.** Every action that isn't a read is logged on your machine with its decision, the reasons and who approved it. The day's counts are kept there too, so restarting the app doesn't give the agent a fresh day of limits.

A blocked call returns `{ "blocked": true, "reasons": […], "message": "Not done (…)" }`, and the message tells the model not to try another way. The model can't talk its way past the guard: the checks use facts from PayPal and limits from you, never what the conversation says.

Live demo of the guard (a support agent in the PayPal sandbox): **https://fizzl-paypal-demo.onrender.com**

## Set up

1. **Make a REST app** at [developer.paypal.com](https://developer.paypal.com/dashboard/applications) → Apps & Credentials. Start in **Sandbox**: test money only. Copy its client ID and secret.
2. **Add the server to your MCP client.** For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": ["-y", "fizzl-paypal-guard-mcp", "--tools=all"],
      "env": {
        "PAYPAL_CLIENT_ID": "your sandbox client id",
        "PAYPAL_CLIENT_SECRET": "your sandbox secret",
        "PAYPAL_ENVIRONMENT": "SANDBOX"
      }
    }
  }
}
```

For Claude Code:

```sh
claude mcp add paypal -e PAYPAL_CLIENT_ID=… -e PAYPAL_CLIENT_SECRET=… -e PAYPAL_ENVIRONMENT=SANDBOX -- npx -y fizzl-paypal-guard-mcp --tools=all
```

3. **Restart the app** and ask, for example: *"List my PayPal transactions of the last week"*, then *"Refund capture 2GG… in full"*. Ask `paypal_guard_status` what the guard allows and what it did today.

Coming from `@paypal/mcp`? Use the same `--tools` list. Instead of `PAYPAL_ACCESS_TOKEN` this server takes the app's client ID and secret: an access token stops working after about nine hours, and the guard needs to read payments itself.

## Approvals

When an action needs your OK, the server asks the first of these that is set up:

| Where | How | Settings |
|---|---|---|
| **Fizzl Agent Wallet** | Approve or Deny in Telegram (@FizzlWalletBot) or on the wallet dashboard, next to your agents' other payments. The outcome (PayPal's refund id) lands on a receipt there. | `FIZZL_AGENT_KEY`: an agent key (`awk_…`) from [wallet.fizzl.eu](https://wallet.fizzl.eu) → Agents |
| **Your own Telegram bot** | A message from your bot with Approve and Deny. Make a bot with [@BotFather](https://t.me/BotFather) and send it `/start`; get your chat id from [@userinfobot](https://t.me/userinfobot). The bot must have no webhook. | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| **In the chat app** | A form in the app itself (MCP elicitation), with Approve or Deny. Only you can answer it, not the model. Works in MCP clients that support elicitation; in others, use your phone. | Nothing; `APPROVAL_IN_CHAT=off` to turn it off |

With none of these, anything over a limit is simply not done.

A phone is the stronger choice: the question reaches you on a different device than the one the agent runs on. And it can wait longer than an MCP client waits for a tool call. If you haven't answered after `APPROVAL_WAIT_SECONDS` (45), the call returns `"waiting": true` with an approval id. The approval goes on: approve within `APPROVAL_MINUTES` (10) and the action runs then; otherwise nothing happens. The model is told not to try again, and `paypal_guard_status` with the approval id shows what became of it.

## Settings

| Variable | |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Your REST app. Without them the server lists its tools and every call explains how to set it up. |
| `PAYPAL_ENVIRONMENT` | `SANDBOX` (default) or `PRODUCTION` |
| `--tools=` or `PAYPAL_TOOLS` | `all` (default), or names as in PayPal's MCP server: `payments.createRefund,payments.getRefunds,orders.get,transactions.list,invoices.list,…` |
| `LIMIT_REFUND` | Most per refund without asking you (default 25.00) |
| `LIMIT_REFUND_PER_DAY` | Refunds a day, in total (default 100.00) |
| `LIMIT_REFUNDS_PER_DAY` | Number of refunds a day (default 10) |
| `LIMIT_CURRENCY` | The currency of the limits (default USD). A refund in another currency asks you. |
| `GUARD_POLICY` | Anything else, as JSON over [the defaults](https://github.com/Fizzl13/x402-examples/tree/main/paypal-guard#policy): for example `{"dispute":"deny","stop":"ask","bill":{"countPerDay":5}}`. Each kind takes `"allow"`, `"ask"`, `"deny"` or limits. |
| `FIZZL_AGENT_KEY`, `FIZZL_WALLET_URL` | Approvals through the Fizzl Agent Wallet (URL default https://wallet.fizzl.eu) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Approvals through your own Telegram bot |
| `APPROVAL_IN_CHAT` | `off` to never ask in the chat app |
| `APPROVAL_MINUTES` | How long you have to answer (default 10) |
| `APPROVAL_WAIT_SECONDS` | How long a tool call waits for your answer before it returns "waiting" (default 45) |
| `AGENT_NAME` | The name your phone shows (default: the MCP client's name) |
| `GUARD_STATE_DIR` | Where the day's counts and the log are kept (default `~/.fizzl-paypal-guard`; sandbox and live apart) |

## Tools

All tools of PayPal's Agent Toolkit 1.11, sorted by what they can do to your money:

| Kind | Tools | By default |
|---|---|---|
| read | `get_order`, `list_transactions`, `get_refund`, `list_invoices`, `get_invoice`, `list_disputes`, `get_dispute`, … | Pass |
| refund | `create_refund` | Never more than is left; $25 each, $100 and 10 a day, one per payment a day; then you |
| dispute | `accept_dispute_claim` (pays the buyer) | You decide each one |
| books | `record_payment_for_invoice`, `record_refund_for_invoice` (money marked as moved while none moves) | You decide each one |
| stop | `cancel_subscription`, `cancel_sent_invoice`, `delete_invoice`, … | 3 a day, then you |
| price | `update_product`, `update_plan`, `update_subscription`, `create_subscription_plan`, … | You decide each one |
| bill | `create_invoice`, `send_invoice`, `create_subscription`, … | 20 a day, then you |
| other | `create_order`, `pay_order`, `create_shipment_tracking`, `send_invoice_reminder`, … | Pass |

A tool the guard doesn't know yet (a newer toolkit) always asks you. The full list is in [actions.js](https://github.com/Fizzl13/x402-examples/blob/main/paypal-guard/src/actions.js).

And two of its own:

| Tool | |
|---|---|
| `paypal_guard_status` | Your limits, how much of today's is used, approvals waiting for you, the latest decisions from the log. With `approval_id`: what became of that approval. |
| `paypal_guard_check` | Dry run: what the guard would decide for a call, and why, without running it. |

## For apps that serve customers

In your own chat with Claude, you are the one giving the orders. A support bot is different: it acts for a customer, and a customer can claim anything ("I'm writing for my husband, here's his capture number"). There the guard also checks that a refund, cancellation or bill belongs to the customer the app is serving.

The app, not the model, tells the server who that is: in the tool call's `_meta`, which the model can't touch.

```js
await mcpClient.callTool({
  name: "create_refund",
  arguments: { capture_id: "2GG…" },
  _meta: { "fizzl.eu/customer": "alice@example.com", "fizzl.eu/request": "My mug arrived broken" },
});
```

PayPal knows the payer's email for PayPal checkout payments. Card payments have none; for those, use [fizzl-paypal-guard](https://github.com/Fizzl13/x402-examples/tree/main/paypal-guard) in your own code with its `customerOf` hook, as the [demo shop](https://github.com/Fizzl13/x402-examples/tree/main/paypal-guard/demo) does.

## Good to know

- **Test in the sandbox first.** With `PRODUCTION` the refunds are real.
- The day's counts are per machine. Two computers with the same PayPal app each have their own day.
- The guard reads payments at PayPal with the same REST app. It never moves money itself.
- Text inside PayPal data (invoice notes, dispute messages, item descriptions) is written by other people. The server tells the model to treat it as information, never as instructions. The guard doesn't count on the model listening.

## Development

```sh
npm ci
npm test                          # the MCP server with a pretend PayPal
PAYPAL_SANDBOX_CLIENT_ID=… PAYPAL_SANDBOX_SECRET=… node test/sandbox.mjs   # against the PayPal sandbox
```

GitHub Actions runs the sandbox check on every change ([paypal-sandbox.yml](https://github.com/Fizzl13/x402-examples/blob/main/.github/workflows/paypal-sandbox.yml)): two customers pay by card, then over MCP a $12 refund runs, a $300 refund waits for the owner and runs after Approve, and a second refund of a payment already refunded in full is stopped.

MIT · [Fizzl](https://fizzl.eu)
