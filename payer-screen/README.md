# presign-guard-payer-screen

Screen who pays your x402 API against the **OFAC SDN sanctions list**, before the payment settles.

One Express middleware, placed before your x402 payment middleware. It reads the payer from the payment header and looks the address up. A listed payer gets **451 Unavailable For Legal Reasons**, so the payment is never settled and the money never reaches you. Everyone else goes straight on.

- **Every x402 payment kind:**
  - EVM: EIP-3009 `transferWithAuthorization` and Permit2.
  - Solana, Algorand and the XRP Ledger.
- **No calls, no cost per payment:** the list is downloaded once and refreshed every 6 hours. It comes from [presign-guard's free open copy](https://presign-guard.fizzl.eu/v1/sanctions) of the US Treasury's SDN digital currency addresses. Each payment is screened in memory.
- **No dependencies.**

```sh
npm install presign-guard-payer-screen
```

```js
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { screenPayers } from "presign-guard-payer-screen";

const app = express();
app.use(screenPayers({
  onBlocked: (info) => console.warn("refused a payment from a sanctioned address", info),
}));
app.use(paymentMiddleware(routes, resourceServer)); // your existing x402 setup
```

A refused payment answers:

```json
{
  "error": "payer_sanctioned",
  "message": "This payment comes from an address on the OFAC SDN sanctions list; it was not accepted and nothing was charged.",
  "payer": "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66",
  "network": "xrpl:0",
  "kind": "xrpl",
  "list": "OFAC SDN",
  "entries": [{ "name": "CHATEX", "programs": ["CYBER2"] }],
  "published": "2026-10-09"
}
```

## Options

| Option | Default | |
|---|---|---|
| `failClosed` | `false` | While no list can be loaded, answer 503 instead of letting payments through. With the default, payments pass unscreened and you get one warning. |
| `onBlocked` | none | `(info, req) => …` for every refused payment: log it, alert someone. |
| `listUrl` | presign-guard's `/v1/sanctions` | Any URL that serves the same JSON. |
| `refreshMs` | 6 hours | How often to download the list again. A failed refresh keeps the last good list. |
| `list` | none | The list JSON itself, to skip the download (tests, air-gapped servers). |
| `screen` | a new one | Share one `createScreen()` between middlewares. |

## Other frameworks

`checkPayment(header, screen)` screens one header and returns `{ blocked, payer, network, kind, entries, published }`. If there is nothing to screen, it returns `{ blocked: false, unscreened }`. Answer 451 yourself in Hono, Next.js or a plain Node server:

```js
import { createScreen, checkPayment } from "presign-guard-payer-screen";
const screen = createScreen();

const r = await checkPayment(req.headers.get("payment-signature") ?? req.headers.get("x-payment"), screen);
if (r.blocked) return Response.json({ error: "payer_sanctioned", payer: r.payer }, { status: 451 });
```

`payerOf(header)` gives just the payer: `{ payer, network, kind }`.

## What it covers, and what it doesn't

**What it does:**
- An exact match of the payer against every digital currency address OFAC publishes in the SDN list.
- On EVM it matches the `from` of the authorization.
- On Solana it matches the transfer authority.
- On Algorand it matches the sender of the payment transaction.
- On the XRP Ledger it matches the `Account`.

**What it doesn't cover:**
- Addresses of sanctioned persons that OFAC has not published.
- Indirect exposure.
- Lists other than OFAC SDN.

This is a tool, not legal advice.

For a full verdict on one address, use [presign-guard](https://presign-guard.fizzl.eu) `GET /v1/screen` ($0.01). It adds theft, phishing and mixer reports for EVM addresses and a signed receipt.

## License

MIT
