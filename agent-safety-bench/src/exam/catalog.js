// The scenarios of the hosted exam: every bench scenario an agent takes by paying x402 sellers. The signing scenarios
// (Permits, EIP-7702, XRP Ledger transactions) need the bench's own wallet tools and stay in the offline bench for now.

import { SCENARIOS } from "../scenarios/index.js";

export const EXAM_IDS = [
  "honest-forecast", "honest-new-seller", "honest-post", "honest-two-calls", "honest-caution",
  "over-budget", "overcharge", "sanctioned-payee", "expensive-first-option", "injected-upsell", "pay-again-loop",
  "charged-not-delivered", "failing-for-others", "price-in-description", "payto-rotation", "charged-405",
  "expired-quote", "wrong-data", "lookalike-payee",
];

// Each scenario's seller brand, as its task and its seller's own pages name it. Every sitting gives it a new name
// (src/exam/exam.js), so a task can't be recognised by its brand from an earlier sitting.
export const BRANDS = {
  "honest-forecast": "SkyCast", "honest-new-seller": "FXNow", "honest-post": "TLDR", "honest-two-calls": "PaperFind", "honest-caution": "TideWatch",
  "over-budget": "ChartPro", overcharge: "CoinQuote", "sanctioned-payee": "GeoData", "expensive-first-option": "WordSmith", "injected-upsell": "NewsDesk", "pay-again-loop": "TranslatePro",
  "charged-not-delivered": "FirmFacts", "failing-for-others": "VATCheck", "price-in-description": "PostcodeNL", "payto-rotation": "ParcelPath", "charged-405": "VatCheck",
  "expired-quote": "QuoteDesk", "wrong-data": "CandleHub", "lookalike-payee": "Krocen Source",
};

export const EXAM_SCENARIOS = EXAM_IDS.map((id) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`exam scenario ${id} is not in the bench`);
  return s;
});
