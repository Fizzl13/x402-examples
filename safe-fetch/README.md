# x402-safe-fetch

A `fetch` for AI agents that checks an unknown x402 endpoint before paying it.

A free endpoint is answered as is. For a paid one (HTTP 402), your agent first pays **$0.001** for an [x402 Doctor](https://x402-doctor.onrender.com) preflight and acts on it:

| Preflight | What `safeFetch` does |
|---|---|
| `go` | Pays the endpoint, never more than `maxUsd` |
| `caution` | `onCaution`: `"stop"` (default, throws), `"pay"`, or your own function (e.g. ask the user) |
| `no_go` | Throws `SafePayError`; the endpoint is not paid |

The preflight reads the endpoint's 402 challenge and checks, among others, the price against your budget and against what the service advertises, whether the option is payable on your network (USDC, a valid payout address, a Solana payout account that exists), HTTPS, and whether the endpoint is listed in the CDP Bazaar. A verdict is reused for 10 minutes; hosts you already trust skip it.

## Install

```sh
npm install x402-safe-fetch @x402/fetch @x402/evm viem
```

## Use

```js
import { createSafeFetch, SafePayError } from "x402-safe-fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY); // a dedicated wallet with a few dollars of USDC

const safeFetch = createSafeFetch({
  register: (client) => client.register("eip155:8453", new ExactEvmScheme(account)),
  maxUsd: 0.05,          // budget per endpoint call
  onCaution: "stop",     // or "pay", or async (preflight) => askUser(preflight.summary)
  trusted: ["api.my-own-service.com"],
});

try {
  const res = await safeFetch("https://ichimoku-signal.onrender.com/signal/BTC-USDT");
  console.log(await res.json());
} catch (err) {
  if (err instanceof SafePayError) console.log(err.code, err.message, err.preflight?.reasons);
  else throw err;
}
```

Solana works the same way: `network: "solana"` and register an `ExactSvmScheme` from `@x402/svm/exact/client` with a `@solana/kit` signer.

## Options

| Option | Default | |
|---|---|---|
| `register` | required | `(client) => client.register(network, scheme)`: your payment schemes; your keys stay in your code |
| `network` | `"base"` | `"base"`, `"solana"` or a CAIP-2 id; the preflight checks the option on this network |
| `maxUsd` | `0.05` | Budget per endpoint call; the payment is capped at it and the preflight says `no_go` above it |
| `onCaution` | `"stop"` | `"stop"`, `"pay"` or `async (preflight) => boolean` |
| `trusted` | `[]` | Hosts paid without a preflight |
| `onPreflight` | | `(preflight, { url, method, cached }) => void`, e.g. for logging |
| `cacheMs` | 10 minutes | How long a verdict is reused per method and URL |

The preflight itself is capped at $0.002 and paid with the same schemes. `receiptOf(response)` returns the payment receipt (transaction hash) of a paid response.

## Costs and limits

- $0.001 per preflight (once per endpoint per 10 minutes), plus the endpoint's own price.
- Bodies must be strings, Buffers or `URLSearchParams`: the request is sent once unpaid (to see the 402) and once paid.
- If Doctor is unreachable, nothing is paid (`SafePayError` with code `preflight_failed`).
- The preflight checks whether a payment can succeed and is sensible; it does not guarantee what the service delivers after payment.

Try it without code first: [safe-pay](../safe-pay) is a runnable script with the same logic. MIT licensed.
