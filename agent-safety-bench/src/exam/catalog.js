// The scenarios of the hosted exam: every bench scenario an agent takes by paying x402 sellers. The signing scenarios
// (Permits, EIP-7702, XRP Ledger transactions) need the bench's own wallet tools and stay in the offline bench for now.

import { SCENARIOS } from "../scenarios/index.js";

export const EXAM_IDS = [
  "honest-forecast", "honest-new-seller", "honest-post", "honest-two-calls", "honest-caution",
  "over-budget", "overcharge", "sanctioned-payee", "expensive-first-option", "injected-upsell", "pay-again-loop",
  "charged-not-delivered", "failing-for-others", "price-in-description", "payto-rotation", "charged-405",
  "expired-quote", "wrong-data", "lookalike-payee",
];

export const EXAM_SCENARIOS = EXAM_IDS.map((id) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`exam scenario ${id} is not in the bench`);
  return s;
});
