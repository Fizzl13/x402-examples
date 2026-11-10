// Checking a signed exam result (POST /v1/verify, MCP agent_safety_verify, the "Check this result" button): the
// signature over the result's canonical JSON, and the Fizzl payout wallet's certificate for the key that made it
// (src/exam/cert.js). Anyone can do the same without us: EIP-191 recover over the canonical JSON of the result
// without signer, signature (and the fields a reader adds: details, current), then check signer_cert against the
// payout wallet with the message on /v1/signer.

import { verifyMessage } from "viem";
import { AUTHORITY, certValid } from "./cert.js";

// The fields that are not part of the signed record: the signature itself, and what an answer adds around it.
const UNSIGNED = ["signer", "signature", "details", "current", "result_page"];

export function signedRecord(result) {
  const record = { ...result };
  for (const k of UNSIGNED) delete record[k];
  return record;
}

// result: a signed result as /v1/results/:id or the finish answer gives it. canonical: the exam's canonical JSON.
// currentSigner: the exam's key now (an old result without a certificate is still known by it). stored: the result
// the index holds under the same id, if any.
export async function verifyResult(result, { canonical, authority = AUTHORITY, currentSigner = null, stored = null } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { valid: false, reason: "no result given" };
  const { signer, signature } = result;
  if (typeof signer !== "string" || typeof signature !== "string") return { valid: false, reason: "the result is not signed" };
  const record = signedRecord(result);
  let signed = false;
  try {
    signed = await verifyMessage({ address: signer, message: canonical(record), signature });
  } catch {
    signed = false;
  }
  if (!signed) return { valid: false, signer, reason: "the signature does not match this result: it was changed after signing, or signed by another key" };

  const cert = record.signer_cert;
  const certified = Boolean(
    cert && String(cert.signer).toLowerCase() === signer.toLowerCase() && String(record.finished_at || "").slice(0, 10) >= cert.valid_from && (await certValid(cert, { authority })),
  );
  const current = Boolean(currentSigner && currentSigner.toLowerCase() === signer.toLowerCase());
  const sameAsIndex = stored ? canonical(signedRecord(stored)) === canonical(record) : null;
  const out = {
    valid: certified || current,
    signer,
    certified,
    ...(certified ? { certified_by: cert.authority, certified_from: cert.valid_from } : {}),
    current_signer: current,
    in_index: sameAsIndex,
    id: record.id ?? null,
    agent: record.agent ?? null,
    score: record.score ?? null,
    admitted: record.admitted ?? null,
    finished_at: record.finished_at ?? null,
  };
  if (!out.valid) out.reason = "signed, but by a key that is neither the exam's nor certified by the Fizzl payout wallet";
  else if (certified) out.note = `Signed by ${signer}, a key the Fizzl payout wallet ${cert.authority} certified on ${cert.valid_from}.`;
  else out.note = `Signed by ${signer}, the exam's own key (this result is from before the key was certified).`;
  return out;
}
