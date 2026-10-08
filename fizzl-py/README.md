# fizzl

Safety checks for Python AI agents that pay: LangChain, LangGraph, the OpenAI Agents SDK, CrewAI or your own loop.

An [official LangChain integration](https://docs.langchain.com/oss/python/integrations/tools): listed in the LangChain docs under tools.

For LangChain.js and LangGraph.js: [`fizzl-langchain`](https://www.npmjs.com/package/fizzl-langchain) on npm.

| Check | What the agent checks | Service | Price |
|---|---|---|---|
| `check_before_signing` | a transaction, token approval or signature **before signing it**: green / orange / red with reason codes (drainers, unlimited approvals to unknown spenders, look-alike tokens, Permit/Permit2/Seaport signatures that hand over tokens) | [presign-guard](https://presign-guard.fizzl.eu) | $0.01 |
| `check_xrpl_transaction` | an **XRP Ledger** transaction before signing it: account takeover (SetRegularKey, SignerListSet, master key off), AccountDelete, fake RLUSD (red); partial payments, destinations that refuse or need a tag, risky issuers, DEX orders far below the market (orange) | presign-guard | $0.01 |
| `check_token` | a token **before buying or accepting it**: honeypot, rug-pull signs, look-alikes (Solana, EVM, and XRPL tokens as `CURRENCY.rIssuer`) | presign-guard | $0.01 |
| `check_wallet_approvals` | every open approval of a wallet and which to revoke | presign-guard | $0.02 |
| `check_endpoint_before_paying` | an x402 or MPP paid API **before paying it**: go / caution / no_go, the cheapest option that settles, budget, track record, bait signs (fake brands, airdrop lures, output that doesn't match) | [x402 Doctor](https://x402-doctor.fizzl.eu) | $0.001 |

The checks only check. They never sign, pay or move anything themselves. A failed check comes back as
`{"error": ..., "message": ...}` instead of raising, so the agent can tell its user.

## Install

```sh
pip install "fizzl[x402]"              # with the x402 client, to pay per check
pip install "fizzl[langchain,x402]"    # plus LangChain tools
pip install "fizzl[openai-agents]"     # OpenAI Agents SDK tools (Python 3.10+)
```

## Use

```python
import requests
from eth_account import Account
from x402 import x402ClientSync
from x402.http.clients import wrapRequestsWithPayment
from x402.mechanisms.evm.exact import ExactEvmScheme
from fizzl import Fizzl

payer = x402ClientSync().register("eip155:8453", ExactEvmScheme(Account.from_key(AGENT_KEY)))  # USDC on Base
session = wrapRequestsWithPayment(requests.Session(), payer)

fizzl = Fizzl(session=session)
fizzl.check_endpoint_before_paying("https://api.example.com/funding", max_usd=0.05)
# {'verdict': 'go', 'summary': 'OK to pay: $0.02 on Base.', 'options': [...], 'reasons': [], ...}
fizzl.check_token("base", "0x...")
fizzl.check_before_signing(type="approval", chainId=8453, token="0x...", spender="0x...", amount="115792089237316195423570985008687907853269984665640564039457584007913129639935")
```

**Try it without a wallet:** `Fizzl()` with no paying session and no credit keys falls back to the free quick checks for `check_token`, `check_before_signing` and `check_endpoint_before_paying`: the verdict only, a few per hour, marked `"free": True` with a note on what the full check costs. `check_wallet_approvals` and `check_xrpl_transaction` have no free version. `Fizzl(free=False)` returns `payment_required` instead.

**Prepaid credits instead of a payment per check:** buy a pack once ([presign-guard](https://presign-guard.fizzl.eu/v1/credits): 100 checks for $0.80; [x402 Doctor](https://x402-doctor.fizzl.eu/api/v1/credits): 1000 preflights for $0.80), then use a plain session:

```python
fizzl = Fizzl(credit_keys={"presign": PRESIGN_CREDIT_KEY, "doctor": DOCTOR_CREDIT_KEY})
```

## LangChain / LangGraph

```python
from langgraph.prebuilt import create_react_agent
from fizzl.langchain import fizzl_tools

tools = fizzl_tools(session=session)          # or credit_keys={...}; only=[...] for some of them
agent = create_react_agent(model, tools + your_tools,
    prompt="Before you pay any API, call check_endpoint_before_paying. Before you sign anything, call check_before_signing. Never continue on red or no_go.")
```

The tools are plain `StructuredTool`s with typed arguments, so CrewAI and other frameworks that take LangChain tools can use them too.

## OpenAI Agents SDK

```python
from agents import Agent, Runner
from fizzl.openai_agents import fizzl_tools

agent = Agent(name="buyer", tools=fizzl_tools(session=session),   # or credit_keys={...}, or nothing for the free checks
    instructions="Before you pay any API, call check_endpoint_before_paying. Before you sign anything, call check_before_signing. Never continue on red or no_go.")
print(Runner.run_sync(agent, "Is https://api.example.com/funding safe to pay, at most $0.05?").final_output)
```

The checks run in a worker thread, so a blocking `requests` session doesn't stall the agent's event loop. Bad
arguments from the model come back as `{"error": "bad_input", ...}` without calling (or paying for) the check.

## Want the wallet to enforce it, not just inform the model?

Tools inform the model; a model can still ignore them. To make red and over-budget payments impossible, guard the
wallet itself: [presign-guard-wallet](https://www.npmjs.com/package/presign-guard-wallet) (Node) checks every
signature with presign-guard and your spending limits, with Telegram approval above them.

## License

MIT
