# Concordium x402 facilitator (testnet first)

An x402 facilitator for Concordium. A buyer signs a transfer of CCD or a protocol-level token (PLT, e.g. EURR or USDR)
to the seller and names this facilitator as **sponsor**; the facilitator checks it, adds its signature as sponsor,
pays the fee and submits it. The buyer needs no CCD for fees, and the facilitator never holds anyone's funds.
It uses Concordium's sponsored transactions (account transaction v1, protocol 10) through `@concordium/web-sdk` 12.

The scheme is written up in [SPEC.md](SPEC.md).

## Routes

| Route | What |
|---|---|
| `GET /supported` | `{ kinds: [{ x402Version: 2, scheme: "exact", network, extra: { sponsor } }] }` |
| `POST /verify` | x402 v2 body `{ paymentPayload, paymentRequirements }` → `{ isValid, payer }` or `{ isValid: false, invalidReason, invalidMessage }` |
| `POST /settle` | same body → `{ success, transaction, network, payer }` once the transfer is final on chain |
| `GET /health` | `{ ok, network, sponsor }` |

What `/verify` checks: one plain transfer of exactly `amount` of `asset` to `payTo`; this facilitator as sole sponsor;
the buyer's signature against its on-chain keys; the buyer's next nonce; an expiry within `maxTimeoutSeconds`; no
more energy than the transfer needs (so the sponsor never pays for more); the balance; for a PLT, that it isn't paused
and the allow/deny lists let it through. `/settle` checks the same again, then sponsors and submits; a transaction is
never submitted twice (its nonce is used), and a failed transfer on chain is reported as failed.

Limits against abuse of the sponsor's CCD: `SELLERS` (only these payTo accounts are sponsored) and `DAILY_LIMIT`.

## Run

```sh
npm ci --ignore-scripts
npm test          # offline, against a stand-in node
SPONSOR_ADDRESS=… SPONSOR_KEY=… npm start
```

| Variable | |
|---|---|
| `SPONSOR_ADDRESS` | the facilitator's Concordium account (testnet) |
| `SPONSOR_KEY` | its Ed25519 signing key, 64 hex characters: set it in Render, never in the repo |
| `CONCORDIUM_NETWORK` | `ccd:4221332d34e1694168c2a0c0b3fd0f27` (testnet, default) |
| `CONCORDIUM_NODE` / `CONCORDIUM_PORT` | gRPC node, default `grpc.testnet.concordium.com:20000` |
| `SELLERS` | comma-separated payTo accounts it sponsors (empty: any) |
| `DAILY_LIMIT` | settlements a day (default 500) |

## Buyer side

```js
import { buildPayment } from './src/scheme.js';
const payload = await buildPayment({ requirements, sender, nonce, signer }); // signer: buildBasicAccountSigner(key)
// PAYMENT-SIGNATURE: base64 of { x402Version: 2, accepted: requirements, payload }
```

## Status

Built and tested against a stand-in node (`npm test`). Not yet run against the live testnet: that needs the
facilitator's own testnet account (with test CCD from the faucet) and a deploy.
