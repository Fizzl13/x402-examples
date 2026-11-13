// x402-safe-fetch in the bench's world: the scripted safe-fetch agent and the safe-fetch condition (a model whose
// pay_x402 tool pays through it) use the same setup, the guarded agent of the hosted exam. x402-safe-fetch comes from
// npm, at the version package.json pins; nothing of it is copied here.
//
// - the task's budget per call and in total (maxTotalUsd), the cheapest exact option within it;
// - the sites the task names (sites, 0.20.6): the harness passes the https URLs in the task, as an agent's harness that
//   knows the user's request would; with none in the task, any site;
// - x402 Doctor's preflight before each payment (caution and no_go are not paid): the bench's own Doctor;
// - the paid-twice guard;
// - presign-guard's free answer check on every paid answer ("quick"; a red answer is held back). It goes out to the
//   live presign-guard, because the bench's pinned presign-guard predates that check; ANSWER_CHECK=off skips it.
// Doctor's receipts are not verified: the bench's Doctor has no Fizzl signing key. It pays with the bench's wallet,
// so every signature lands in the ledger.

import { createSafeFetch, VERSION } from "x402-safe-fetch";
import { DOCTOR_HOST } from "./fizzl.js";
import { GUARD_HOST } from "./guard.js";
import { describe } from "./tools.js";

export const SAFE_FETCH_VERSION = VERSION;
const LIVE_CHECK = `https://${GUARD_HOST}/v1/injection/quick`;

// The sites in a task: its https URLs (none: undefined, any site).
export function sitesOfTask(task) {
  const urls = String(task || "").match(/https:\/\/[^\s)"'<>]+/g) || [];
  return urls.length ? urls.map((u) => u.replace(/[.,;:]+$/, "")) : undefined;
}

export function createBenchSafeFetch({ wallet, budgetUsd, task }) {
  if (typeof wallet.scheme !== "function") throw new Error("x402-safe-fetch needs the bench's own wallet, not the guarded one");
  return createSafeFetch({
    register: (client) => client.register("eip155:*", wallet.scheme()),
    network: "base",
    maxUsd: budgetUsd,
    maxTotalUsd: budgetUsd,
    sites: sitesOfTask(task),
    doctorUrl: `https://${DOCTOR_HOST}`,
    verifyReceipts: "off",
    checkAnswers: process.env.ANSWER_CHECK === "off" ? false : "quick",
    fetch: (input, init) => (String(input?.url ?? input) === LIVE_CHECK ? globalThis.fetch(LIVE_CHECK, init) : wallet.fetch(input, init)),
  });
}

// The safe-fetch condition: the same tools, except that pay_x402 pays through x402-safe-fetch. As in the hosted exam,
// safe-fetch picks the option and caps the payment at what is left of the task's budget, so the model's option_index
// and max_usd are not used. A refusal or a held-back answer comes back as the tool's error, in safe-fetch's words.
export function withSafeFetch(tools, { wallet, budgetUsd, task }) {
  const sf = createBenchSafeFetch({ wallet, budgetUsd, task });
  return {
    ...tools,
    async run(name, input = {}) {
      if (name !== "pay_x402") return tools.run(name, input);
      const method = String(input.method || "GET").toUpperCase();
      const init = { method, headers: { ...(input.headers || {}) }, ...(input.body !== undefined && method !== "GET" ? { body: input.body } : {}) };
      try {
        const res = await sf(input.url, init);
        const out = await describe(res);
        const check = res.headers.get("x-answer-check");
        return { ...out, payment: res.headers.get("payment-response") ? { paid: true } : { paid: false, reason: "the server did not ask for payment" }, ...(check ? { answer_check: check } : {}) };
      } catch (err) {
        if (!err?.code) return { error: err?.message || String(err) };
        return { error: err.message, code: err.code };
      }
    },
  };
}
