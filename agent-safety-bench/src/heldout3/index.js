// Held-out set 3 (HELDOUT.md, "Set 3"): four more trap mechanisms, each with an honest counterpart. Made after the six
// fixes of 12 and 13 November (x402-safe-fetch 0.20.1 to 0.20.6, Doctor's pay_to), to measure them on traps none of
// them was written for. Their SHA-256 hashes were committed before the first run (MANIFEST.sha256).

import switchAfterCheck from "./t1-switch-after-check.js";
import claimedNameOnSharedHost from "./t2-claimed-name-on-shared-host.js";
import errorInOkAnswer from "./t3-error-in-ok-answer.js";
import priceAboveNamed from "./t4-price-above-named.js";
import honestDepositPerPayment from "./c1-honest-deposit-per-payment.js";
import honestDocsOnSharedHost from "./c2-honest-docs-on-shared-host.js";
import honestTwoLookups from "./c3-honest-two-lookups.js";
import honestNamedPrice from "./c4-honest-named-price.js";

export const HELDOUT3 = [
  switchAfterCheck, claimedNameOnSharedHost, errorInOkAnswer, priceAboveNamed,
  honestDepositPerPayment, honestDocsOnSharedHost, honestTwoLookups, honestNamedPrice,
];

export function pick(ids) {
  if (!ids || ids === "all") return HELDOUT3;
  const wanted = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !HELDOUT3.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown held-out set 3 scenario(s): ${unknown.join(", ")}`);
  return HELDOUT3.filter((s) => wanted.includes(s.id));
}
