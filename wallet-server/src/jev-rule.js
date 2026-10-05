// A spending rule in plain words ("only crypto market data, no AI text or images"), checked per purchase
// by TypeSafe's Jev before an agent may sign: does what it is about to buy fall within the owner's rule?
// Clearly outside: per the owner's choice the agent asks first ("ask") or is stopped ("stop"). Unsure: the
// agent asks first, never stopped on a guess. Clearly inside, or nothing to judge: the normal limits apply.
// Off without TYPESAFE_API_KEY (then the rule isn't checked; the dashboard says so).
const API = "https://api.typesafe.ai/v1/systemone";

export function cleanRule(rule) {
  if (rule === undefined || rule === null) return null;
  if (typeof rule !== "object") throw new TypeError("rule must be { text, mode }");
  const text = typeof rule.text === "string" ? rule.text.trim() : "";
  if (!text) return null; // an empty rule switches it off
  if (text.length > 300) throw new TypeError("rule.text: at most 300 characters");
  if (rule.mode !== undefined && !["ask", "stop"].includes(rule.mode)) throw new TypeError('rule.mode must be "ask" or "stop"');
  return { text, mode: rule.mode ?? "ask" };
}

export function createRuleChecker({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 2500, model = process.env.JEV_MODEL || "jev-latest", log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== "off";

  // purchase: { description, url } as the agent reported it. Returns { within } (probability it fits) or null.
  async function check(ruleText, purchase) {
    if (!enabled || !ruleText || !(purchase?.description || purchase?.url)) return null;
    let host = null;
    try { host = purchase.url ? new URL(purchase.url).host : null; } catch {}
    try {
      const res = await fetchImpl(API, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          state: { owner_rule: ruleText, purchase: { what: purchase.description ?? null, seller: host, url: purchase.url ?? null } },
          questions: {
            within: {
              type: "noul",
              instructions: "The owner of an AI agent set `owner_rule` for what the agent may buy. Does `purchase` fall within that rule?",
              criteria: { true: "What is bought is clearly allowed by the rule", false: "What is bought is outside the rule or something the rule excludes" },
            },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[rule] HTTP ${res.status}`); return null; }
      const p = (await res.json())?.answers?.within?.noul;
      return typeof p === "number" ? { within: Math.round(p * 100) / 100 } : null;
    } catch (err) {
      log.warn?.(`[rule] ${err.name}: ${err.message}`);
      return null;
    }
  }

  return { enabled, check };
}

// What a check means for the purchase: null (fine) or a reason, with hardStop for "stop" when clearly outside.
export function ruleOutcome(rule, result, { outside = 0.3, inside = 0.7 } = {}) {
  if (!rule || !result) return null;
  if (result.within >= inside) return null;
  const pct = Math.round((1 - result.within) * 100);
  if (result.within <= outside) {
    return { hardStop: rule.mode === "stop", reason: { code: "outside_rule", within: result.within, message: `outside your rule "${rule.text}" (AI check, ${pct}% sure)` } };
  }
  return { hardStop: false, reason: { code: "rule_unsure", within: result.within, message: `maybe outside your rule "${rule.text}" (AI check unsure)` } };
}
