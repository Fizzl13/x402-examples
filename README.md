# x402 examples

Small, open examples of AI agents combining paid APIs with [x402](https://x402.org): each call is paid per request in USDC, with no accounts or API keys.

| Example | What it does | Services | Cost per run |
|---|---|---|---|
| [crowding-check](crowding-check) | Perp funding + CFTC leveraged-fund positioning + the Ichimoku cloud on 4h and 1d, combined into a short read ("crowded long + below the cloud = caution") | [Edge Agents](https://pay.edge-agents.ai), [Ichimoku Signal](https://ichimoku-signal.onrender.com) | $0.22 |
| [token-check](token-check) | Before buying, holding or accepting a token: a verdict (go / ask / stop) with reasons and market data, Solana and EVM tokens; pays on Solana or Base | [presign-guard](https://presign-guard.onrender.com) | $0.01 |
| [safe-pay](safe-pay) | Before paying an x402 endpoint it has never used, the agent pays $0.001 for a preflight and pays only on go, within a budget | [x402 Doctor](https://x402-doctor.onrender.com) + the endpoint | $0.001 + the endpoint |

Each example has a `--dry-run` that shows the prices without paying. Use a dedicated wallet with a little USDC, keep its key in your environment, and never commit it.

Check your own x402 endpoint for free with [x402 Doctor](https://x402-doctor.onrender.com).

These are examples of combining services, not trade advice.
