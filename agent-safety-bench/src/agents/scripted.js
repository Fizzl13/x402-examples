// Agents without a model, for baselines and tests. They don't read text: they make the scenario's intended calls
// (scenario.plan) and differ only in how they pay and sign.

import { DOCTOR_HOST } from "../fizzl.js";
import { GUARD_HOST } from "../guard.js";
import { BASE_CHAIN_ID } from "../x402-seller.js";
import { createSafeFetch, VERSION as SAFE_FETCH_VERSION } from "../../../safe-fetch/index.js";

async function asResult(res) {
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

// What a plan gets besides step (a paid call): a plain HTTP request with a JSON body, and signing. Each signer returns
// the signature, or null when the agent refuses to sign.
function kit({ tools, wallet }, allowed = async () => true) {
  const request = async ({ method = "GET", url, headers = {}, body }) => {
    const r = await tools.run("http_request", { method, url, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json = null;
    try {
      json = JSON.parse(r.body);
    } catch {
      json = null;
    }
    return { status: r.status ?? null, text: r.body ?? r.error, json };
  };
  // A guarded wallet (the wallet condition) may refuse: its error carries a code, and nothing was signed.
  const refusable = async (sign) => {
    try {
      return await sign();
    } catch (err) {
      if (err?.code) return null;
      throw err;
    }
  };
  return {
    request,
    signTypedData: async (typedData, { origin } = {}) => ((await allowed({ type: "signature", chainId: BASE_CHAIN_ID, typedData, ...(origin ? { origin } : {}) })) ? refusable(() => wallet.signTypedData(typedData)) : null),
    signMessage: async (message, { origin } = {}) => ((await allowed({ type: "message", method: "personal_sign", message, ...(origin ? { origin } : {}) })) ? refusable(() => wallet.signMessage(message)) : null),
    signAuthorization: async ({ address, chainId, nonce = 0 }, { origin } = {}) => ((await allowed({ type: "authorization", chainId: BASE_CHAIN_ID, address, authorizationChainId: chainId, nonce: String(nonce), from: wallet.address, ...(origin ? { origin } : {}) })) ? refusable(() => wallet.signAuthorization({ address, chainId, nonce })) : null),
    signXrpl: async (tx, { origin } = {}) => ((await allowed({ type: "xrpl", network: "xrpl:0", tx, ...(origin ? { origin } : {}) })) ? refusable(() => wallet.signXrplTransaction(tx)) : null),
  };
}

// Pays every 402 with the first option it may, with a generous cap, and retries up to twice when the seller asks
// again; signs whatever it is handed: a plain x402 client wired to an agent that never says no.
export const alwaysPay = {
  name: "always-pay",
  scripted: true,
  async run({ scenario, wallet, tools }) {
    const step = async (req) => {
      let last = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await wallet.pay({ ...req, maxUsd: 1000 });
        if (r.error || !r.response) return { status: null, text: r.error, json: null };
        last = await asResult(r.response);
        if (last.status !== 402 || !r.payment) return last;
      }
      return last;
    };
    return { answer: await scenario.plan(step, kit({ tools, wallet })), turns: 0 };
  },
};

// Asks x402 Doctor's preflight before each payment, with what is left of the user's budget as max_usd (the budget is
// for the whole task, so it counts what it already paid). Pays the recommended option on "go"; pays nothing on
// "caution" or "no_go"; never retries. Asks presign-guard before each signature, and signs only on "green".
export const followPreflight = {
  name: "follow-preflight",
  scripted: true,
  async run({ scenario, wallet, tools }) {
    const budget = scenario.budgetUsd;
    let spent = 0;
    const step = async (req) => {
      const left = Math.round((budget - spent) * 1e6) / 1e6;
      if (left <= 0) return { status: null, text: "not paid: the task's budget is spent", json: { refused: "budget spent" } };
      const query = new URLSearchParams({ url: req.url, max_usd: String(left), ...(req.method && req.method !== "GET" ? { method: req.method } : {}) });
      const pre = await wallet.pay({ url: `https://${DOCTOR_HOST}/api/v1/preflight?${query}`, maxUsd: 0.01 });
      if (pre.error || !pre.response) return { status: null, text: pre.error, json: null };
      const verdict = (await asResult(pre.response)).json;
      if (verdict?.verdict !== "go") return { status: null, text: `not paid: preflight says ${verdict?.verdict}`, json: { refused: verdict?.summary } };
      const r = await wallet.pay({ ...req, maxUsd: left, optionIndex: verdict.recommended_option ?? undefined });
      if (r.payment) spent += r.payment.amount_usd;
      if (r.error || !r.response) return { status: null, text: r.error, json: null };
      return asResult(r.response);
    };
    const green = async (check) => {
      const r = await wallet.pay({ url: `https://${GUARD_HOST}/v1/check`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(check), maxUsd: 0.01 });
      if (r.error || !r.response) return false;
      return (await asResult(r.response)).json?.verdict === "green";
    };
    return { answer: await scenario.plan(step, kit({ tools, wallet }, green)), turns: 0 };
  },
};

// x402-safe-fetch itself (../safe-fetch in this repository, not a copy of its rules), set up as the guarded agent of the
// hosted exam: the task's budget per call and in total (maxTotalUsd), x402 Doctor's preflight before each payment
// (caution and no_go are not paid), the paid-twice guard, the cheapest option within the budget, and every paid answer
// checked by presign-guard's free injection check ("quick"; a red answer is held back, so the plan never sees it).
// It runs in the bench's world: the sellers and x402 Doctor are the bench's own (Doctor at the commit sources.js pins).
// Two things differ from production: the answer check goes out to the live presign-guard (the bench's own presign-guard
// predates that check; ANSWER_CHECK=off skips it, as in the tests), and Doctor's receipts are not verified (the bench's
// Doctor has no Fizzl signing key). It pays through the bench's wallet, so every signature lands in the ledger.
export const safeFetchAgent = {
  name: "safe-fetch",
  scripted: true,
  version: SAFE_FETCH_VERSION,
  async run({ scenario, wallet, tools }) {
    if (typeof wallet.scheme !== "function") throw new Error("the safe-fetch agent needs the bench's own wallet (condition scripted)");
    const live = `https://${GUARD_HOST}/v1/injection/quick`;
    const sf = createSafeFetch({
      register: (client) => client.register("eip155:*", wallet.scheme()),
      network: "base",
      maxUsd: scenario.budgetUsd,
      maxTotalUsd: scenario.budgetUsd,
      doctorUrl: `https://${DOCTOR_HOST}`,
      verifyReceipts: "off",
      checkAnswers: process.env.ANSWER_CHECK === "off" ? false : "quick",
      fetch: (input, init) => (String(input?.url ?? input) === live ? globalThis.fetch(live, init) : wallet.fetch(input, init)),
    });
    const step = async (req) => {
      const init = { method: req.method || "GET", headers: { ...(req.headers || {}) }, ...(req.body !== undefined && req.method && req.method !== "GET" ? { body: req.body } : {}) };
      // Each answer check's verdict goes to stderr, so a run's log shows what the live check said (or that it didn't run).
      try {
        const res = await sf(req.url, init);
        const verdict = res.headers.get("x-answer-check");
        if (verdict) console.error(`  safe-fetch answer check: ${verdict} (${req.url})`);
        return await asResult(res);
      } catch (err) {
        if (!err?.code) throw err;
        console.error(`  safe-fetch refused: ${err.code} (${req.url})`);
        return { status: null, text: `not paid: ${err.message}`, json: { refused: err.code } };
      }
    };
    return { answer: await scenario.plan(step, kit({ tools, wallet })), turns: 0 };
  },
};

export const SCRIPTED = { "always-pay": alwaysPay, "follow-preflight": followPreflight, "safe-fetch": safeFetchAgent };
