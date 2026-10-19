// The wallet and skills-wallet conditions: the agent's wallet wrapped in presign-guard-wallet, Fizzl's guarded wallet
// for agents (from npm, at a pinned version). Before it signs anything (an x402 payment, a Permit, a message, an
// EIP-7702 authorization) it asks presign-guard, the simulated one at its real hostname, and signs only on green.
// Payments and allowances count toward a spending limit, here the task's budget. The wallet does this whether or not
// the agent thinks of it.
//
// Differences from production, all about what the bench can offer:
// - presign-guard's verdicts here carry no signed receipt (the bench has no Fizzl signing key), so receipt
//   verification is off;
// - the checks are paid from the same wallet without counting toward the limit, as guard-wallet's `pay` does;
// - so are the agent's own payments to the safety services (`direct`: Doctor's preflights, presign-guard's checks),
//   unchecked. The limit is the task's budget to the cent (a $5 plan, a $5 limit), so a $0.01 check counted in it
//   would make the wallet refuse the honest $5 Permit. A real user sets the limit with room for the checks.

import { createWalletClient, custom } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { guardWallet, x402Checked } from "presign-guard-wallet";
import { createWallet } from "./wallet.js";
import { AGENT_KEY } from "./addresses.js";
import { CHECK_USD } from "./guard.js";

export function createGuardedWallet({ world, ledger, limitUsd, direct = new Set() }) {
  // Pays presign-guard's checks: the plain wallet, like the x402 fetch guard-wallet is given.
  const payer = createWallet({ world, ledger });
  const pay = async (url, init = {}) => {
    const r = await payer.pay({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, maxUsd: CHECK_USD });
    if (!r.response) throw new Error(r.error);
    return r.response;
  };
  const account = privateKeyToAccount(AGENT_KEY);
  const client = createWalletClient({ account, chain: base, transport: custom({ request: async () => { throw new Error("no chain RPC in the bench"); } }) });
  const guarded = guardWallet(client, {
    pay,
    verifyReceipts: "off",
    limits: { tokens: { USDC: { perTx: String(limitUsd), perDay: String(limitUsd) } }, unknownTokens: "stop" },
  });
  const wallet = createWallet({
    world,
    ledger,
    guard: {
      typedData: (params) => guarded.signTypedData({ account, ...params }),
      message: (text) => guarded.signMessage({ account, message: text }),
      authorization: (params) => guarded.signAuthorization({ account, ...params }),
      scheme: x402Checked,
    },
  });
  return { ...wallet, pay: (req) => (direct.has(new URL(req.url).hostname) ? payer.pay(req) : wallet.pay(req)) };
}
