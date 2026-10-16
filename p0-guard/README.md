# P0 guard: Project 0 builds, presign-guard checks, your wallet signs

[Project 0](https://ai.0.xyz) builds unsigned Solana transactions for AI agents, over MCP or REST: deposit, withdraw, borrow, repay, loop and close a position on its lending markets. Your agent's own wallet signs. This example puts an independent check in between. Every transaction goes to [presign-guard](https://presign-guard.fizzl.eu) first ($0.01, paid with x402 in USDC on Solana), which decodes it, simulates it and screens the accounts involved. Only on green does the wallet sign.

| Verdict | Agent action |
|---|---|
| green | **go**: sign and send (with `--send`) |
| orange | **ask** your user first |
| orange on a later step, only because an account it uses doesn't exist yet (`missingAccounts`) | **wait**: the step before it has to land first |
| red | **stop**: never sign |

What presign-guard looks for on Solana: a token account handed to someone else (SetAuthority), the wallet handed to a program (System Assign), unlimited token delegates, durable nonces, token accounts closed to another address, also when hidden inside other programs (the simulation shows them), and the accounts involved against the OFAC SDN list. The answer also says exactly what leaves the wallet.

## Run it

```bash
npm install

# Dry run: P0 builds the transactions, you see the steps and the price of a check. Nothing paid, signed or sent; no key needed.
node p0-guard.mjs deposit bank=2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB amount=1 --authority <wallet> --dry-run

# Check only: pays $0.01 for the first step's verdict. Nothing is signed.
SOLANA_SEED=... node p0-guard.mjs deposit bank=2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB amount=1

# Check, sign and send: each step is checked just before it is signed, after the one before has landed.
SOLANA_SEED=... node p0-guard.mjs deposit bank=2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB amount=1 --send

node p0-guard.mjs ... --json   # the whole report as JSON
```

The first argument is P0's action (`create-account`, `deposit`, `withdraw`, `borrow`, `repay`, `loop`, `close-position`), followed by its parameters as `name=value`, as in [P0's MCP guide](https://docs.0.xyz/guides/mcp-server). The `authority` is your wallet. `2s37…` is P0's USDC bank; `curl https://ai.0.xyz/v1/banks?symbol=USDC` lists the others.

`SOLANA_SEED` is a long random password (32+ characters, e.g. from a password manager): the wallet is derived from it, and `node p0-guard.mjs --address` prints its address. `SOLANA_PRIVATE_KEY` (the base58 key Phantom exports, or a JSON byte array) works too. The same wallet pays for the checks and signs P0's transactions, so it needs USDC for the checks and the action and a little SOL for network fees. The x402 facilitator pays the fee of the check itself.

A dry run of a first deposit, for example, gives:

```json
{
  "action": "deposit",
  "submit": "sequential",
  "intent": "deposit 1 USDC on Project 0 (lending)",
  "steps": ["Create marginfi account", "Deposit"],
  "check_price_usdc": 0.01,
  "nothing_paid": true
}
```

## Steps sent in order, and bundles

P0 often splits setup and action. A first deposit, for example, is one transaction that creates the account and one that deposits, with `submit: "sequential"`. The deposit can't be judged before the account exists, so each step is checked just before it is signed, after the one before has landed. Without `--send` only the first step is checked. Checked too early, a later step comes back orange with `missingAccounts`, and this script treats that as **wait**, not as a risk.

With `submit: "bundle"` P0 wants all transactions signed with one blockhash and sent together as one Jito bundle. This script checks every transaction but sends none: send bundles with your own Jito client. A later transaction's simulation can fail only because the earlier ones haven't run yet.

## Safety

- Nothing is signed or sent without `--send`, and nothing that isn't green.
- The wallet signs only transactions it is a signer of.
- At most $0.02 is paid per check (a check costs $0.01).
- The `intent` sent with each check ("deposit 1 USDC on Project 0") lets presign-guard flag a transaction that does something else than what the agent says.
- Use a dedicated wallet with only what the agent needs. Never commit its key.

## In your own agent

```js
for (const { base64 } of p0.transactions) {                       // P0's envelope, submit: "sequential"
  const res = await pay("https://presign-guard.fizzl.eu/v1/check", { // pay = an x402 fetch, USDC on Solana
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "solana", transaction: base64, from: wallet, intent: "deposit 1 USDC on Project 0" }),
  });
  const { verdict } = await res.json();
  if (verdict !== "green") throw new Error("not signing");
  await signSendAndConfirm(base64);                                  // then the next step
}
```

Run the tests with `npm test`: no network, nothing paid, nothing sent. These are examples of combining services, not financial advice.
