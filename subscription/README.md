# FizzlSubscription: automatic Pro payments

A small contract on Base that lets a customer pay for Fizzl wallet Pro automatically: **$5 in USDC every 30 days**, straight from their wallet to Fizzl.

## What it can and can't do

- **Fixed forever.** Token (USDC on Base), payee, price and period are set when it is deployed. There is no owner and no admin function, so nothing can be changed later.
- **The customer turns it on.** They approve the contract for a capped amount (the dashboard asks for 12 months, $60) and call `subscribe(startAt)`. If nothing has been paid yet, the first period is paid at once.
- **Anyone may call `charge(customer)`, but it only does one thing.** It moves `price` from that customer to the payee, and only when a period is due: at most once per 30 days. The wallet server's small "charger" wallet calls it each month. Its key can do nothing except trigger a charge that was due anyway, and the money never passes through it.
- **A charge that comes late** (more than 3 days after it was due) starts a new period from that moment, so nobody pays for time they didn't have.
- **The customer stops any time** with `cancel()`, or by setting their approval to 0. Time they already paid for is kept.

## Files

- `contracts/FizzlSubscription.sol`: the contract.
- `contracts/MockUSDC.sol`: a test token, never deployed.
- `build/FizzlSubscription.json`: ABI and bytecode (solc 0.8.26, optimizer 200 runs, evm cancun).
- `build/FizzlSubscription.input.json`: the standard-JSON input for verifying the contract on Basescan.
- `../wallet-server/src/subscription-artifact.json`: the copy the wallet server uses.

## Build and test

```sh
npm ci
npm run build     # compile; node build.mjs --check verifies the committed build
npm test          # the contract on an in-process EVM, and the wallet server's billing against it
```

The tests run the contract on `@ethereumjs/evm` with a mock USDC and a clock they control. They cover:
- charges: on time, early, twice, late (grace), cancel, re-subscribe;
- the approval as a hard cap, a token that returns false, and customers kept separate;
- the wallet server's monthly charge job, reminders and failure notices.

## Deploying (once, by the owner)

1. Log in to the wallet server as the owner. Under "Automatic payment", click **Deploy the contract**. Your wallet sends the deployment on Base, for a few cents of ETH, with the settings shown (USDC, $5, 30 days, your payout address).
2. In Render → Environment, add:
   - `SUBSCRIPTION_CONTRACT`: the deployed address;
   - `CHARGER_KEY`: the private key of a **new, separate** wallet with about $1 of ETH on Base for gas. Never your payout wallet.
3. Optional but recommended: verify the contract on Basescan ("Verify & Publish", Solidity standard-JSON input, compiler v0.8.26) with `build/FizzlSubscription.input.json` and these constructor arguments:
   - USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
   - the payout address;
   - `5000000`;
   - `2592000`.

   Customers can then read the code themselves.

To change the price later, deploy a new contract. Customers on the old one keep paying the old price until they move.
