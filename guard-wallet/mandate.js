// Paying under a spending mandate (the x402 `authority` extension draft, x402-mandate/1,
// x402-foundation/x402#3220). The agent's principal signs a bounded grant ("spend up to CAP, to
// recipients in R, until T"); mandatePayer() wraps the x402 payment scheme so each EIP-3009
// payment carries the grant's binding as its nonce (§7), and the guarded wallet then sends the
// mandate along to presign-guard, which turns a payment outside it red before anything is signed.
import { createHash, randomBytes } from "node:crypto";

const TAG = "x402-mandate/1\n";
const BINDING_TAG = "x402-mandate-binding/1\n";

// RFC 8785 (JCS) for the JSON a mandate holds: strings, integers, arrays, objects.
export function jcs(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value) || Math.abs(value) > 2 ** 52) throw new TypeError("only integers within 2^52 are signed");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(",")}}`;
  }
  throw new TypeError("value cannot be canonicalized");
}

export const mandateDigest = (mandate) => `sha256:${createHash("sha256").update(TAG + jcs(mandate)).digest("hex")}`;
export const mandateBinding = (digest, paymentId) => `0x${createHash("sha256").update(`${BINDING_TAG}${digest}\n${paymentId}`, "utf8").digest("hex")}`;

// nonce -> { envelope, paymentId }: how the guarded wallet knows a payment it is asked to sign
// was made under a mandate (the nonce is the binding, so it cannot be read back from it).
const bound = new Map();
export const mandateFor = (nonce) => bound.get(String(nonce ?? "").toLowerCase()) ?? null;

function cleanEnvelope(envelope) {
  const m = envelope?.mandate;
  if (!m || typeof m !== "object" || m.v !== "x402-mandate/1") throw new TypeError("mandate must be { mandate: { v: \"x402-mandate/1\", … }, alg: \"Ed25519\", sig }");
  if (envelope.alg !== "Ed25519" || typeof envelope.sig !== "string") throw new TypeError("mandate needs alg \"Ed25519\" and the issuer's sig");
  return { mandate: m, alg: envelope.alg, sig: envelope.sig };
}

/**
 * Wraps an x402 EVM payment scheme (e.g. new ExactEvmScheme(signer) from @x402/evm) so its
 * EIP-3009 payments are made under `mandate`: the nonce becomes the binding of (mandate,
 * paymentId), and a signer that is a guardWallet() wallet sends the mandate to presign-guard.
 * Permit2 payments are passed to the wrapped scheme unchanged (no mandate binding there yet).
 * @param {object} scheme  the scheme to wrap; its `signer` signs the payment
 * @param {{mandate: object, alg: "Ed25519", sig: string}} mandate  the principal's signed grant
 */
export function mandatePayer(scheme, mandate) {
  const envelope = cleanEnvelope(mandate);
  const digest = mandateDigest(envelope.mandate);
  // Everything else (scheme name, findDefaultAsset, …) comes from the wrapped scheme.
  return Object.assign(Object.create(scheme), {
    scheme: scheme.scheme ?? "exact",
    async createPaymentPayload(x402Version, requirements, context) {
      if ((requirements.extra?.assetTransferMethod ?? "eip3009") !== "eip3009") return scheme.createPaymentPayload(x402Version, requirements, context);
      if (!requirements.extra?.name || !requirements.extra?.version) throw new Error(`EIP-712 domain (name, version) missing in the payment requirements for ${requirements.asset}`);
      const signer = scheme.signer;
      const paymentId = `pgw-${randomBytes(12).toString("base64url")}`;
      const nonce = mandateBinding(digest, paymentId);
      const now = Math.floor(Date.now() / 1000);
      const authorization = { from: signer.address, to: requirements.payTo, value: String(requirements.amount), validAfter: "0", validBefore: String(now + Number(requirements.maxTimeoutSeconds ?? 300)), nonce };
      bound.set(nonce, { envelope, paymentId });
      try {
        const signature = await signer.signTypedData({
          domain: { name: requirements.extra.name, version: requirements.extra.version, chainId: Number(String(requirements.network).split(":")[1]), verifyingContract: requirements.asset },
          types: { TransferWithAuthorization: [
            { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
          ] },
          primaryType: "TransferWithAuthorization",
          message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce },
        });
        return { x402Version, payload: { authorization, signature } };
      } finally {
        bound.delete(nonce);
      }
    },
  });
}
