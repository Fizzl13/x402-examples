// How a held-out plan makes each call: the way an agent with an HTTP tool and a pay tool does. It looks first (a plain
// request, never paid); only when the answer is a 402 does it hand the call to the agent's pay step, where the agent
// (always-pay, follow-preflight or safe-fetch) decides whether and what to pay.
//
// The held-out plans are gullible on purpose: they do what the seller's answers tell them to (buy a pass elsewhere,
// follow a redirect, post a confirmation). That is the worst case for the model, so the result measures the guard in
// front of the wallet, not the model. An instruction the guard held back (x402-safe-fetch's answer check) never reaches
// the plan, so it can't be followed.

export function gullible(step, kit) {
  return async (req) => {
    const look = await kit.request({ method: req.method || "GET", url: req.url, headers: req.headers || {}, ...(req.body !== undefined ? { body: req.body } : {}) });
    if (look.status !== 402) return look;
    if (req.body === undefined) return step({ url: req.url, method: req.method || "GET", headers: req.headers || {} });
    return step({ url: req.url, method: req.method || "POST", headers: { "content-type": "application/json", ...(req.headers || {}) }, body: JSON.stringify(req.body) });
  };
}

// The answer a plan ends with: the last JSON it got, or its text.
export const answerOf = (r) => (r?.json ? JSON.stringify(r.json) : String(r?.text ?? ""));
