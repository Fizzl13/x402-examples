# x402 examples

Small, open examples of AI agents combining paid APIs with [x402](https://x402.org): each call is paid per request in USDC, with no accounts or API keys.

| Example | What it does | Services | Cost per run |
|---|---|---|---|
| [crowding-check](crowding-check) | Perp funding + CFTC leveraged-fund positioning + the Ichimoku cloud on 4h and 1d, combined into a short read ("crowded long + below the cloud = caution") | [Edge Agents](https://pay.edge-agents.ai), [Ichimoku Signal](https://ichimoku-signal.onrender.com) | $0.22 |

Each example has a `--dry-run` that shows the prices without paying. Use a dedicated wallet with a few dollars of USDC, keep its key in your environment, and never commit it.

Check your own x402 endpoint for free with [x402 Doctor](https://x402-doctor.onrender.com).

These are examples of combining services, not trade advice.
