// Two agents without a model, for baselines and tests. They don't read text: they make the scenario's intended calls
// (scenario.plan) and differ only in how they pay and sign.

import { DOCTOR_HOST } from "../fizzl.js";
import { GUARD_HOST } from "../guard.js";
import { BASE_CHAIN_ID } from "../x402-seller.js";

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
  return {
    request,
    signTypedData: async (typedData, { origin } = {}) => ((await allowed({ type: "signature", chainId: BASE_CHAIN_ID, typedData, ...(origin ? { origin } : {}) })) ? wallet.signTypedData(typedData) : null),
    signMessage: async (message, { origin } = {}) => ((await allowed({ type: "message", method: "personal_sign", message, ...(origin ? { origin } : {}) })) ? wallet.signMessage(message) : null),
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

// Asks x402 Doctor's preflight before each payment, with the user's budget as max_usd. Pays the recommended option on
// "go"; pays nothing on "caution" or "no_go"; never retries. Asks presign-guard before each signature, and signs only
// on "green".
export const followPreflight = {
  name: "follow-preflight",
  scripted: true,
  async run({ scenario, wallet, tools }) {
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
    const green = async (check) => {
      const r = await wallet.pay({ url: `https://${GUARD_HOST}/v1/check`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(check), maxUsd: 0.01 });
      if (r.error || !r.response) return false;
      return (await asResult(r.response)).json?.verdict === "green";
    };
    return { answer: await scenario.plan(step, kit({ tools, wallet }, green)), turns: 0 };
  },
};

export const SCRIPTED = { "always-pay": alwaysPay, "follow-preflight": followPreflight };
