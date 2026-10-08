# x402-safe-fetch

A `fetch` for AI agents that checks an unknown x402 endpoint before paying it.

A free endpoint is answered as is. For a paid one (HTTP 402), your agent first pays **$0.001** for an [x402 Doctor](https://x402-doctor.fizzl.eu) preflight and acts on it:

| Preflight | What `safeFetch` does |
|---|---|
| `go` | Pays the endpoint, never more than `maxUsd` |
| `caution` | `onCaution`: `"stop"` (default, throws), `"pay"`, or your own function (e.g. ask the user) |
| `no_go` | Throws `SafePayError`; the endpoint is not paid |

The preflight reads the endpoint's 402 challenge and checks, among others, the price against your budget and against what the service advertises, whether the option is payable on your network (USDC, a valid payout address, a Solana payout account that exists, an Algorand payout opted in to USDC), HTTPS, and whether the endpoint is listed in the CDP Bazaar. A verdict is reused for 10 minutes; hosts you already trust skip it.

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
  const res = await safeFetch("https://ichimoku-signal.fizzl.eu/signal/BTC-USDT");
  console.log(await res.json());
} catch (err) {
  if (err instanceof SafePayError) console.log(err.code, err.message, err.preflight?.reasons);
  else throw err;
}
```

Solana works the same way: `network: "solana"` and register an `ExactSvmScheme` from `@x402/svm/exact/client` with a `@solana/kit` signer.

Algorand and the XRP Ledger work the same way, and only their dollar stablecoin is ever paid. On Algorand that is USDC (ASA 31566704), never ALGO or another ASA. On the XRP Ledger it is RLUSD from Ripple's issuer, never XRP or a look-alike token. RLUSD prices are decimal dollars, so the budget is checked in dollars. The Doctor preflight is paid on the same network.

```js
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";

const safeFetch = createSafeFetch({
  network: "algorand", // your account must be opted in to USDC
  register: (client) => client.register("algorand:*", new ExactAvmScheme(toClientAvmSigner(process.env.AVM_PRIVATE_KEY))),
});
// XRP Ledger: network: "xrpl" and an ExactXrplScheme from @x402/xrpl/exact/client
// (createXrplWalletSigner(Wallet.fromSeed(process.env.XRPL_SEED))); needs an RLUSD trust line.
```

## Options

| Option | Default | |
|---|---|---|
| `register` | required | `(client) => client.register(network, scheme)`: your payment schemes; your keys stay in your code |
| `network` | `"base"` | `"base"`, `"solana"`, `"algorand"` (USDC), `"xrpl"` (RLUSD), their `-testnet` forms, or a CAIP-2 id; the preflight checks the option on this network |
| `maxUsd` | `0.05` | Budget per endpoint call; the payment is capped at it and the preflight says `no_go` above it |
| `onCaution` | `"stop"` | `"stop"`, `"pay"` or `async (preflight) => boolean` |
| `trusted` | `[]` | Hosts paid without a preflight |
| `onPreflight` | | `(preflight, { url, method, cached }) => void`, e.g. for logging |
| `cacheMs` | 10 minutes | How long a verdict is reused per method and URL |
| `verifyReceipts` | `"require"` | Check Doctor's signed receipt on every preflight; `"off"` skips it |
| `doctorSigners` | Doctor's published signer | Accepted signer addresses (for a self-hosted Doctor) |
| `diagnoseOnFailure` | `false` | When a payment still fails, buy a $0.01 Doctor diagnosis of why (see below) |
| `shareOutcomes` | `false` | After paying, tell Doctor whether the payment worked, so its later preflights learn from it (see below) |
| `onDiagnosis` | | `(report, { url, method, status, error }) => void`, e.g. for logging or alerting |
| `authority` | the Fizzl payout wallet | Wallet whose certificates also make a signer trusted (key rotation); `null` accepts only `doctorSigners` |

The preflight itself is capped at $0.002 and paid with the same schemes. `receiptOf(response)` returns the payment receipt (transaction hash) of a paid response.

## When a payment still fails

Sometimes the preflight says `go` and the payment still fails: the endpoint answers 402 again, or paying throws (a facilitator that rejects it, a wrong network). With `diagnoseOnFailure: true`, safe-fetch then buys one **$0.01** [x402 Doctor diagnosis](https://github.com/Fizzl13/x402-doctor#paid-api-for-agents-x402) of that endpoint: every check of its payment flow, with what is wrong and how to fix it.

```js
import { createSafeFetch, diagnosisOf } from "x402-safe-fetch";

const safeFetch = createSafeFetch({ register, maxUsd: 0.05, diagnoseOnFailure: true });

const res = await safeFetch("https://api.example.com/paid");
if (res.status === 402) {
  const report = diagnosisOf(res); // { overall: "fail", checks: [{ id, status, message }, …] }
  console.log(report?.checks.filter((c) => c.status === "fail").map((c) => c.message));
}
// When paying throws, the error carries it: err.diagnosis
```

- One diagnosis per endpoint per `cacheMs`, capped at $0.02 and paid with the same schemes.
- Like the preflight, the diagnosis must carry Doctor's signed receipt for exactly this endpoint; an unsigned or forged one is dropped, never shown.
- A diagnosis that fails never changes the outcome: you get the original response or error.
- Off by default: nothing extra is paid unless you turn it on.

Doctor's requests carry `user-agent: x402-safe-fetch/<version>` so the service can count how often the package is used; nothing about your agent or wallet is sent beyond the payment itself.

## Helping the preflight learn

With `shareOutcomes: true`, safe-fetch tells x402 Doctor what happened after it paid an endpoint that a preflight approved: `paid_ok` (2xx), `paid_failed` (402 again: the payment was not accepted) or `paid_error` (another error). Doctor counts these reports per endpoint over 30 days, from every agent that shares them. When most payments to an endpoint failed, reported by at least three different wallets, later preflights for it answer `caution` (`payments_fail_after_preflight`), so the next agent does not pay into the same wall.

- What is sent: the outcome, the HTTP status, the signed preflight you already received and its query (endpoint, method, budget, network). No keys, no response content.
- A report only counts with a real, paid preflight for that endpoint, once per preflight, so reports cannot be made up for free.
- It is sent after the answer and never delays or changes it. Off by default.

## Signed verdicts

x402 Doctor signs every paid preflight (EIP-191 over canonical JSON, with the request inside the signed body; see [Signed verdicts](https://github.com/Fizzl13/x402-doctor#signed-verdicts)). safe-fetch checks that signature before it acts on a verdict:

- the answer must be signed by Doctor's published signer, `0xAaE66eF9Ee234397df33901568c8FBc36d43277d` (pinned in the package, not fetched from the server it vouches for);
- the signature must cover exactly this request: your endpoint, method, budget and network;
- otherwise it throws `SafePayError` with code `bad_receipt` and **the endpoint is not paid**. A tampered "go", a missing receipt or a verdict for another request never turns into a payment.

**Key rotation:** Doctor's signing key can change without a safe-fetch update. The Fizzl payout wallet (`0x6B0F4651eD42893ab58139938175E4a69f175F25`, the `payTo` of every payment) certifies each key, and the certificate travels inside the receipt (`receipt.cert`). safe-fetch accepts a key that is pinned *or* certified by that wallet for x402 Doctor, for signatures made on or after the certificate's date. Set `authority: null` to accept only `doctorSigners`.

`verifyReceipt(body, { signers, route, input })`, `recoverSigner`, `canonicalJson` and `inputHash` are exported, so you can check any signed Doctor or presign-guard answer yourself.

## Costs and limits

- $0.001 per preflight (once per endpoint per 10 minutes), plus the endpoint's own price.
- With `diagnoseOnFailure`: $0.01 per diagnosis, only when a payment fails (once per endpoint per 10 minutes).
- Bodies must be strings, Buffers or `URLSearchParams`: the request is sent once unpaid (to see the 402) and once paid.
- If Doctor is unreachable, nothing is paid (`SafePayError` with code `preflight_failed`).
- The preflight checks whether a payment can succeed and is sensible; it does not guarantee what the service delivers after payment.

Try it without code first: [safe-pay](../safe-pay) is a runnable script with the same logic. MIT licensed.
