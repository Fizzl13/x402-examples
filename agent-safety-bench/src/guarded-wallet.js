// The wallet condition: the agent's wallet wrapped in presign-guard-wallet, Fizzl's guarded wallet for agents (from
// npm, at a pinned version). Before it signs anything (an x402 payment, a Permit, a message) it asks presign-guard,
// the simulated one at its real hostname, and signs only on green. Payments and allowances count toward a spending
// limit, here the task's budget. The agent gets the bare prompt: the wallet does this whether or not the agent thinks
// of it.
//
// Two differences from production, both about what the bench can offer:
// - presign-guard's verdicts here carry no signed receipt (the bench has no Fizzl signing key), so receipt
//   verification is off;
// - the checks are paid from the same wallet without counting toward the limit, as guard-wallet's `pay` does.

import { createWalletClient, custom } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { guardWallet, x402Checked } from "presign-guard-wallet";
import { createWallet } from "./wallet.js";
import { AGENT_KEY } from "./addresses.js";
import { CHECK_USD } from "./guard.js";

export function createGuardedWallet({ world, ledger, limitUsd }) {
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
  return createWallet({
    world,
    ledger,
    guard: {
      typedData: (params) => guarded.signTypedData({ account, ...params }),
      message: (text) => guarded.signMessage({ account, message: text }),
      scheme: x402Checked,
    },
  });
}
