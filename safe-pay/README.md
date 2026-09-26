# Safe pay: a preflight before paying an unknown x402 endpoint

An agent that finds a paid endpoint (in the Bazaar, a catalogue, a link) doesn't know whether the payment will work, what it will really cost, or whether the payout address makes sense. So before paying, it pays **$0.001** for a preflight from [x402 Doctor](https://x402-doctor.onrender.com) and acts on it:

| Preflight | Agent action |
|---|---|
| `go` | **pay** the endpoint, on the option Doctor recommends, within the budget |
| `caution` | **ask** the user first (or pay anyway with `--accept-caution`) |
| `no_go` | **stop**: the payment would fail, is over budget, or shouldn't be made |

The preflight reads the endpoint's 402 challenge. It checks the price against your budget and against what the service advertises in its OpenAPI, and that the option can be paid on your network (USDC, a valid payout address, a Solana payout account that exists). It also checks HTTPS and whether the endpoint is listed in the CDP Bazaar. The answer is cached for 10 minutes, so an agent can call it before every unknown payment.

## Run it

```bash
npm install
node safe-pay.mjs https://ichimoku-signal.onrender.com/signal/BTC-USDT --dry-run         # both prices, pays nothing

EVM_PRIVATE_KEY=... node safe-pay.mjs https://ichimoku-signal.onrender.com/signal/BTC-USDT --max-usd 0.05
SOLANA_SEED=... node safe-pay.mjs "https://presign-guard.onrender.com/v1/token?chain=solana&address=<mint>" --pay-on solana
node safe-pay.mjs <url> --method POST --body '{"...": "..."}'                            # POST endpoints
node safe-pay.mjs <url> --json                                                           # everything as JSON
```

The script never pays more than $0.002 for the preflight or more than `--max-usd` (at most $1) for the endpoint.

```
Preflight (paid $0.001: https://basescan.org/tx/0x…): GO: OK to pay: $0.02 on Base.
Decision: PAY (OK to pay: $0.02 on Base.)
Endpoint: HTTP 200, paid: https://basescan.org/tx/0xab07f510e9f1bc3ed2dd27ba060d304b52e2e23e1beb0fabc4ceacde249d556a
{"pair":"BTC-USDT","interval":"1h","price":84031.86,"cloud_position":"below_cloud","tenkan_kijun_cross":"bearish_cross","signal":"bearish", …}
```

In your own agent, it's one extra paid GET before the real one:

```js
const pre = await (await payingFetch(`https://x402-doctor.onrender.com/api/v1/preflight?url=${encodeURIComponent(url)}&max_usd=0.05&network=eip155:8453`)).json();
if (pre.verdict === "no_go") throw new Error(pre.summary);
if (pre.verdict === "caution") await askUser(pre.summary);
const res = await payingFetch(url);
```

MCP clients can use the same check as the `x402_preflight` tool ($0.001) on `https://x402-doctor.onrender.com/mcp`.

## Paid run from GitHub

The workflow **Safe pay (paid)** (Actions tab, run by hand) takes the URL, method, budget and network. It pays with the repository secret `EVM_PRIVATE_KEY` (Base) or `SOLANA_SEED` / `SOLANA_PRIVATE_KEY` (Solana).

Use a dedicated wallet with a few cents of USDC and never commit its key.
