# presign-guard-wallet

A [viem](https://viem.sh) wallet for AI agents that asks [presign-guard](https://presign-guard.fizzl.eu) before it signs. Solana signers too: see [Solana](#solana-usdc).

Before every `sendTransaction`, `writeContract`, `signTypedData` and `signAuthorization` (EIP-7702), the wallet pays **$0.01** (x402, USDC on Base) for a verdict on exactly what is about to be signed, and acts on it:

| Verdict | What the wallet does |
|---|---|
| 🟢 green | Signs |
| 🟠 orange | `onOrange`: `"stop"` (default, throws), `"allow"`, or your own function (e.g. ask the user) |
| 🔴 red | Throws `PresignBlockedError` with the reasons; **nothing is signed** |

On top of that it can keep to **spending limits** you set per token (per transaction and per day), and ask a human for anything over them. See [Spending limits](#spending-limits).

presign-guard decodes approvals, `increaseAllowance`, `setApprovalForAll`, EIP-2612 and Permit2 permits, EIP-3009 transfer authorizations (what an x402 payment signs) and Seaport orders, and screens every spender, recipient and token: known drainers and phishing addresses, sanctions, unlimited approvals to a plain wallet, honeypot tokens, unverified or brand-new contracts, and, with `origin`, new or lookalike domains and phishing sites. See the [reason codes](https://github.com/Fizzl13/presign-guard#reason-codes).

Transactions are also **simulated**: the wallet sends its own address along (`from`), and presign-guard runs the transaction against the latest block to see what really leaves the wallet, also inside routers, multicalls and batches. An approval the call doesn't show (`HIDDEN_APPROVAL`), an NFT leaving the wallet (`SIMULATION_NFT_OUT`) or a transaction that would fail (`SIMULATION_FAILS`) is orange, so with the default `onOrange: "stop"` nothing is signed.

> **Just want an agent that pays within limits, with approvals on your phone?** The hosted [Fizzl Agent Wallet](https://wallet.fizzl.eu/?ref=readme) wraps this library in an MCP server for Claude, Cursor and other MCP clients: sign in, add an agent, copy its setup. No code needed.

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

`wallet` is the same client. `signMessage` is checked too, as a plain message: a sign-in message (Sign-In with Ethereum) for another site than `origin` is red, unreadable bytes are orange; it counts toward no limit (`checkMessages: false` turns this off).

viem's other ways to sign or send are checked the same way, so a library that uses them can't go around the wallet:

| Method | Checked as |
|---|---|
| `sendTransactionSync`, `signTransaction` | `sendTransaction` (a signed transaction is as good as sent: anyone can broadcast it) |
| `writeContractSync` | `writeContract` |
| `sendCalls`, `sendCallsSync` (EIP-5792 batches) | every call, as a transaction from the wallet; one red or stopped call stops the whole batch. Each call counts toward `perTx` on its own and all of them toward the day's limit, booked before anything is signed |
| `deployContract` | a deployment: not checked by presign-guard, but the value it sends counts toward the limits |

Every other method (`getAddresses`, `extend`, `sendRawTransaction` for a transaction that is already signed, …) works as before, unchecked.

## Options

| Option | Default | |
|---|---|---|
| `pay` | required (optional with `creditKey`) | A fetch that pays x402 (`wrapFetchWithPayment`); cap it with spend controls |
| `creditKey` | | A presign-guard credit key (`pgc_…`): checks are paid from prepaid credits first, then with `pay`. See [Prepaid credits](#prepaid-credits) |
| `fetch` | `globalThis.fetch` | Plain fetch used for credit-paid checks |
| `onOrange` | `"stop"` | `"stop"`, `"allow"` or `async (verdict, { method, request }) => boolean`. `"allow"` does not cover [EIP-7702 authorizations](#eip-7702-authorizations) |
| `onError` | `"stop"` | When the check cannot be done (outage, a chain presign-guard does not cover): `"stop"` or `"allow"`. An EIP-7702 authorization always stops |
| `origin` | | The site asking for the signature: its domain age and phishing lists are checked too |
| `onVerdict` | | `(verdict, { method, request, paidWith, creditsLeft }) => void`, e.g. for logging; `paidWith` is `"credits"` or `"x402"` |
| `verifyReceipts` | `"require"` | Check presign-guard's signed receipt on every verdict; `"off"` skips it |
| `checkMessages` | `true` | Check `signMessage` too ($0.01 per message, like any check); `false` signs messages unchecked |
| `signers` | presign-guard's published signer | Accepted signer addresses |
| `authority` | the Fizzl payout wallet | Wallet whose certificates also make a signer trusted (key rotation); `null` accepts only `signers` |
| `limits` | | Spending limits per token, see [Spending limits](#spending-limits) |
| `onOverLimit` | | `async (info) => boolean`: asked when a limit would be crossed; `true` signs anyway. Without it the wallet stops. Ready-made: [`telegramApprover`](#approve-from-your-phone-telegram), [`ac2Approver`](#approve-in-your-own-wallet-ac2) |
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
      ETH: { perTx: "0.002", perDay: "0.01" }, // the native coin; also BNB, POL, XRP, SOL
      // any other token by address (any chain) or "chainId:0x…", with its decimals:
      // "8453:0x4200…0006": { perDay: "0.01", decimals: 18 },
    },
    unknownTokens: "ask", // a token without a limit: "ask" (default), "stop" or "allow"
    allow: ["0xShop…", "0xRouter…"], // optional: only these recipients, spenders and contracts (0x, XRPL r… or Algorand addresses)
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
- an EIP-3009 payment or Permit2 transfer signature, read from presign-guard's signed verdict. A signature it cannot decode counts as unknown spending (`unknownTokens`);
- on Algorand with `algorandSigner(…, { any: true })`: ALGO paid and assets sent by the account's own transactions in the group (ALGO toward `ALGO`, USDC toward `USDC`, other assets as tokens without a limit). A close-out, rekey or clawback counts as unknown spending;
- on Solana with `solanaSigner(…, { any: true })`: what presign-guard's signed simulation shows leaving the wallet. SOL beyond the network fee counts toward `SOL`, USDC toward `USDC`, other tokens as tokens without a limit. A token delegate is over any limit, and a transaction without a complete simulation counts as unknown spending.

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

### Approve in your own wallet (AC2)

`onOverLimit` can also ask you in your own wallet app over [AC2](https://github.com/algorandfoundation/ac2), the Algorand Foundation's protocol for agents to ask their owner for a signature. When a signature would cross a limit, your AC2 wallet shows what the agent wants to sign, why it is over the limit and presign-guard's verdict. You approve with your passkey (Face ID, a fingerprint), and the wallet **signs** the approval with your Algorand account key. The agent checks that the signature is your account's before it goes on, and the signed approval comes with the spend in `onSpend` (`approval`), as proof of who approved what.

1. Install and start the AC2 service on the machine where the agent runs, and pair your wallet (AC2 Wallet on your phone): see [ac2-cli](https://github.com/algorandfoundation/ac2/tree/master/packages/ac2-cli), then `ac2 pair` and scan the code.
2. Use it:
   ```js
   import { ac2Approver } from "presign-guard-wallet/ac2";

   const wallet = guardWallet(walletClient, {
     pay,
     limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } },
     onOverLimit: ac2Approver({
       owner: process.env.OWNER_ALGORAND_ADDRESS, // only this account's signature approves
       label: "research-agent",
       timeoutMs: 10 * 60_000, // no answer in 10 minutes = Deny
     }),
     onSpend: (entry) => console.log(entry.amount, entry.approval?.signature ?? "within the limit"),
   });
   ```

What you sign is a text that starts with `fizzl-approval-v1` and names the agent, the amount, the network, the recipient, the URL, presign-guard's verdict, an id and an expiry time. It is never a transaction (Algorand signs transactions over `TX` + the transaction), so a signed approval can't be used as a payment. A decline, no answer in time, or a signature from another key counts as Deny. Without `owner`, the account the AC2 service is paired with is used, fixed at the first request. Each request first registers with the AC2 service as an agent: after a restart or a dropped link the service only waits for your wallet again once an agent is there, and the request then waits up to a minute (`connectTimeoutMs`) for your wallet to come back, so keep AC2 Wallet open. If the AC2 service isn't running or your wallet doesn't come back, the wallet stops (`limit_unavailable`) rather than signing. The agent still signs and pays with its own key, on any network; only the approval comes from your wallet. This module talks to the AC2 service over its local socket (`~/.ac2/ac2d.sock`, or `AC2_DAEMON_SOCKET`) and adds no packages.

`verifyApproval(owner, payload, signature)` checks a stored approval again later.

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

## EIP-7702 authorizations

An EIP-7702 authorization makes the wallet run a contract's code. That contract can then move everything the wallet holds, on every later call, without asking for another signature: this is how "sweeper" drainers empty wallets. So the wallet checks every authorization before it is signed (`signAuthorization`, type `authorization` in presign-guard), and is stricter about it than about anything else:

| Verdict | What the wallet does |
|---|---|
| 🟢 green | Signs: revoking a delegation (`0x000…000`), or a contract on GoPlus's trust list |
| 🟠 orange | Signs only when your `onOrange` **function** returns `true` (`"allow"` does not cover it): any other contract (`EIP7702_AUTHORIZATION`), one valid on every chain (`chainId: 0`), one deployed recently |
| 🔴 red | Never signs: no contract at the address, a contract that is itself a delegated wallet, an unverified, flagged or sanctioned contract |

A failed check stops too, also with `onError: "allow"`. The wallet signs exactly the chain id it checked, and an authorization counts toward no spending limit (it moves nothing by itself).

```js
const wallet = guardWallet(walletClient, {
  pay,
  onOrange: async (verdict, { method, request }) => method === "signAuthorization" ? askUser(request.address, verdict.reasons) : false,
});
const authorization = await wallet.signAuthorization({ contractAddress: smartAccount }); // the contract you chose to delegate to
await wallet.sendTransaction({ to: account.address, data, authorizationList: [authorization] });
```

Authorizations in a transaction's `authorizationList` are checked as well: one signed with `signAuthorization` was checked then and is not charged again, one the sending account signed some other way is checked now, and one signed by another account (or for another chain) puts nothing of this wallet at risk and is left alone. On Tempo the wallet signs and sends no authorizations.

## Checking x402 payments against what the seller asked

Wrap the x402 payment scheme with `x402Checked` and the payment requirements it pays (the `accepts` entry it chose) go along with the presign-guard check of its EIP-3009 signature. presign-guard then makes a signature that pays more than asked, someone else, another token or another chain red (`X402_AMOUNT_ABOVE_REQUIRED`, `X402_RECIPIENT_MISMATCH`, `X402_ASSET_MISMATCH`, `X402_NETWORK_MISMATCH`), and one that stays valid far longer than the seller's timeout orange (`X402_VALIDITY_TOO_LONG`), before anything is signed. It catches a hostile server or a broken client library.

```js
import { guardWallet, x402Checked } from "presign-guard-wallet";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const wallet = guardWallet(walletClient, { pay });
const signer = { address: account.address, signTypedData: (t) => wallet.signTypedData({ account, ...t }) };
client.register("eip155:8453", x402Checked(new ExactEvmScheme(signer)));
```

It combines with a mandate: `x402Checked(mandatePayer(scheme, mandate))`.

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

## XRP Ledger (RLUSD and XRP)

`xrplSigner` guards an XRPL signer the same way: before a `Payment` is signed it goes to presign-guard as `{ type: "xrpl", network, tx }` (destination, issuer of the token, flags), and red or orange stops it. Spending limits apply too: RLUSD from Ripple's issuer counts toward your `USDC` limit, drops toward `XRP`, any other token is unknown (`onUnknown`). The agent keeps its own XRPL key; anything but a `Payment` is refused, unless you pass `{ any: true }`.

**Other XRPL transactions.** With `xrplSigner(signer, { any: true })` the signer also signs other transactions from its own account: a trust line for RLUSD, a DEX order, an escrow, a `Batch`. Each goes to presign-guard first. presign-guard judges every transaction inside a Batch on its own, so a new regular key, signer list or account delete hidden next to a payment is red and never signed; a `DelegateSet` that lets another account send payments for you is red too. What the transaction can take out counts toward your limits: a `Payment` (SendMax or Amount), a check (SendMax), an escrow or payment channel (Amount), a DEX order (TakerGets), an AMM deposit, an NFT buy offer, and in a Batch this account's own inner transactions together (the other accounts' parts are their money). Trust lines, cancellations and other types that move nothing out add nothing; anything else (an `AccountDelete`, a `DelegateSet`, a `SetRegularKey`) counts as unknown spending and goes to `onOverLimit`.

```js
import { Wallet } from "xrpl";
import { createXrplWalletSigner } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/client";

const guarded = guardWallet(walletClient, { pay, limits: { tokens: { USDC: { perDay: "5" } } } });
const xrpl = guarded.xrplSigner(createXrplWalletSigner(Wallet.fromSeed(process.env.XRPL_SEED)), { network: "xrpl:0" });
client.register("xrpl:*", new ExactXrplScheme(xrpl)); // x402 payments in RLUSD, checked and within limits
```

`network` is `"xrpl:0"` (mainnet) or `"xrpl:1"` (testnet). The check itself is paid through `pay` (Base, Solana, XRPL or Algorand, whatever your x402 client can pay) or with credits.

## Algorand (USDC)

`algorandSigner` guards an Algorand signer for x402's AVM client (`@x402/avm`). In an x402 payment group the agent signs one transaction: its USDC transfer to the seller (the seller's facilitator signs and pays the fee transaction). The guarded signer signs only that: an asset transfer of USDC (ASA 31566704 on mainnet, 10458941 on testnet) from the agent's own address, with no close-out, rekey or clawback. It counts toward your `USDC` limit, and pause stops it. Anything else is refused with `unsupported_chain`. With an allow list (`limits.allow`), the seller must be on it: Algorand addresses are accepted there (with their checksum), and a receiver that isn't listed goes to `onOverLimit` (`not_allowed`), for x402 payments and for groups signed with `any`.

```js
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";

const guarded = guardWallet(walletClient, { pay, limits: { tokens: { USDC: { perDay: "5" } } } });
const algo = guarded.algorandSigner(toClientAvmSigner(process.env.AVM_PRIVATE_KEY), { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" });
client.register("algorand:*", new ExactAvmScheme(algo)); // x402 payments in USDC on Algorand, within limits
```

`network` is the mainnet id above (default) or `"algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="` (testnet). The account must be opted in to USDC. An x402 USDC payment is checked by the local rules above, without a presign-guard call.

**Other Algorand transactions.** With `{ any: true }` the signer also signs other transactions and atomic groups: payments in ALGO, asset transfers, app calls, for an agent that does more than pay x402 APIs. The whole group goes to presign-guard first (`type: "algorand"`): a rekey to another key, closing the account or an asset holding to someone else, or fake USDC is red and never signed; clawbacks, risky opt-ins, app update/delete/clear-state and a group that would fail are orange (`onOrange`). Only this account's own transactions in the group are signed. What they send counts toward your limits: ALGO toward an `ALGO` limit, USDC toward `USDC`, other assets as tokens without a limit; a close-out, rekey or clawback counts as unknown spending, so it goes to `onOverLimit`.

```js
const algo = guarded.algorandSigner(toClientAvmSigner(process.env.AVM_PRIVATE_KEY), { any: true });
// limits: { tokens: { USDC: { perDay: "5" }, ALGO: { perTx: "10", perDay: "25" } } }
```

## Solana (USDC)

`solanaSigner` guards a Solana signer for x402's SVM client (`@x402/svm`). An x402 payment on Solana is one transaction: compute-budget settings, one USDC `TransferChecked` from the agent's account to the seller, and a memo (the seller's facilitator pays the fee). The guarded signer signs only that shape, with USDC as the token and the agent as the transfer's authority. Before it signs, presign-guard checks the transaction (`type: "solana"`): it reads every instruction and simulates it, so a hidden owner change or delegate is caught. The payment counts toward your `USDC` limit, and pause stops it. Anything else is refused with `unsupported_chain` before any check is paid.

```js
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const guarded = guardWallet(walletClient, { pay, limits: { tokens: { USDC: { perDay: "5" } } } });
const keypair = await createKeyPairSignerFromBytes(getBase58Encoder().encode(process.env.SVM_PRIVATE_KEY));
const sol = guarded.solanaSigner(keypair); // mainnet; { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" } for devnet
client.register("solana:*", new ExactSvmScheme(sol)); // x402 payments in USDC on Solana, checked and within limits
```

The check itself is paid through `pay`, which can pay it in USDC on Solana too (or with credits).

**Other Solana transactions.** With `{ any: true }` the signer also signs transfers, swaps and other transactions, for an agent that does more than pay x402 APIs (an AgentKit Solana wallet, for example). Each one is checked by presign-guard first: every instruction is read and the transaction is simulated, so a token account handed to someone else is red, and a hidden owner or delegate change is orange. What the simulation shows leaving the wallet counts toward your limits: SOL beyond the network fee toward a `SOL` limit, USDC toward `USDC`. Without a complete simulation the spending counts as unknown, so it goes to `onOverLimit`.

```js
const sol = guarded.solanaSigner(keypair, { any: true });
// limits: { tokens: { USDC: { perDay: "5" }, SOL: { perTx: "0.1", perDay: "0.5" } } }
```

## MPP sessions on Tempo

`tempoSessionAccount(account)` gives a guarded viem account to pay MPP **sessions** (TIP-1034) with mppx's session client: the agent opens a payment channel once and pays each call with a signed voucher, no transaction per call.

```js
import { sessionManager } from "mppx/client";
const session = sessionManager({
  account: guarded.tempoSessionAccount(privateKeyToAccount(process.env.AGENT_KEY)), // { chainId: 42431 } for the testnet
  credentialContext: { depositRaw: "1000000" }, // each deposit: 1 USDC.e
  topUpAmount: "1",
});
const res = await session.fetch("https://presign-guard.fizzl.eu/v1/check", { method: "POST", body });
await session.close(); // the service settles what was used, the rest comes back
```

The account signs only a transaction with one call to Tempo's channel escrow that opens or tops up a channel in USDC.e for this account (nothing attached, the fee in USDC.e); that deposit counts toward your `USDC` limit, booked to the payee, when it is signed. Besides that it signs the channel's vouchers and close authorizations (EIP-712, the escrow's domain), which can only move money already deposited. Raw hashes, messages and anything else are refused, and `pause()` covers it. Unspent deposit comes back when the channel closes, but stays counted as spent in the current window.

## Signed verdicts

presign-guard signs every paid verdict (EIP-191 over canonical JSON, with a hash of your request inside the signed body; see [Signed verdicts](https://github.com/Fizzl13/presign-guard#signed-verdicts)). The wallet checks that signature before it acts:

- the verdict must be signed by presign-guard's published signer, `0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE` (pinned in the package), or a key the Fizzl payout wallet (`0x6B0F4651eD42893ab58139938175E4a69f175F25`) certified for presign-guard;
- the signature must cover exactly the request that was checked;
- otherwise it throws `PresignBlockedError` with code `bad_receipt`, also with `onError: "allow"`: a forged or changed "green" is never a signature.

## Costs and coverage

- $0.01 per checked signature (an EIP-7702 authorization is one), paid with your `pay` fetch, or $0.008 / $0.007 with [prepaid credits](#prepaid-credits). Calls presign-guard does not cover (contract deployments) are not checked and cost nothing; `signMessage` is checked unless `checkMessages: false`.
- presign-guard reads public data (GoPlus, RugCheck, DexScreener, OFAC via PG1, phishing lists). A green verdict means no known problem was found, not a guarantee.
- The requests carry `user-agent: presign-guard-wallet/<version>` so the service can count how often the package is used.

MIT licensed.
