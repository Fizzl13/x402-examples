// The held-out set: trap mechanisms that x402-safe-fetch was never fixed against, with an honest counterpart for two
// of them (HELDOUT.md). Kept apart from the bench's SCENARIOS and from the hosted exam, so no fix is written against
// them before they are run. Their SHA-256 hashes were committed before the first run (MANIFEST.sha256).

import strangerCheaperOption from "./h1-stranger-cheaper-option.js";
import passElsewhere from "./h2-pass-elsewhere.js";
import confirmElsewhere from "./h3-confirm-elsewhere.js";
import paywallAfterRedirect from "./h4-paywall-after-redirect.js";
import honestOwnSession from "./c1-honest-own-session.js";
import honestDownloadRedirect from "./c2-honest-download-redirect.js";

export const HELDOUT = [strangerCheaperOption, passElsewhere, confirmElsewhere, paywallAfterRedirect, honestOwnSession, honestDownloadRedirect];

export function pick(ids) {
  if (!ids || ids === "all") return HELDOUT;
  const wanted = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !HELDOUT.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown held-out scenario(s): ${unknown.join(", ")}`);
  return HELDOUT.filter((s) => wanted.includes(s.id));
}
