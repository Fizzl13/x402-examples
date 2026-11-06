# x402 "exact" on Concordium (draft, testnet first)

Status: draft by Fizzl, 6 Nov 2026. No x402 scheme or facilitator for Concordium existed at the time of writing.
This describes the `exact` scheme on Concordium with **sponsored transactions** (account transaction format v1,
Concordium protocol 10, `@concordium/web-sdk` 12): the buyer signs a transfer, the facilitator adds its signature
as sponsor and pays the fee. The buyer needs no CCD for fees, and the facilitator never holds the buyer's funds.

## Network

CAIP-2: `ccd:` + the first 32 hex characters of the genesis block hash.

| Network | id |
|---|---|
| Mainnet | `ccd:9dd9ca4d19e9393877d2c44b70f89acb` |
| Testnet | `ccd:4221332d34e1694168c2a0c0b3fd0f27` |

## PaymentRequirements (in `accepts[]`)

```json
{
  "scheme": "exact",
  "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  "amount": "10000",
  "asset": "CCD",
  "payTo": "<seller's Concordium account address>",
  "maxTimeoutSeconds": 120,
  "extra": { "sponsor": "<facilitator's Concordium account address>", "decimals": 6 }
}
```

- `asset`: `"CCD"`, or the token id of a protocol-level token (PLT).
- `amount`: an integer string in the asset's smallest unit (CCD: 6 decimals, so `"10000"` is 0.01 CCD; a PLT: its own
  decimals, also given as `extra.decimals`).
- `payTo`: a Concordium account address (base58check, 50 characters).
- `extra.sponsor`: the account that will sponsor (and so sign and pay the fee for) the transaction. The facilitator's
  `/supported` lists it; the resource server copies it in.

## PaymentPayload

```json
{ "x402Version": 2, "accepted": { "...": "the requirements above" }, "payload": { "transaction": "<signed sponsorable transaction, Transaction.toJSONString>" } }
```

The client builds an account transaction (v1) with:

- sender: the buyer's account; nonce: the buyer's next account nonce; expiry: at most `maxTimeoutSeconds` from now;
- sponsor: `extra.sponsor`, one signature;
- payload, one of:
  - CCD: `Transfer` (or `TransferWithMemo`) to `payTo` for `amount`;
  - PLT: `TokenUpdate` for token `asset` with exactly one `transfer` operation to `payTo` for `amount`;
- energy: what `Transaction.getEnergyCost` gives for that payload.

It signs as the sender (`Transaction.sign`) and sends the result as JSON (`Transaction.toJSONString`).

## Facilitator: /verify

Reject unless all hold:

1. The transaction parses (`signableFromJSON`), is version 1 and names this facilitator's account as sponsor.
2. Its payload pays exactly `amount` of `asset` to `payTo`, and nothing else (one transfer, no other operations).
3. The sender is not `payTo` or the sponsor; the sender's signature verifies against its on-chain credentials
   (`verifySignature`).
4. The nonce is the sender's next nonce; the expiry is in the future and at most `maxTimeoutSeconds` (+ 30 s) away;
   the energy is no more than the cost of that payload.
5. The sender holds at least `amount` of `asset` (and, for a PLT, is allowed to send it: not paused, allow/deny lists).

## Facilitator: /settle

Verify again, sign as sponsor (`Transaction.sponsor`), submit (`sendTransaction`), wait for finalization, and return
the transaction hash only if the transfer succeeded. A second submission of the same transaction fails at the node
(the nonce is used), so a payment can't be settled twice.

## Facilitator: /supported

`{ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "ccd:…", "extra": { "sponsor": "<account>" } }] }`
