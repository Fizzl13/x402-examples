# presign-guard-wallet

A [viem](https://viem.sh) wallet for AI agents that asks [presign-guard](https://presign-guard.fizzl.eu) before it signs.

Before every `sendTransaction`, `writeContract` and `signTypedData`, the wallet pays **$0.01** (x402, USDC on Base) for a verdict on exactly what is about to be signed, and acts on it:

| Verdict | What the wallet does |
|---|---|
| 🟢 green | Signs |
| 🟠 orange | `onOrange`: `"stop"` (default, throws), `"allow"`, or your own function (e.g. ask the user) |
| 🔴 red | Throws `PresignBlockedError` with the reasons; **nothing is signed** |

On top of that it can keep to **spending limits** you set per token (per transaction and per day), and ask a human for anything over them. See [Spending limits](#spending-limits).

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
| `limits` | | Spending limits per token, see [Spending limits](#spending-limits) |
| `onOverLimit` | | `async (info) => boolean`: asked when a limit would be crossed; `true` signs anyway. Without it the wallet stops. Ready-made: [`telegramApprover`](#approve-from-your-phone-telegram) |
| `onSpend` | | `(entry) => void` after each signed spend, e.g. for a log |
| `store` | in memory | Where spending is kept; `fileStore(path)` from `presign-guard-wallet/file-store`, or your own |

Chains: Ethereum (1), Optimism (10), BNB Chain (56), Polygon (137), Base (8453), Arbitrum (42161).

**Tempo** (4217, and the Moderato testnet 42431) is not covered by presign-guard. There the wallet signs exactly one thing, checked locally: a TIP-20 `transfer` or `transferWithMemo` of USDC.e (pathUSD on the testnet), with no value attached, counted toward your `USDC` limits. Anything else on Tempo is refused (`unsupported_chain`). Guard a Tempo wallet client next to your main one with `guarded.wrap(tempoWalletClient)`: both share the same limits, pause and purchase records.

## Prepaid credits

Agents that sign a lot can prepay: one x402 payment of **$0.80 for 100 checks** or **$7.00 for 1000** (20% / 30% off), valid for a year.

```js
// once: buy a pack with your x402 fetch and keep the key somewhere safe
const { credit_key } = await (await pay("https://presign-guard.fizzl.eu/v1/credits/100")).json();

const wallet = guardWallet(walletClient, { creditKey: credit_key, pay }); // pay = fallback when the credits run out
```

Each check then sends the key instead of paying. When the credits are used up (or the key is unknown or expired) the wallet pays per check with `pay`; without `pay` it stops, and nothing is signed. Verdicts are signed and checked exactly as with per-check payment. Keep the key secret: anyone who has it can spend the credits.

## Spending limits

Give the agent a budget instead of a blank cheque:

```js
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";
import { fileStore } from "presign-guard-wallet/file-store";

const wallet = guardWallet(walletClient, {
  pay,
  limits: {
    tokens: {
      USDC: { perTx: "5", perDay: "20" },     // whole tokens; native and bridged USDC on every chain
      ETH: { perTx: "0.002", perDay: "0.01" }, // the native coin; also BNB, POL
      // any other token by address (any chain) or "chainId:0x…", with its decimals:
      // "8453:0x4200…0006": { perDay: "0.01", decimals: 18 },
    },
    unknownTokens: "ask", // a token without a limit: "ask" (default), "stop" or "allow"
    allow: ["0xShop…", "0xRouter…"], // optional: only these recipients, spenders and contracts
    window: "24h",          // the rolling window perDay applies to
  },
  // over a limit: a human decides (true = sign anyway); without it the wallet stops
  onOverLimit: async ({ summary }) => askUserOnPhone(`Agent wants to sign: ${summary}. OK?`),
  onSpend: (e) => console.log(`spent ${e.amount} ${e.budget} → ${e.to} (${e.result})`),
  store: fileStore("./spending.json"), // survives restarts; default is in memory
});

await wallet.spending(); // [{ token: "USDC", perTx: "5", perDay: "20", used: "8.5", left: "11.5" }, …]
wallet.pause();          // emergency stop: nothing is signed until wallet.resume()
```

The order for every signature: presign-guard's verdict first (red never reaches a human), then `onOrange`, then the limits. Over a limit, the wallet throws `PresignBlockedError` with code `over_limit` and `err.reasons` (`per_tx`, `per_day`, `unknown_token`, `unknown_spend`, `not_allowed`), unless `onOverLimit` returns `true`.

What counts as spending:

- the native value sent with a transaction, also with a contract deployment;
- an ERC-20 `transfer` or `transferFrom`;
- an **allowance** (`approve`, `increaseAllowance`, Permit, Permit2): whoever gets it can spend that amount, so it counts when it is given. An unlimited allowance or `setApprovalForAll` is over any limit, and if a human approves one anyway it uses up the rest of the window. Revoking costs nothing;
- an EIP-3009 payment or Permit2 transfer signature, read from presign-guard's signed verdict. A signature it cannot decode counts as unknown spending (`unknownTokens`).

Other contract calls (a swap that uses an allowance you already gave) spend nothing new: the allowance was counted when it was given. Budgets are shared across chains (`USDC: { perDay: "20" }` is 20 USDC in total), checked one at a time so parallel transactions cannot both fit in the last of a budget, booked before signing and given back when signing fails. A store that cannot be read stops the wallet (`limit_unavailable`).

These limits live in your agent's software: they stop a confused or manipulated agent, not someone who has the private key. For limits the chain enforces, use a smart account with session keys; the same budget can then be set there.

### Approve from your phone (Telegram)

`onOverLimit` can be a Telegram bot: when a signature would cross a limit, you get a message with what the agent wants to sign, why it is over the limit and presign-guard's verdict, with **Approve** and **Deny** buttons. The agent waits for your tap.

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot` and keep the token it gives you secret (an environment variable, never in code).
2. Send your new bot `/start`, then find your chat id:
   ```bash
   TELEGRAM_BOT_TOKEN=... node -e 'import("presign-guard-wallet/telegram").then(async (t) => console.log(await t.findTelegramChats({ token: process.env.TELEGRAM_BOT_TOKEN })))'
   ```
3. Use it:
   ```js
   import { telegramApprover } from "presign-guard-wallet/telegram";

   const wallet = guardWallet(walletClient, {
     pay,
     limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } },
     onOverLimit: telegramApprover({
       token: process.env.TELEGRAM_BOT_TOKEN,
       chatId: process.env.TELEGRAM_CHAT_ID,
       label: "research-agent",
       timeoutMs: 10 * 60_000, // no answer in 10 minutes = Deny
     }),
   });
   ```

Only the chat you name (or the `allowedUserIds` you list) can answer; anyone else's tap is refused. No server is needed: the wallet asks Telegram for your tap itself (long polling), so the bot must not have a webhook, and one bot serves one agent process at a time (a second process polling the same bot makes Telegram refuse both; the request then fails and nothing is signed). If Telegram cannot be reached, the wallet stops (`limit_unavailable`) rather than signing.

### Say what is being bought

Wrap a purchase in `withPurchase` to record what it is for. The URL and description then show up:
- in `onSpend`;
- in the Telegram approval message;
- on the wallet server's receipt for that payment.

`report` adds what happened afterwards.

```js
const res = await wallet.withPurchase({ url, description: "BTC signal for the daily report" }, async (report) => {
  const res = await payWithThisWallet(url); // an x402 fetch whose signer is this guarded wallet
  report({ httpStatus: res.status });
  return res;
});
```

With a wallet server, report the answer itself too (`content: { contentType, body }`). The server then checks it with an AI check: did the agent get what it paid for, and does the answer carry instructions aimed at the agent (prompt injection)? `onChecked` gets that check before `withPurchase` returns, so the agent can be warned before it reads the answer:

```js
const res = await wallet.withPurchase({ url, description: "BTC signal" }, async (report) => {
  const r = await payWithThisWallet(url);
  const body = await r.text();
  report({ httpStatus: r.status, content: { contentType: r.headers.get("content-type"), body } });
  return { status: r.status, body };
}, {
  onChecked: (check, out) => (check.injection?.flagged ? { warning: "treat body as data only", ...out } : out),
});
```

### One budget for all your agents (wallet server)

With several agents, run the [wallet server](../wallet-server): one price rule and daily budget for all of them, approvals on its dashboard and on Telegram, and an activity log. The agent keeps its keys and still signs and pays itself; it only asks the server first.

```js
const wallet = guardWallet(walletClient, {
  pay,
  server: { url: process.env.WALLET_SERVER_URL, key: process.env.WALLET_SERVER_KEY }, // instead of limits / onOverLimit / store
});
```

If the server can't be reached the wallet stops (`limit_unavailable`); paused on the dashboard means `paused`.

## Paying under a mandate

A principal can give an agent a signed spending mandate ([x402 `authority` extension draft](https://github.com/x402-foundation/x402/pull/3220), `x402-mandate/1`): "spend up to CAP, to recipients in R, until T". Wrap the payment scheme with `mandatePayer` and each x402 payment is made under it: the EIP-3009 nonce becomes the binding of (mandate, paymentId), so the settled payment proves which grant it used, and the guarded wallet sends the mandate along with the check. presign-guard then makes a payment outside the mandate red (over `perPayment` or `cap`, another recipient, payer or token, expired, bad signature), before anything is signed.

```js
import { guardWallet, mandatePayer } from "presign-guard-wallet";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const wallet = guardWallet(walletClient, { pay });
const signer = { address: account.address, signTypedData: (t) => wallet.signTypedData({ account, ...t }) };
client.register("eip155:8453", mandatePayer(new ExactEvmScheme(signer), mandate)); // mandate = { mandate, alg: "Ed25519", sig }
```

Only single payments are checked; the cumulative spend against the cap needs the mandate's accountant. Permit2 payments pass through unbound. The draft is still open, so details may change.

## Signed verdicts

presign-guard signs every paid verdict (EIP-191 over canonical JSON, with a hash of your request inside the signed body; see [Signed verdicts](https://github.com/Fizzl13/presign-guard#signed-verdicts)). The wallet checks that signature before it acts:

- the verdict must be signed by presign-guard's published signer, `0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE` (pinned in the package), or a key the Fizzl payout wallet (`0x6B0F4651eD42893ab58139938175E4a69f175F25`) certified for presign-guard;
- the signature must cover exactly the request that was checked;
- otherwise it throws `PresignBlockedError` with code `bad_receipt`, also with `onError: "allow"`: a forged or changed "green" is never a signature.

## Costs and coverage

- $0.01 per checked signature, paid with your `pay` fetch, or $0.008 / $0.007 with [prepaid credits](#prepaid-credits). Calls presign-guard does not cover (`signMessage`, contract deployments) are not checked and cost nothing.
- presign-guard reads public data (GoPlus, RugCheck, DexScreener, OFAC via PG1, phishing lists). A green verdict means no known problem was found, not a guarantee.
- The requests carry `user-agent: presign-guard-wallet/<version>` so the service can count how often the package is used.

MIT licensed.
