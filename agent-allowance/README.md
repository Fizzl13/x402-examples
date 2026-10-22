# FizzlAgentAllowance: spending limits kept by the chain

An AI agent pays from its own wallet, so its private key has to be on the computer the agent runs on. The wallet software (presign-guard-wallet, the MCP server) keeps the agent within its limits, but a capable agent that can read files, or anyone who copies the key, could sign without that software. This small contract on Base puts the limit on the chain instead.

## How it works

- **The owner's USDC stays in the owner's own wallet.** The owner approves this contract once, for a capped amount.
- **Per agent wallet, the owner sets two numbers:** how much may go to it per period (say $20 a day), and how much it may hold at once (its float, say $5).
- **Anyone may call `topUp(owner, agent)`.** The only thing it can do is fill that agent's wallet back up to its float from that owner's wallet, and never more than what is left of the period's limit. The money only ever goes from that owner to that agent. The wallet server's small "charger" wallet calls it when an agent asks, so the agent needs no ETH for gas.
- **The worst case is bounded.** Whoever holds the agent's key can take what is in the agent's wallet (at most the float) plus the limit per period, and nothing more from the owner.
- **The owner stops it at any time**, with `stop(agent)` or by setting the approval to 0. What the agent already holds stays there.
- **No owner of the contract, no admin, nothing to change later.** The token (USDC on Base) is set when it is deployed.

Periods are fixed windows: a new one starts at the first top-up after the old one ended. At a period's edge, two periods' worth can go out within a short time. A change of limit keeps what was already sent in the current period, so changing it can't start a fresh one.

## Files

- `contracts/FizzlAgentAllowance.sol`: the contract.
- `contracts/MockUSDC.sol`: a test token, never deployed.
- `build/FizzlAgentAllowance.json`: ABI and bytecode (solc 0.8.26, optimizer 200 runs, evm cancun).
- `build/FizzlAgentAllowance.input.json`: the standard-JSON input, for verifying the contract on Basescan.
- `../wallet-server/src/allowance-artifact.json`: the copy the wallet server uses.

## Build and test

```sh
npm ci
npm run build     # compile; node build.mjs --check verifies the committed build
npm test          # the contract on an in-process EVM, and the wallet server's side against it
```

The tests run the contract on `@ethereumjs/evm` with a mock USDC and a clock they control. They cover:
- top-ups by anyone, to the float and no further, and the last one of a period cut to what is left;
- a leaked agent key: the thief gets the period's limit and then nothing until the next period;
- stop and turning back on, changes mid-period, the approval as a hard cap, a token that returns false;
- owners and agents kept apart;
- the wallet server's state, the transactions it builds for the owner, and top-ups paid by its charger.

## Deploying (once, by the owner of the wallet server)

1. Log in to the wallet server as the owner. On the **Stats** tab, open **On-chain limits contract** and click **Deploy the contract**. Your wallet sends the deployment on Base, for a few cents of ETH.
2. In Render → Environment, add `ALLOWANCE_CONTRACT` = the deployed address. Top-ups are sent by the same `CHARGER_KEY` wallet as the subscription charges (a separate wallet with a little ETH on Base).
3. Optional but recommended: verify the contract on Basescan ("Verify & Publish", Solidity standard-JSON input, compiler v0.8.26) with `build/FizzlAgentAllowance.input.json` and the USDC address on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) as the constructor argument.

After that, every customer sees **On-chain limit** on their agents in the dashboard.
