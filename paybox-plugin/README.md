# Fizzl for PayBox

A [PayBox](https://www.moonpay.com/newsroom/moonpay-paybox) plugin (MoonPay's payment vault for agents in Claude and ChatGPT): check before your agent signs or pays, and buy the right API for a need.

| Tool | What it does | Price |
|---|---|---|
| `x402_trust_record` | The 30-day record of an x402 endpoint in Fizzl's Trust Index (payable days, latest verdict, whether others bought it and got an answer) | free |
| `pick_api` | The x402 API with the best delivery record for a need in plain words, with its price | free |
| `x402_preflight` | x402 Doctor's pre-payment check of an endpoint: go, caution or no_go with reasons | $0.001 |
| `check_transaction` | presign-guard's check of an EVM transaction before signing, simulated with the sender | $0.01 |
| `check_solana_transaction` | presign-guard's check of a Solana transaction before signing, decoded and simulated | $0.01 |
| `check_token` | presign-guard's token verdict (honeypot, impersonation, tax, authorities) | $0.01 |
| `screen_address` | presign-guard's OFAC sanctions screen of a wallet address | $0.01 |
| `buy_answer` | Fizzl Buy picks an API for the need, pays it from its own wallet, checks and returns the answer | $0.02 |

The free tools read Fizzl's public data. The paid tools return an x402 proposal: PayBox fetches the live 402, shows the price, and pays only after the user approves, in USDC on Base (default) or Solana. The plugin never signs, pays or holds a key.

## Build and check

Node.js 24 and pnpm 11.11.0 (the PayBox starter's toolchain, release 1.0.3):

```sh
pnpm install --frozen-lockfile
pnpm test               # type-check, two identical builds, PayBox's conformance check
node scripts/live.mjs   # every tool against the live services; each proposal's 402 checked unpaid
```

## Publish in PayBox

1. Sign in at [developer.paybox.sh](https://developer.paybox.sh) with your PayBox account (MoonPay verification may be asked first).
2. Upload `dist/plugin.mjs`.
3. Test & configure → network hosts: `x402-doctor.fizzl.eu`, `presign-guard.fizzl.eu`, `buy.fizzl.eu`. No secrets or variables.
4. Run the checks, then Submit Project. It appears under Unofficial plugins in your PayBox account until it is approved.

`src/paybox.ts` and `scripts/` (except `live.mjs`) are PayBox's starter files, unchanged.
