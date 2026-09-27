// Signed verdicts: x402 Doctor signs every paid answer with a `receipt`
// (EIP-191 personal_sign over canonical JSON of the whole answer without
// receipt.signature; see the "Signed verdicts" section of the x402-doctor
// README). safe-fetch checks that receipt before acting on a preflight, so a
// tampered or forged "go" never leads to a payment.
//
// Canonical JSON (profile js-json-stringify-sorted-utf16-ascii-v1): keys
// sorted by UTF-16 code units at every level, no whitespace, every code unit
// from U+007F up as lowercase \uXXXX, numbers as JSON.stringify writes them,
// UTF-8 bytes. Python's json.dumps matches only for ASCII keys and integers; a
// Python equivalent: github.com/Fizzl13/presign-guard/blob/main/examples/canonical.py

import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// Doctor's published signers (https://x402-doctor.onrender.com/.well-known/x402-doctor-signer.json).
// Pinned here on purpose: a signer list fetched from the same server would not
// protect against that server being compromised.
export const DOCTOR_SIGNERS = ["0xAaE66eF9Ee234397df33901568c8FBc36d43277d"];

// The payout wallet (the payTo of every Fizzl payment) certifies signing keys:
// a key it authorised for the service is accepted too, so a rotated Doctor key
// verifies without a new safe-fetch release. The certificate travels inside
// the receipt (receipt.cert) as a personal_sign over certMessage.
export const AUTHORITY = "0x6B0F4651eD42893ab58139938175E4a69f175F25";

export function certMessage({ service, signer, valid_from }) {
  return `fizzl receipt signer\nservice: ${service}\nsigner: ${signer}\nvalid_from: ${valid_from}`;
}

// A key the authority certified for `service`, used on or after valid_from.
export function certifiedSigner(receipt, recovered, { authority = AUTHORITY, service = "x402-doctor" } = {}) {
  const c = receipt && receipt.cert;
  if (!c || c.service !== service || String(c.signer).toLowerCase() !== recovered) return false;
  if (String(c.authority).toLowerCase() !== authority.toLowerCase()) return false;
  if (!(String(receipt.signed_at).slice(0, 10) >= String(c.valid_from))) return false;
  return recoverSigner(certMessage(c), c.signature) === authority.toLowerCase();
}

export function canonicalJson(value) {
  const ascii = (s) => JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const walk = (v) => {
    if (v === null || typeof v !== "object") return v === undefined ? undefined : typeof v === "string" ? ascii(v) : JSON.stringify(v);
    if (typeof v.toJSON === "function") return walk(v.toJSON());
    if (Array.isArray(v)) return `[${v.map((x) => walk(x) ?? "null").join(",")}]`;
    const parts = Object.keys(v).sort().flatMap((k) => {
      const inner = walk(v[k]);
      return inner === undefined ? [] : [`${ascii(k)}:${inner}`];
    });
    return `{${parts.join(",")}}`;
  };
  return walk(value);
}

export const inputHash = (route, input) => createHash("sha256").update(canonicalJson({ route, input: input ?? {} })).digest("hex");

const hex = (bytes) => Buffer.from(bytes).toString("hex");

// The address that signed `message` with EIP-191 personal_sign, or null.
export function recoverSigner(message, signature) {
  try {
    const sig = Buffer.from(String(signature).replace(/^0x/, ""), "hex");
    if (sig.length !== 65) return null;
    const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    const bytes = Buffer.from(message, "utf8");
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`, "utf8"), bytes]));
    const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    return `0x${hex(keccak_256(pub.subarray(1))).slice(-40)}`;
  } catch {
    return null;
  }
}

/**
 * Checks a signed Doctor answer: signed by one of `signers`, and (with route
 * and input) for exactly that request.
 * @returns {{ valid: boolean, signer?: string, reason?: string }}
 */
export function verifyReceipt(body, { signers = DOCTOR_SIGNERS, route, input, authority = AUTHORITY, service = "x402-doctor" } = {}) {
  const r = body && body.receipt;
  if (!r || typeof r.signature !== "string") return { valid: false, reason: "no signed receipt" };
  const { signature, ...rest } = r;
  const recovered = recoverSigner(canonicalJson({ ...body, receipt: rest }), signature);
  if (!recovered || recovered.toLowerCase() !== String(r.signer).toLowerCase()) return { valid: false, reason: "signature does not match: the answer was changed" };
  const pinned = signers.some((s) => s.toLowerCase() === recovered);
  if (!pinned && !(authority && certifiedSigner(r, recovered, { authority, service }))) {
    return { valid: false, signer: recovered, reason: "signed by an unknown key, not x402 Doctor" };
  }
  if (route !== undefined && input !== undefined && inputHash(route, input) !== r.input_sha256) {
    return { valid: false, signer: recovered, reason: "signed for a different request" };
  }
  return { valid: true, signer: recovered };
}
