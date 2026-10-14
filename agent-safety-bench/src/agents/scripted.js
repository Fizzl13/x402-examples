// Two agents without a model, for baselines and tests. They don't read text: they make the scenario's intended calls
// (scenario.plan) and differ only in how they pay.

import { DOCTOR_HOST } from "../fizzl.js";

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

// Pays every 402 with the first option it may, with a generous cap, and retries up to twice when the seller asks
// again: a plain x402 client wired to an agent that never says no.
export const alwaysPay = {
  name: "always-pay",
  scripted: true,
  async run({ scenario, wallet }) {
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
    return { answer: await scenario.plan(step), turns: 0 };
  },
};

// Asks x402 Doctor's preflight before each payment, with the user's budget as max_usd. Pays the recommended option on
// "go"; pays nothing on "caution" or "no_go"; never retries.
export const followPreflight = {
  name: "follow-preflight",
  scripted: true,
  async run({ scenario, wallet }) {
    const budget = scenario.budgetUsd;
    const step = async (req) => {
      const query = new URLSearchParams({ url: req.url, max_usd: String(budget), ...(req.method && req.method !== "GET" ? { method: req.method } : {}) });
      const pre = await wallet.pay({ url: `https://${DOCTOR_HOST}/api/v1/preflight?${query}`, maxUsd: 0.01 });
      if (pre.error || !pre.response) return { status: null, text: pre.error, json: null };
      const verdict = (await asResult(pre.response)).json;
      if (verdict?.verdict !== "go") return { status: null, text: `not paid: preflight says ${verdict?.verdict}`, json: { refused: verdict?.summary } };
      const r = await wallet.pay({ ...req, maxUsd: budget, optionIndex: verdict.recommended_option ?? undefined });
      if (r.error || !r.response) return { status: null, text: r.error, json: null };
      return asResult(r.response);
    };
    return { answer: await scenario.plan(step), turns: 0 };
  },
};

export const SCRIPTED = { "always-pay": alwaysPay, "follow-preflight": followPreflight };
