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

## Who is being paid (beyond the spec)

Concordium ties every account to an identity a regulated identity provider verified, and runs an Agent Registry
(CIS-8004) for AI agents. Before sponsoring, this facilitator reads both for the seller (src/identity.js):

- the payTo account's credential: its identity provider and `validTo` (expired is reported);
- when the paid endpoint (`paymentPayload.resource.url`) serves an Agent Card with a Concordium badge: the agent in the
  registry must be Active, its card at `agent_uri` must still hash to the `metadata_hash` on chain, the card must list
  this origin, and payTo must be the agent wallet it registered (the same rules as x402 Doctor's payee check).

The result is `extensions["concordium-identity"]` in the /verify and /settle answers: `verified-agent`,
`identity-backed`, `expired` or `not-read`, with the credential and the agent's own outcome. With `IDENTITY=agent` the
facilitator sponsors only `verified-agent` sellers (`seller_identity_not_verified` otherwise), before anything is
signed. `GET /identity?url=&payTo=` gives the same answer for a seller to check itself.

### A zero-knowledge proof about the person behind the payTo

A seller can also prove facts about the identity behind its payTo, without revealing them: an adult (18 or older),
an EU resident, an EU national, an identity document still valid. The owner makes the proof once in their own
Concordium wallet (x402 Doctor's page https://x402-doctor.fizzl.eu/concordium-proof.html), for the challenge
`sha256("concordium-x402-seller-proof:v1|<network>|<origin>|<payTo>")`, and serves the file at
`/.well-known/concordium-proof.json`. Before sponsoring, this facilitator (src/proof.js):

1. checks that the file is for this network, this site and this payTo, and that the presentation was made for that
   challenge (a copied proof fails on another site or payTo);
2. verifies the zero-knowledge proofs against the chain with its own node (`getPublicData` + `verifyPresentation`
   from `@concordium/web-sdk`), and that the credential is active;
3. checks that the credential that proved it is one of the payTo account's own credentials;
4. reads the facts from the verified statements only (what the file claims doesn't count).

The result is `proof: { status: "verified", facts, issuer, credential, created }` (or `status: "invalid"` with a
`reason`) in `extensions["concordium-identity"]`. With `IDENTITY=proof` the facilitator sponsors only sellers with a
verified proof. The demo seller serves one (adult, EU resident), made in its owner's wallet on 6 Nov 2026.

The extension's exact shape is a JSON Schema: [schema/concordium-identity.schema.json](schema/concordium-identity.schema.json),
also served at `GET /schema/concordium-identity.json`. `/supported` lists `"concordium-identity"` in `extensions` when
the check is on. Example, the demo seller (testnet agent #993):

```json
{
  "outcome": "verified-agent",
  "credential": { "provider": "Concordium testnet IP", "validTo": "2027-11", "expired": false, "revealed": null },
  "agent": { "tokenAddress": "JyP9Y8gHmf4U8QPMm1TkT", "tokenId": "993", "status": "Active",
             "agentWallet": "3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3", "outcome": "verified-wallet" }
}
```

The agent outcomes: `verified-wallet`, `owner-only` (no agent wallet set; payTo is the owner), `mismatch`, `revoked`,
`card-mismatch`, `endpoint-unlisted`, `other-network` (a badge from the other network's registry) and `not-read`; any
outcome but `verified-wallet` carries a `reason`.

## /settle

Verify again, sign as sponsor (`Transaction.sponsor`), submit, wait for finalization, and return
`{ success, transaction, network, payer }` only if the transfer succeeded on chain; a failed transfer is reported as
`transaction_failed`.

## /supported

`{ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "ccd:…", "extra": { "feePayer": "<account>" } }], "extensions": ["concordium-identity"], "signers": { "ccd:…": ["<account>"] } }`
