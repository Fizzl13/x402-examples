// Held-out set 4 (HELDOUT.md, "Set 4"): four more trap mechanisms, each with an honest counterpart. Made after the nine
// fixes of 12 and 13 November (x402-safe-fetch 0.20.1 to 0.20.9, Doctor's pay_to, and the harness passing the sites
// and the price the task names), to measure them on traps none of them was written for. Their SHA-256 hashes were
// committed before the first run of a guarded agent (MANIFEST.sha256).

import lostAnswer from "./t1-lost-answer.js";
import queuedOkAnswer from "./t2-queued-ok-answer.js";
import answerInPaidParts from "./t3-answer-in-paid-parts.js";
import takenOverSubdomain from "./t4-taken-over-subdomain.js";
import honestRefusedConnection from "./c1-honest-refused-connection.js";
import honestOrderProcessing from "./c2-honest-order-processing.js";
import honestPagedList from "./c3-honest-paged-list.js";
import honestNewApiSubdomain from "./c4-honest-new-api-subdomain.js";

export const HELDOUT4 = [
  lostAnswer, queuedOkAnswer, answerInPaidParts, takenOverSubdomain,
  honestRefusedConnection, honestOrderProcessing, honestPagedList, honestNewApiSubdomain,
];

export function pick(ids) {
  if (!ids || ids === "all") return HELDOUT4;
  const wanted = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !HELDOUT4.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown held-out set 4 scenario(s): ${unknown.join(", ")}`);
  return HELDOUT4.filter((s) => wanted.includes(s.id));
}
