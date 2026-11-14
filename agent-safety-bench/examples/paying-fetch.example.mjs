// A paying fetch for bin/exam-agent.js --fetch: the exam's tasks are paid through this, so whatever your client does
// before it signs (budgets, allowlists, checks) is what the exam tests. This one is the plain official x402 client
// with no checks at all: copy it, and put your own client, guard or budget layer where it says so.
//
//   ANTHROPIC_API_KEY=... node bin/exam-agent.js --model claude-haiku-5-5 \
//     --fetch examples/paying-fetch.example.mjs --name "My agent + plain x402 client"
//
// You get, once per task:
//   account     a viem account for a fresh, empty throwaway key (Base Sepolia test money; the exam never settles)
//   privateKey  the same key as hex, for clients that want the key itself
//   network     "eip155:84532" (Base Sepolia), the network the exam's sellers ask for
//   task        the task text (what the user asked for)
//   budgetUsd   the task's budget in USD, for all of the task's payments together
// Return a fetch: (url, init, { option }) => Promise<Response>. Pay the 402 yourself; to refuse, throw an Error (set
// error.code to a short reason, e.g. "over_budget"): the model is told it was not paid, and why.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";

export default function createPayingFetch({ account, network, budgetUsd }) {
  // Your client goes here. The official client, as plain as it comes: no cap of its own (spendControls off).
  const x402 = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network, client: new ExactEvmScheme(account) }], spendControls: false }));

  return async function payingFetch(url, init = {}) {
    const first = await fetch(url, init);
    if (first.status !== 402) return first;
    const required = x402.getPaymentRequiredResponse((name) => first.headers.get(name));
    const option = required.accepts.find((o) => o.network === network);
    if (!option) throw Object.assign(new Error(`no option on ${network}`), { code: "no_option" });
    // A budget layer would check here. This example only refuses a single payment above the whole task budget.
    const usd = Number(option.amount ?? option.maxAmountRequired ?? 0) / 1e6;
    if (usd > budgetUsd) throw Object.assign(new Error(`$${usd} is more than the task's budget of $${budgetUsd}`), { code: "over_budget" });
    const payload = await x402.createPaymentPayload({ ...required, accepts: [option] });
    return fetch(url, { ...init, headers: { ...(init.headers || {}), ...x402.encodePaymentSignatureHeader(payload) } });
  };
}
