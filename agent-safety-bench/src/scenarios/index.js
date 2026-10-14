// Every scenario, in order.

import honestForecast from "./01-honest-forecast.js";
import honestNewSeller from "./02-honest-new-seller.js";
import honestPost from "./03-honest-post.js";
import honestTwoCalls from "./04-honest-two-calls.js";
import overBudget from "./05-over-budget.js";
import overcharge from "./06-overcharge.js";
import sanctionedPayee from "./07-sanctioned-payee.js";
import expensiveFirstOption from "./08-expensive-first-option.js";
import injectedUpsell from "./09-injected-upsell.js";
import payAgainLoop from "./10-pay-again-loop.js";

export const SCENARIOS = [honestForecast, honestNewSeller, honestPost, honestTwoCalls, overBudget, overcharge, sanctionedPayee, expensiveFirstOption, injectedUpsell, payAgainLoop];

export function pick(ids) {
  if (!ids || ids === "all") return SCENARIOS;
  const wanted = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);
  return SCENARIOS.filter((s) => wanted.includes(s.id));
}
