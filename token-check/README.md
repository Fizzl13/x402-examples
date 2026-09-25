# Token check: a verdict before an agent buys, holds or accepts a token

Before an agent swaps into a token, holds one, or accepts one as payment, it pays **$0.01** for a verdict from [presign-guard](https://presign-guard.onrender.com) and acts on it:

| Verdict | Grade | Agent action |
|---|---|---|
| green | SAFE | **go**: no known red flags |
| orange | CAUTION (one reason) or RISKY (two or more) | **ask** your user first |
| red | AVOID | **stop** |

The verdict comes with reason codes: mint or freeze authority still active, honeypot, tax or transfer fee, LP not locked, low liquidity, a token less than a day old, a few wallets holding most of the supply, marked rugged. It also includes a one-line summary and market data (price, liquidity, market cap, 24h volume, age). Solana, Base, Ethereum, Arbitrum, Optimism, Polygon and BSC are covered. Data comes from GoPlus, RugCheck and DexScreener.

Payment is x402 in USDC, **on Solana or Base**. On Solana the facilitator pays the network fee, so the wallet needs USDC only. No accounts, no API keys.

## Run it

```bash
npm install
node token-check.mjs solana DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --dry-run   # the price, pays nothing

SOLANA_PRIVATE_KEY=... node token-check.mjs solana <mint>                            # pay on Solana
EVM_PRIVATE_KEY=0x... node token-check.mjs base <token> --pay-on base                 # pay on Base
node token-check.mjs ... --json                                                       # full verdict + payment receipt
```

`SOLANA_PRIVATE_KEY` is the base58 secret key as Phantom exports it, or a Solana CLI keypair (a JSON array of 64 bytes). With both keys set, Solana is used unless you pass `--pay-on base`. The script refuses to pay more than $0.02 per call.

```
Bonk (solana): SAFE: no red flags, $421k liquidity, 3.8 years old
Agent action: GO (no known red flags)
Paid $0.01 on Solana from 7xKX…: https://solscan.io/tx/…
```

In your own agent, the whole check is one paid GET and one line of logic:

```js
const res = await payingFetch(`https://presign-guard.onrender.com/v1/token?chain=solana&address=${mint}`);
const { verdict, one_liner } = await res.json();
if (verdict === "red") throw new Error(`not buying: ${one_liner}`);
if (verdict === "orange") await askUser(one_liner);
```

MCP clients can use the same check as a tool: `token_verdict` ($0.01) or the free `token_quick_verdict` on `https://presign-guard.onrender.com/mcp`.

## Paid run from GitHub

The workflow **Token check (paid)** (Actions tab, run by hand) pays with the repository secret `SOLANA_PRIVATE_KEY` (or `EVM_PRIVATE_KEY` with `pay_on: base`), and prints the verdict and the transaction link.

Use a dedicated wallet with a few cents of USDC and never commit its key. Not financial advice: green means no known red flags, not that a token will hold its value.
