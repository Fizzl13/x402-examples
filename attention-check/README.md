# Attention check: coin attention + Ichimoku

A small open example of an agent combining two x402 services into one read:

| Step | Service | Endpoint | Price |
|---|---|---|---|
| 1 | [Voxight](https://www.voxight.online) | coin attention: mentions in 9 windows (5 minutes to 7 days), who is talking | $0.16 |
| 2 | [Ichimoku Signal](https://ichimoku-signal.fizzl.eu) | the Ichimoku cloud on 4h and on 1d (two calls) | $0.02 |

Total: **$0.18 per run**, paid in USDC on Base with x402. No accounts, no API keys. (Voxight also takes USDC on Solana; this example pays on Base.)

## The read

Is the talk about a coin running with the trend or against it? The talk is Voxight's 24h window (rising when
accelerating or building, fading when cooling or quiet; the last hour is shown too). The trend is the Ichimoku cloud
on 4h and 1d: bearish when price is below the cloud on both, bullish when above on both, otherwise mixed.

| Talk | Trend | Verdict |
|---|---|---|
| looks coordinated (Voxight's shill check) | any | **suspect_talk**: treat the attention as noise until it broadens |
| rising | bearish | **hype_against_trend**: attention rising into a downtrend |
| rising | bullish | **talk_confirms_trend** |
| fading | bullish | **quiet_uptrend**: the trend holds without the crowd |
| fading | bearish | **fading_both** |
| otherwise | | **no_clear_read** |

## Run it

```bash
git clone https://github.com/Fizzl13/x402-examples && cd x402-examples/attention-check && npm install

# Show what each call costs, without paying:
node attention-check.mjs SOL --dry-run

# Pay and read (a dedicated wallet with a dollar of USDC on Base; no ETH needed):
EVM_PRIVATE_KEY=0x... node attention-check.mjs SOL
EVM_PRIVATE_KEY=0x... node attention-check.mjs PEPE --json
```

Ichimoku is asked first, so a coin it can't read stops the run before the $0.16 call. Each payment is capped at
$0.20. Keep the key in your environment, never in code.

This is an example of combining two services, not trade advice.

## Tests

```bash
npm test
```
