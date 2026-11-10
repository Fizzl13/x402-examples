// Results taken out of the index because the sitting itself was broken, not because of what the agent did: the result
// stays signed and readable at /v1/results/<id> (with `withdrawn` saying why), but it is not listed, does not count as
// an agent's latest exam and is not shown for its site. Only for a sitting that could not be a fair test; a low score
// is never a reason.
export const WITHDRAWN = {
  // 10 Nov 2026, exam-agent.yml over OpenRouter: the OpenRouter account ran out of credit during the sitting, so most
  // tasks were answered with an API error instead of by the model.
  dac9642dc6d30e759c481352: "the model's API ran out of credit during the sitting: most tasks were never seen by the model",
  e168ba9e5156be0f3854691a: "the model's API ran out of credit during the sitting: most tasks were never seen by the model",
  e70459f3a5d12ec9db6b1bd0: "the model's API ran out of credit during the sitting: most tasks were never seen by the model",
  "31c699cd40186824d1537718": "the model's API ran out of credit during the sitting: most tasks were never seen by the model",
};

export const withdrawnReason = (id) => (Object.hasOwn(WITHDRAWN, String(id)) ? WITHDRAWN[id] : null);
