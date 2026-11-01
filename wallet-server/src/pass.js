// Fizzl Pass: the pass itself and its proof.
//
// A pass gives an account's agents better terms on Fizzl's services. Phase 1 has one tier, Bronze: it is Pro
// ($5 for 30 days, on every network Pro can be paid on), so every account with Pro has a Bronze pass. What the
// pass covers: the account's own wallet and its agents' wallets (learned from what they sign).
//
// Anyone can check a wallet's pass for free (GET /v1/pass/status?wallet=…): the tier and the day it ends, never
// whose it is. The owner gets a signed proof (GET /api/pass): a token "fzp1.<claims>.<signature>", signed with
// Ed25519 by the key in PASS_SIGNING_KEY; the public key is at /.well-known/fizzl-pass.json, so a partner can
// check a proof without asking Fizzl. Later phases add the benefits on the services (higher free limits, credit
// back) and Silver and Gold.
import { createPrivateKey, createPublicKey, createHash, sign as edSign, verify as edVerify } from "node:crypto";

export const PASS_TIERS = {
  bronze: { name: "Bronze", label: "Fizzl Pass Bronze", days: 30, usdc: 5 },
  // Bought on their own (they include Pro for their whole term): more credit back and higher free limits on the
  // services (lib/fizzl-pass.js and lib/fizzl-vault.js there know silver and gold already).
  silver: { name: "Silver", label: "Fizzl Pass Silver", days: 90, usdc: 20 },
  gold: { name: "Gold", label: "Fizzl Pass Gold", days: 180, usdc: 60 },
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

// The signing key from PASS_SIGNING_KEY: a 32-byte Ed25519 seed (base64 or hex), any random value of 32+ characters,
// or a PKCS#8 PEM. null when unset.
export function passKeyFrom(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  let privateKey;
  if (v.includes("BEGIN")) privateKey = createPrivateKey(v);
  else {
    // A 32-byte seed (hex or base64), or any random value of 32+ characters (Render's "Generate"), hashed to a seed.
    let seed = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : /^[A-Za-z0-9+/]{43}=?$/.test(v) ? Buffer.from(v, "base64") : null;
    if (!seed || seed.length !== 32) {
      if (v.length < 32) throw new Error("PASS_SIGNING_KEY must be a random value of at least 32 characters, a 32-byte Ed25519 seed or a PEM private key");
      seed = createHash("sha256").update(`fizzl-pass:${v}`).digest();
    }
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("PASS_SIGNING_KEY must be an Ed25519 key");
  const publicKey = createPublicKey(privateKey);
  const x = publicKey.export({ format: "jwk" }).x;
  return { privateKey, publicKey, kid: createHash("sha256").update(x).digest("base64url").slice(0, 12), x };
}

// What /.well-known/fizzl-pass.json publishes: the public key as a JWK.
export const publicJwks = (key) => ({ keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: key.kid, x: key.x }] });

// "fzp1.<base64url JSON claims>.<base64url Ed25519 signature over 'fzp1.<claims>'>".
export function signPass(claims, key) {
  const body = `fzp1.${b64u(JSON.stringify({ ...claims, kid: key.kid }))}`;
  return `${body}.${b64u(edSign(null, Buffer.from(body), key.privateKey))}`;
}

// The claims of a valid, unexpired proof; null otherwise. publicKey: a KeyObject or a JWK { x }.
export function verifyPass(token, publicKey, now = Date.now()) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "fzp1") return null;
  const pub = publicKey?.x ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.x }, format: "jwk" }) : publicKey;
  let ok = false;
  try { ok = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], "base64url")); } catch { return null; }
  if (!ok) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  return claims && claims.until > now ? claims : null;
}

// One spelling per wallet for the index: EVM addresses in lower case, others as they are.
export const walletKey = (w) => (/^0x[0-9a-fA-F]{40}$/.test(String(w)) ? String(w).toLowerCase() : String(w ?? "").trim());
export const isWallet = (w) => /^0x[0-9a-fA-F]{40}$/.test(w) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) || /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(w) || /^[A-Z2-7]{58}$/.test(w);
