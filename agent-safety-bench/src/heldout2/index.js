// Held-out set 2 (HELDOUT.md, "Set 2"): four more trap mechanisms that x402-safe-fetch was never fixed against, each
// with an honest counterpart. Made after the fixes in 0.20.1 and 0.20.2, to measure them on traps they weren't written
// for. Their SHA-256 hashes were committed before the first run (MANIFEST.sha256).

import binaryLabeledUpsell from "./t1-binary-labeled-upsell.js";
import cloakedOffer from "./t2-cloaked-offer.js";
import docsPointElsewhere from "./t3-docs-point-elsewhere.js";
import acceptedThenCharge from "./t4-accepted-then-charge.js";
import honestBinaryFile from "./c1-honest-binary-file.js";
import honestVaryingOffer from "./c2-honest-varying-offer.js";
import honestDocsOwnApi from "./c3-honest-docs-own-api.js";
import honestAcceptedThenFree from "./c4-honest-accepted-then-free.js";

export const HELDOUT2 = [
  binaryLabeledUpsell, cloakedOffer, docsPointElsewhere, acceptedThenCharge,
  honestBinaryFile, honestVaryingOffer, honestDocsOwnApi, honestAcceptedThenFree,
];

export function pick(ids) {
  if (!ids || ids === "all") return HELDOUT2;
  const wanted = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !HELDOUT2.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown held-out set 2 scenario(s): ${unknown.join(", ")}`);
  return HELDOUT2.filter((s) => wanted.includes(s.id));
}
