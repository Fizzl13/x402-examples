# x402 "exact" on Concordium: what this facilitator implements

The scheme is x402's own: [`specs/schemes/exact/scheme_exact_concordium.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_concordium.md)
in the x402 repository, which the official `@x402/concordium` package (client, server and facilitator) implements.
This is an independent facilitator for that scheme. The buyer signs a V1 **sponsored transaction** (Concordium
protocol 10, `@concordium/web-sdk` 12) that transfers CCD or a protocol-level token (PLT) to the seller. The
facilitator adds its signature as sponsor and pays the fee. The buyer needs no CCD for fees, and the facilitator never
holds the buyer's funds.

(The first drafts of this facilitator, 6 Nov 2026, were written without knowing the spec existed and used other field
names; they are still accepted, see below.)

## Networks

| Network | CAIP-2 |
|---|---|
| Mainnet | `ccd:9dd9ca4d19e9393877d2c44b70f89acb` |
| Testnet | `ccd:4221332d34e1694168c2a0c0b3fd0f27` |

## PaymentRequirements

```json
{
  "scheme": "exact",
  "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  "amount": "10000",
  "asset": "CCD",
  "payTo": "<seller's Concordium account>",
  "maxTimeoutSeconds": 120,
  "extra": { "feePayer": "<this facilitator's account, from GET /supported>" }
}
```

`asset` is `"CCD"` or a PLT's token id (e.g. `"EURR"`). `amount` is atomic (CCD: 6 decimals; a PLT: its own, read
from the chain). `extra.feePayer` names the sponsor; `/supported` lists it as `kinds[].extra.feePayer`.

## PaymentPayload

`{ "signedTransaction": { … } }`: the sender-signed V1 transaction as a JSON object (`Transaction.toJSON`, bigints as
numbers), the sponsor signature slot empty.

Also accepted, from this facilitator's first drafts: `extra.sponsor` instead of `extra.feePayer`, and
`payload.transaction` (the same transaction as a JSON string, `Transaction.toJSONString`) instead of
`payload.signedTransaction`.

## /verify

Everything the spec's verification rules require, which this facilitator checks as follows:

1. The transaction parses, is version 1 and names this facilitator's account as its only sponsor.
2. Its payload is exactly one plain transfer (CCD `Transfer`/`TransferWithMemo`, or a PLT `TokenUpdate` with one
   `transfer` operation) of exactly `amount` of `asset` to `payTo`, and nothing else.
3. The sender is neither `payTo` nor the sponsor, and its signature verifies against its on-chain credentials.
4. The nonce is the sender's next nonce; the expiry is in the future and at most `maxTimeoutSeconds` (+ 30 s) away.
5. The sender holds at least `amount` of `asset`.

Stricter than the spec (it allows that):

- **Energy**: the transaction's energy is no more than a transfer needs, so the sponsor never pays for more.
- **PLT state**: the token exists, isn't paused, and its allow/deny lists let this sender pay this recipient.
- **Seller allow-list** (`SELLERS`) and a **daily limit** (`DAILY_LIMIT`), so strangers can't spend the sponsor's
  CCD on fees by paying themselves.
- **One at a time**: the same transaction is never being settled twice at once; a second submission fails at the
  node anyway (its nonce is used).

## /settle

Verify again, sign as sponsor (`Transaction.sponsor`), submit, wait for finalization, and return
`{ success, transaction, network, payer }` only if the transfer succeeded on chain; a failed transfer is reported as
`transaction_failed`.

## /supported

`{ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "ccd:…", "extra": { "feePayer": "<account>" } }] }`
