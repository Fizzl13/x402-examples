# Crowding check: derivatives positioning + Ichimoku

A small open example of an agent combining two x402 services into one read:

| Step | Service | Endpoint | Price |
|---|---|---|---|
| 1 | [Edge Agents](https://pay.edge-agents.ai) | perp funding rates (Binance, Bybit, OKX, Hyperliquid, dYdX, Coinbase, Deribit) | $0.01 |
| 2 | Edge Agents | CFTC leveraged-fund positioning, CME (BTC or ETH, weekly) | $0.01 |
| 3 | [Ichimoku Signal](https://ichimoku-signal.fizzl.eu) | confluence on 4h and on 1d (two calls) | $0.30 |

Total: **$0.32 per run**, paid in USDC on Base with x402. No accounts, no API keys.

## The read

The crowd is set by funding: every live venue paying in the same direction, at or above 0.01% per 8 hours, with at least 2 venues live. Venues pay funding over different periods (Hyperliquid and dYdX hourly, OKX every 8h), so every rate is converted to 8 hours first: Edge Agents' `fundingRate8hPercent` when present, otherwise the raw rate scaled by `fundingIntervalHours`, otherwise by the venue's usual interval (marked with * in the output). A venue that is withheld is never estimated, and the read says how many venues answered (for example "7 of 7 venues"). Leveraged-fund positioning adds weight when it agrees, but never sets the crowd on its own: on CME, leveraged funds are often net short by structure (basis trades), so on its own that isn't a crowded bet.

The trend is the Ichimoku cloud on 4h and 1d: bearish when price is below the cloud on both, bullish when above on both, otherwise mixed.

| Crowd | Trend | Verdict |
|---|---|---|
| long | bearish | **caution**: longs leaning against a bearish trend |
| short | bullish | **squeeze_risk**: shorts leaning against a bullish trend |
| long / short | same direction | **crowded_trend**: trend intact, positioning stretched |
| none, or mixed trend | | **no_crowding_signal** |

Every input keeps its own timestamp in the output: funding is minutes old, positioning comes from the weekly CFTC report.

## Run it

```bash
git clone https://github.com/Fizzl13/x402-examples && cd x402-examples/crowding-check && npm install

# Show what each call costs, without paying:
node crowding-check.mjs BTC --dry-run

# Pay and read (a dedicated wallet with a few dollars of USDC on Base; no ETH needed):
EVM_PRIVATE_KEY=0x... node crowding-check.mjs BTC
EVM_PRIVATE_KEY=0x... node crowding-check.mjs ETH --json
```

Each payment is capped at $0.20. Keep the key in your environment, never in code.

Example output, from a real run on 28 September 2026 at 16:12 UTC (all seven funding venues live; the [payments on Basescan](https://basescan.org/tx/0x722480fe37023bb01bb7d25e4a22564c7443a50232e417a5b825fd3875f68e58)):

```
BTC: NO CROWDING SIGNAL
No clear crowding against the trend (price is below cloud on 4h, above cloud on 1d).

Funding     avg +0.0063% per 8h, 7 of 7 venues (binance +0.0061%, bybit +0.0047%, okx +0.0071%, hyperliquid +0.0100%, dydx -0.0005%, coinbase +0.0152%, deribit +0.0013%)  [as of 2026-09-28T16:12:35.100Z, next funding 2026-09-29T00:00:00.000Z]
Positioning leveraged funds net -46% of gross (long 4745, short 12698)  [weekly CFTC, report 2026-09-22]
Ichimoku    4h: below cloud, confluence bearish (4 of 6 indicators bearish)  [2026-09-28T16:12:35.435Z]
Ichimoku    1d: above cloud, confluence bullish (5 of 6 indicators bullish)  [2026-09-28T16:12:35.617Z]

Paid: positioning 0x88f42f67… · confluence_1d 0x35f0c253… · confluence_4h 0x93f46943… · funding 0x722480fe…
```

This is an example of combining two services, not trade advice.

## Tests

```bash
npm test   # offline: the read logic on sample responses, no network, no payments
```

## Run it on GitHub Actions

Fork or copy this repository, add a repository secret `EVM_PRIVATE_KEY` (a dedicated wallet with a few dollars of USDC on Base), then start **Actions → Live run (paid) → Run workflow**. The result, with the raw responses and the payment receipts, is saved as an artifact.
