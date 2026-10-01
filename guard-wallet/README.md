# presign-guard-wallet

A [viem](https://viem.sh) wallet for AI agents that asks [presign-guard](https://presign-guard.fizzl.eu) before it signs.

Before every `sendTransaction`, `writeContract` and `signTypedData`, the wallet pays **$0.01** (x402, USDC on Base) for a verdict on exactly what is about to be signed, and acts on it:

| Verdict | What the wallet does |
|---|---|
| 🟢 green | Signs |
| 🟠 orange | `onOrange`: `"stop"` (default, throws), `"allow"`, or your own function (e.g. ask the user) |
| 🔴 red | Throws `PresignBlockedError` with the reasons; **nothing is signed** |

presign-guard decodes approvals, `increaseAllowance`, `setApprovalForAll`, EIP-2612 and Permit2 permits, EIP-3009 transfer authorizations (what an x402 payment signs) and Seaport orders, and screens every spender, recipient and token: known drainers and phishing addresses, sanctions, unlimited approvals to a plain wallet, honeypot tokens, unverified or brand-new contracts, and, with `origin`, new or lookalike domains and phishing sites. See the [reason codes](https://github.com/Fizzl13/presign-guard#reason-codes).

## Install

```sh
npm install presign-guard-wallet viem @x402/fetch @x402/evm
```

## Use

```js
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";

const account = privateKeyToAccount(process.env.AGENT_KEY); // the agent's wallet
const walletClient = createWalletClient({ account, chain: base, transport: http() });

// Pays for the checks: a few dollars of USDC on Base, capped per payment.
const payer = new x402Client().setSpendControls({ maxAmountPerPayment: "$0.02" });
payer.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(process.env.PAYER_KEY)));
const pay = wrapFetchWithPayment(fetch, payer);

const wallet = guardWallet(walletClient, { pay, onOrange: "stop" });

try {
  await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
} catch (err) {
  if (err instanceof PresignBlockedError) console.log(err.code, err.message, err.verdict?.reasons);
  else throw err;
}
```

`wallet` is the same client: every other method (`getAddresses`, `signMessage`, `extend`, …) works as before, unchecked.

## Options

| Option | Default | |
|---|---|---|
| `pay` | required (optional with `creditKey`) | A fetch that pays x402 (`wrapFetchWithPayment`); cap it with spend controls |
| `creditKey` | | A presign-guard credit key (`pgc_…`): checks are paid from prepaid credits first, then with `pay`. See [Prepaid credits](#prepaid-credits) |
| `fetch` | `globalThis.fetch` | Plain fetch used for credit-paid checks |
| `onOrange` | `"stop"` | `"stop"`, `"allow"` or `async (verdict, { method, request }) => boolean` |
| `onError` | `"stop"` | When the check cannot be done (outage, a chain presign-guard does not cover): `"stop"` or `"allow"` |
| `origin` | | The site asking for the signature: its domain age and phishing lists are checked too |
| `onVerdict` | | `(verdict, { method, request, paidWith, creditsLeft }) => void`, e.g. for logging; `paidWith` is `"credits"` or `"x402"` |
| `verifyReceipts` | `"require"` | Check presign-guard's signed receipt on every verdict; `"off"` skips it |
| `signers` | presign-guard's published signer | Accepted signer addresses |
| `authority` | the Fizzl payout wallet | Wallet whose certificates also make a signer trusted (key rotation); `null` accepts only `signers` |

Chains: Ethereum (1), Optimism (10), BNB Chain (56), Polygon (137), Base (8453), Arbitrum (42161).

## Prepaid credits

Agents that sign a lot can prepay: one x402 payment of **$0.80 for 100 checks** or **$7.00 for 1000** (20% / 30% off), valid for a year.

```js
// once: buy a pack with your x402 fetch and keep the key somewhere safe
const { credit_key } = await (await pay("https://presign-guard.fizzl.eu/v1/credits/100")).json();

const wallet = guardWallet(walletClient, { creditKey: credit_key, pay }); // pay = fallback when the credits run out
```

Each check then sends the key instead of paying. When the credits are used up (or the key is unknown or expired) the wallet pays per check with `pay`; without `pay` it stops, and nothing is signed. Verdicts are signed and checked exactly as with per-check payment. Keep the key secret: anyone who has it can spend the credits.

## Signed verdicts

presign-guard signs every paid verdict (EIP-191 over canonical JSON, with a hash of your request inside the signed body; see [Signed verdicts](https://github.com/Fizzl13/presign-guard#signed-verdicts)). The wallet checks that signature before it acts:

- the verdict must be signed by presign-guard's published signer, `0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE` (pinned in the package), or a key the Fizzl payout wallet (`0x6B0F4651eD42893ab58139938175E4a69f175F25`) certified for presign-guard;
- the signature must cover exactly the request that was checked;
- otherwise it throws `PresignBlockedError` with code `bad_receipt`, also with `onError: "allow"`: a forged or changed "green" is never a signature.

## Costs and limits

- $0.01 per checked signature, paid with your `pay` fetch, or $0.008 / $0.007 with [prepaid credits](#prepaid-credits). Calls presign-guard does not cover (`signMessage`, contract deployments) are not checked and cost nothing.
- presign-guard reads public data (GoPlus, RugCheck, DexScreener, OFAC via PG1, phishing lists). A green verdict means no known problem was found, not a guarantee.
- The requests carry `user-agent: presign-guard-wallet/<version>` so the service can count how often the package is used.

MIT licensed.
