# Crowding check: derivatives positioning + Ichimoku

A small open example of an agent combining two x402 services into one read:

| Step | Service | Endpoint | Price |
|---|---|---|---|
| 1 | [Edge Agents](https://pay.edge-agents.ai) | perp funding rates (Binance, Bybit, OKX) | $0.01 |
| 2 | Edge Agents | CFTC leveraged-fund positioning, CME (BTC or ETH, weekly) | $0.01 |
| 3 | [Ichimoku Signal](https://ichimoku-signal.onrender.com) | confluence on 4h and on 1d (two calls) | $0.20 |

Total: **$0.22 per run**, paid in USDC on Base with x402. No accounts, no API keys.

## The read

The crowd is set by funding: every live venue paying in the same direction, at or above 0.01% per 8 hours, with at least 2 venues live. Venues pay funding over different periods (Hyperliquid and dYdX hourly, OKX every 8h), so every rate is converted to 8 hours first: Edge Agents' `fundingRate8hPercent` when present, otherwise the raw rate scaled by `fundingIntervalHours`, otherwise by the venue's usual interval (marked with * in the output). A venue that is withheld is never estimated, and the read says how many venues answered (for example "2 of 3 venues"). Leveraged-fund positioning adds weight when it agrees, but never sets the crowd on its own: on CME, leveraged funds are often net short by structure (basis trades), so on its own that isn't a crowded bet.

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

Each payment is capped at $0.10. Keep the key in your environment, never in code.

Example output (shape):

```
BTC: CAUTION
Crowded long (funding positive across venues (2 of 3 venues), leveraged funds heavily net long) while price is below cloud on 4h, below cloud on 1d: longs are leaning against a bearish trend.

Funding     avg +0.0135% per 8h, 2 of 3 venues (binance +0.0120%, bybit +0.0150%); withheld: okx  [live, next funding …]
Positioning leveraged funds net 43% of gross (long …, short …)  [weekly CFTC, report …]
Ichimoku    4h: below cloud, confluence bearish (1 of 6 indicators bullish)  [2026-…]
Ichimoku    1d: below cloud, confluence bearish (2 of 6 indicators bullish)  [2026-…]
```

This is an example of combining two services, not trade advice.

## Tests

```bash
npm test   # offline: the read logic on sample responses, no network, no payments
```

## Run it on GitHub Actions

Fork or copy this repository, add a repository secret `EVM_PRIVATE_KEY` (a dedicated wallet with a few dollars of USDC on Base), then start **Actions → Live run (paid) → Run workflow**. The result, with the raw responses and the payment receipts, is saved as an artifact.
