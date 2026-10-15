# privy-sanctions-sync

Keeps your **Privy condition sets** in step with the **OFAC SDN sanctions list**, for the policy in Privy's recipe [Sanctions screening for x402 payments](https://docs.privy.io/recipes/agent-integrations/x402-sanctions-screening). The recipe leaves out the fetching and batching; this script covers that part.

- **The list:** [presign-guard's free open copy](https://presign-guard.fizzl.eu/v1/sanctions) of the US Treasury's SDN digital currency addresses. It is re-checked against the Treasury every 6 hours and served as JSON (CORS-open).
- **EVM set:** every listed `0x` address, lowercase and EIP-55 checksummed.
  - The recipe's signing conditions compare case-insensitively.
  - The high-level `transfer` action compares exactly, so both forms are included.
- **Solana set:** every listed Solana address **plus its USDC and USDT token accounts**.
  - A Solana token transfer names the recipient's token account, not the recipient.
  - The recipe's `TransferChecked.destination` rule only matches those accounts.
  - The recipe asks you to derive them yourself; the list already carries them.
- **XRP Ledger set:** every listed classic r-address, for a `Payment.Destination` rule in [Privy's XRPL policies](https://docs.privy.io/controls/policies/example-policies/xrpl) (October 2026). Addresses are recognised by format and checksum, not by their label. The policy itself is [below](#x402-on-the-xrp-ledger).
- **Tron, Bitcoin and other addresses** are left out: Privy policies can't use them.

On the 14 October 2026 list that comes to 248 EVM values (124 addresses), 12 Solana values (4 owners and 8 token accounts) and 1 XRPL address.

## Safe on a schedule

- **Adds first, removes after.** The set never lacks an address that is still listed, so there is no window where a listed recipient gets through.
- **Leaves a set alone in two cases:**
  - The list was not checked against the Treasury for more than `MAX_AGE_HOURS` (default 72).
  - It would remove more than `MAX_REMOVE_SHARE` of the set (default 0.1).

  Either way the set keeps its last good contents and the run exits non-zero, so a scheduled job alerts you. This matches the recipe's "recommended" fail mode.
- **Never empties a set.**
- **Signs every write** with the owner's authorization key, using `@privy-io/node`'s own signing function.
- **Prints one JSON line per run** for your audit trail:

```json
{"at":"2026-10-14T10:00:00.000Z","source":"https://presign-guard.fizzl.eu/v1/sanctions","list":"OFAC SDN","published":"2026-10-13","checkedAt":"2026-10-14T09:00:22.810Z","sha256":"…","dryRun":false,"sets":{"evm":{"set":"qvah5m2hmp9abqlxdmfiht95","before":246,"added":2,"removed":0,"after":248},"solana":{"set":"…","before":12,"added":0,"removed":0,"after":12}}}
```

## Set up

1. **Create the owner, the two condition sets and the policies** as in steps 1, 2, 4 and 5 of [Privy's recipe](https://docs.privy.io/recipes/agent-integrations/x402-sanctions-screening). The condition sets can start empty.
2. **Copy this folder into your own repository and read `sync.mjs`.** It is about 170 lines. Running your own reviewed copy is better than running someone else's code with your Privy secrets.
3. **See what it would load,** without credentials:

   ```sh
   npm ci
   node sync.mjs --print
   ```

4. **Do a dry run,** which reads your sets but writes nothing, then run it for real:

   ```sh
   DRY_RUN=1 node sync.mjs
   node sync.mjs
   ```

| Variable | |
| --- | --- |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Your Privy app. |
| `PRIVY_AUTHORIZATION_KEY` | The private key of the condition sets' owner: base64 PKCS8, with or without the `wallet-auth:` prefix. Not needed for `--print` or `DRY_RUN=1`. |
| `PRIVY_EVM_SET_ID`, `PRIVY_SOLANA_SET_ID`, `PRIVY_XRPL_SET_ID` | The condition sets to keep in step. Set only the ones you use. |
| `EVM_CASING` | `both` (default), `lower` or `checksum`. |
| `MAX_AGE_HOURS`, `MAX_REMOVE_SHARE`, `FORCE=1` | The safety limits above. `FORCE=1` allows a large removal once. |
| `SANCTIONS_URL` | Another list in the same format, for example your own mirror. |

### Every six hours with GitHub Actions

Add `PRIVY_APP_SECRET` and `PRIVY_AUTHORIZATION_KEY` as repository secrets, and the rest as variables:

```yaml
name: privy-sanctions-sync
on:
  schedule: [{ cron: "17 */6 * * *" }]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  sync:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: privy-sanctions-sync
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm ci
      - run: node sync.mjs
        env:
          PRIVY_APP_ID: ${{ vars.PRIVY_APP_ID }}
          PRIVY_APP_SECRET: ${{ secrets.PRIVY_APP_SECRET }}
          PRIVY_AUTHORIZATION_KEY: ${{ secrets.PRIVY_AUTHORIZATION_KEY }}
          PRIVY_EVM_SET_ID: ${{ vars.PRIVY_EVM_SET_ID }}
          PRIVY_SOLANA_SET_ID: ${{ vars.PRIVY_SOLANA_SET_ID }}
          PRIVY_XRPL_SET_ID: ${{ vars.PRIVY_XRPL_SET_ID }}
```

A failed run means a set was left as it was: the list was stale, unusually small, or the change was unusually large. GitHub e-mails you about it.

## x402 on the XRP Ledger

Privy signs XRPL transactions with `xrpl_signTransaction`, and its policies can read the payment's fields. For an agent that pays x402 sellers in RLUSD, this policy:
- never pays a listed address;
- pays only RLUSD from Ripple's issuer, at most 1 RLUSD a payment;
- allows a trust line to that issuer only;
- refuses everything else.

```json
{
  "version": "1.0",
  "name": "x402 on the XRP Ledger: RLUSD only, capped, never to a sanctioned address",
  "chain_type": "xrpl",
  "rules": [
    {
      "name": "Never pay a sanctioned address",
      "method": "xrpl_signTransaction",
      "conditions": [
        { "field_source": "xrpl_transaction", "field": "Payment.Destination", "operator": "in_condition_set", "value": "<PRIVY_XRPL_SET_ID>" }
      ],
      "action": "DENY"
    },
    {
      "name": "RLUSD from Ripple's issuer, at most 1 per payment",
      "method": "xrpl_signTransaction",
      "conditions": [
        { "field_source": "xrpl_transaction", "field": "TransactionType", "operator": "eq", "value": "Payment" },
        { "field_source": "xrpl_transaction", "field": "Payment.Amount.currency", "operator": "eq", "value": "524C555344000000000000000000000000000000" },
        { "field_source": "xrpl_transaction", "field": "Payment.Amount.issuer", "operator": "eq", "value": "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
        { "field_source": "xrpl_transaction", "field": "Payment.Amount.value", "operator": "lte", "value": "1" }
      ],
      "action": "ALLOW"
    },
    {
      "name": "Hold RLUSD: a trust line to Ripple's issuer only",
      "method": "xrpl_signTransaction",
      "conditions": [
        { "field_source": "xrpl_transaction", "field": "TransactionType", "operator": "eq", "value": "TrustSet" },
        { "field_source": "xrpl_transaction", "field": "TrustSet.LimitAmount.currency", "operator": "eq", "value": "524C555344000000000000000000000000000000" },
        { "field_source": "xrpl_transaction", "field": "TrustSet.LimitAmount.issuer", "operator": "eq", "value": "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" }
      ],
      "action": "ALLOW"
    }
  ]
}
```

- **The currency code:** on the ledger, RLUSD is the 40-character hex code `524C5553…`, not the letters "RLUSD", because codes longer than three letters are written in hex. x402 offers for RLUSD on `xrpl:0` carry the same code as their `asset`.
- **Refused by default:** Privy's policy engine refuses what no rule allows, as Privy's own XRPL example relies on. That covers XRP payments, offers, other tokens and `raw_sign`.
- **Keep `raw_sign` refused:** a `raw_sign` request has no decoded transaction, so rules for it can only use system conditions.
- **Deny next to allow:** the DENY rule sits next to the ALLOW rule, the same way Privy's own XRPL denylist example does it.
- **What the set can't do:** it holds classic r-addresses only, and can't match destination tags.
- **The cap:** set `Payment.Amount.value` to what one call may cost your agent.
- **Before paying:** [x402 Doctor's preflight](https://x402-doctor.fizzl.eu) also checks the seller's XRPL side. It sees whether the payout account exists, has the RLUSD trust line and accepts the payment (DepositAuth, RequireDestTag).

## Limitations

- **The same as the recipe's:** a denylist catches direct payments to listed addresses only, not indirect exposure. It is not a compliance program.
- **Token accounts:** only the *associated* USDC and USDT token accounts (SPL Token program) are derived. A listed owner can hold other token accounts.
- **No Privy account in the tests:** they run against a stand-in for the condition-set API that verifies each write's authorization signature with the owner's public key (`npm test`). Before relying on it, test it on a non-production Privy app as the recipe's step 8 describes.

## Also from Fizzl

- [`presign-guard-payer-screen`](../payer-screen): the same list for sellers. It turns away x402 payments *from* listed addresses.
- [x402 Doctor's preflight](https://x402-doctor.fizzl.eu): checks, before an agent pays, whether an x402 seller works, has a track record, and isn't on the list ($0.001).

MIT licensed.
