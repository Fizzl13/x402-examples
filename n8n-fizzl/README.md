# n8n-nodes-fizzl

An [n8n](https://n8n.io) community node that checks before money moves. Put it in front of the node that pays, signs
or buys. It sends every item to one of three outputs:

| Output | Verdicts | Meaning |
|---|---|---|
| **Go** | `go`, `green`, `SAFE` | the check passed |
| **Ask** | `caution`, `orange`, `ask` | route to an approval step: Slack, Telegram, a Wait node |
| **Stop** | `no_go`, `red`, `stop` | don't pay or sign; also any error or unknown verdict (fails closed) |

## Operations

- **Check Endpoint Before Paying** ([x402 Doctor](https://x402-doctor.fizzl.eu) preflight). Give it an x402 (or MPP)
  paid API URL and, optionally, your budget (Max USD), network and method. It returns:
  - `go`, `caution` or `no_go`;
  - the cheapest option that settles;
  - the seller's track record and bait signs.
- **Check Before Signing** ([presign-guard](https://presign-guard.fizzl.eu)). Give it an EVM transaction (`to`, `data`,
  `value`), a token approval (`token`, `spender`, `amount`) or EIP-712 typed data, on Base, Ethereum, Arbitrum,
  Optimism, Polygon, BNB Chain, Avalanche or Robinhood Chain. It returns `green`, `orange` or `red` with reason codes.
  Optional:
  - your wallet (`from`), to simulate the transaction;
  - one sentence of intent, to catch signing something else than you meant.
- **Check Token** (presign-guard). Before buying, holding or accepting a token, it looks for a honeypot, rug-pull
  signs and look-alikes of known tokens. Chains: Solana, EVM chains, XRP Ledger (`CURRENCY.rIssuer`) and Algorand
  (asset id).

The node only checks: it never signs, pays or moves anything.

## Free, or full with credits

Without credentials the node uses the free quick checks. You get the verdict only, a few per hour, and each result is
marked `"free": true`.

For the full check (reasons, details and, for orange or red, what to change), add **Fizzl API** credentials with
prepaid credit keys:

| Key | Used by | Buy at | Price |
|---|---|---|---|
| presign-guard credit key | Check Before Signing, Check Token | https://presign-guard.fizzl.eu/v1/credits | 100 checks for $0.80 |
| x402 Doctor credit key | Check Endpoint Before Paying | https://x402-doctor.fizzl.eu/api/v1/credits | 1000 preflights for $0.80 |

When a key is used up, the node falls back to the free check. If that gives no verdict either, the item fails
(or goes to Stop with *Continue On Fail*).

<a id="credentials"></a>**Credentials**: both keys are optional. The credential test asks
`GET /v1/credits` with the presign-guard key, or with the Doctor key when that is the only one set.

## Install

In n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-fizzl`. Self-hosted n8n only, until the node
is verified.

## Example: pay an x402 API only on go

1. **HTTP Request** (or your agent) finds the paid URL.
2. **Fizzl → Check Endpoint Before Paying**, with URL `{{$json.url}}` and Max USD `0.05`.
3. Go → the node that pays (your x402 client or wallet service).
4. Ask → a Slack or Telegram message with an approve button.
5. Stop → log it and go on without paying.

## As an AI agent tool

The node can be an AI Agent tool. As a tool it returns every result to the agent, `verdict` included, instead of
routing. Tell the agent in its system prompt never to pay or sign on `no_go` or `red`.

## Development

```bash
npm install
npm test        # builds with tsc, then offline tests with a fake n8n context
```

## License

MIT
