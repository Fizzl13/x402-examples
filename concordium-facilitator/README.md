# Concordium x402 facilitator (testnet first)

An independent facilitator for x402's [exact scheme on Concordium](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_concordium.md),
the scheme `@x402/concordium` clients use. A buyer signs a transfer of CCD or a protocol-level token (PLT, e.g. EURR)
to the seller and names this facilitator as fee payer (`extra.feePayer`, the transaction's sponsor); the facilitator
checks it, adds its signature as sponsor, pays the fee and submits it. The buyer needs no CCD for fees, and the
facilitator never holds anyone's funds. It uses Concordium's sponsored transactions (account transaction v1,
protocol 10) through `@concordium/web-sdk` 12.

[SPEC.md](SPEC.md) lists what it checks, including the checks it adds on top of the spec's.

## Routes

| Route | What |
|---|---|
| `GET /supported` | `{ kinds: [{ x402Version: 2, scheme: "exact", network, extra: { feePayer } }], extensions: ["concordium-identity", "concordium-buyer-proof"] }` (each off with `IDENTITY=off` / `BUYER_PROOF=off`) |
| `POST /verify` | x402 v2 body `{ paymentPayload, paymentRequirements }` → `{ isValid, payer }` or `{ isValid: false, invalidReason, invalidMessage }` |
| `POST /settle` | same body → `{ success, transaction, network, payer }` once the transfer is final on chain |
| `GET /health` | `{ ok, network, sponsor, settled_today, daily_limit, sponsored, sponsored_today, fees_ccd }` |
| `GET /identity` | `?url=<paid endpoint>&payTo=<account>`: what Concordium says about a seller (its identity credential; its agent in the Agent Registry) |
| `GET /demo/paid` | testnet: a demo x402 seller (paid at agent #993's wallet), settled by this facilitator in-process; `GET /.well-known/agent-card.json` is its card, pinned in the Agent Registry |
| `GET /demo/adult` | testnet: the same seller, adults only: its 402 asks for a buyer proof (`extra.buyerProof: ["adult"]`), and a payment without one is refused before anything is signed |
| `GET /schema/concordium-identity.json` | the JSON Schema of `extensions["concordium-identity"]` and of the /identity answer ([schema/concordium-identity.schema.json](schema/concordium-identity.schema.json)) |
| `GET /.well-known/concordium-proof.json` | testnet: the demo seller's zero-knowledge proof (18 or older, EU resident), made in its owner's wallet |
| `GET /payments` | the payments the sponsor account paid for, read from the chain (the wallet proxy's account history) |
| `GET /` | a page for people: what it is, its live state, and the 402 option a seller adds |

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
| `IDENTITY` | `report` (default): who the seller is rides along in /verify and /settle as `extensions["concordium-identity"]`; `agent`: sponsor only sellers paid at the wallet of a registered Concordium agent for that endpoint; `proof`: sponsor only sellers serving a verified zero-knowledge proof about the person behind their payTo (`/.well-known/concordium-proof.json`); `off` |
| `BUYER_PROOF` | `on` (default): sellers may ask who stands behind the paying account (`extra.buyerProof`), and payments are sponsored only with a verified buyer proof (`paymentPayload.extensions["concordium-buyer-proof"]`); `off` |
| `DEMO_PAY_TO` | testnet only: the demo seller's payTo (default agent #993's wallet), or `off` |
| `WALLET_PROXY` | wallet proxy for the payment history (default: Concordium's, per network) |

## Buyer side

```js
import { buildPayment } from './src/scheme.js';
const payload = await buildPayment({ requirements, sender, nonce, signer }); // { signedTransaction }; signer: buildBasicAccountSigner(key)
// PAYMENT-SIGNATURE: base64 of { x402Version: 2, accepted: requirements, payload }
// A seller that asks for a buyer proof (extra.buyerProof): add extensions: { "concordium-buyer-proof": <the proof file> },
// made once by the owner at https://x402-doctor.fizzl.eu/concordium-proof.html?role=buyer for the account the agent pays from.
```

## Status

Live on the Concordium testnet: https://concordium-facilitator.onrender.com (Render, free instance, so the first call
after a quiet spell takes up to a minute). Its first payment, 0.001 CCD with the buyer paying no fee, settled on
6 Nov 2026: [1b2edc98…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=1b2edc98d09914df0df49a96ff3371cdd6edbdf4c9390ce5d9e522b093254c98).
`.github/workflows/concordium-testnet.yml` checks it against the live testnet (read-only on every pull request; one
real testnet payment when started by hand with mode `pay`). PLT payments (e.g. EURR) are next.
