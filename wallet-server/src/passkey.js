// Passkeys (WebAuthn): sign in with Face ID, Touch ID, a fingerprint or the phone's
// screen lock. No extra packages: the browser makes a key pair on the device (synced
// through iCloud Keychain or Google Password Manager), we keep only the public key
// and check each sign-in signature with node:crypto. No attestation is asked for
// ("none"): we don't need to know which brand of device made the key.
import { createHash, createPublicKey, verify } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 4096) throw new TypeError("bad base64url");
  return Buffer.from(s, "base64url");
};
const sha256 = (data) => createHash("sha256").update(data).digest();
const fail = (msg) => Object.assign(new Error(msg), { status: 401 });

// Just enough CBOR (RFC 8949) for an attestation object and a COSE key: maps, byte and
// text strings, small integers, arrays. Returns [value, next offset].
export function cbor(buf, at = 0) {
  const head = buf[at], major = head >> 5, info = head & 31;
  let len, p = at + 1;
  if (info < 24) len = info;
  else if (info === 24) { len = buf[p]; p += 1; }
  else if (info === 25) { len = buf.readUInt16BE(p); p += 2; }
  else if (info === 26) { len = buf.readUInt32BE(p); p += 4; }
  else throw new TypeError("unsupported CBOR");
  if (major === 0) return [len, p];
  if (major === 1) return [-1 - len, p];
  if (major === 2) return [buf.subarray(p, p + len), p + len];
  if (major === 3) return [buf.subarray(p, p + len).toString("utf8"), p + len];
  if (major === 4) { const out = []; for (let i = 0; i < len; i++) { const [v, n] = cbor(buf, p); out.push(v); p = n; } return [out, p]; }
  if (major === 5) { const out = new Map(); for (let i = 0; i < len; i++) { const [k, n] = cbor(buf, p); const [v, m] = cbor(buf, n); out.set(k, v); p = m; } return [out, p]; }
  if (major === 7 && (info === 20 || info === 21)) return [info === 21, p];
  throw new TypeError("unsupported CBOR");
}

// A COSE public key (as in the authenticator data) to a key node:crypto can verify with.
function coseToKey(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) } };
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: b64u(cose.get(-2)) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: "RSA", n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) } };
  throw new TypeError("This kind of passkey isn't supported.");
}

function parseAuthData(data) {
  if (data.length < 37) throw fail("That passkey answer is incomplete.");
  const out = { rpIdHash: data.subarray(0, 32), flags: data[32], counter: data.readUInt32BE(33) };
  if (out.flags & 0x40) {
    const idLen = data.readUInt16BE(53);
    out.credentialId = data.subarray(55, 55 + idLen);
    out.cose = cbor(data, 55 + idLen)[0];
  }
  return out;
}

// clientDataJSON says what the browser signed: the kind, our challenge, and the page it came from.
function checkClient(clientDataJSON, { type, origin }) {
  let c;
  try { c = JSON.parse(fromB64u(clientDataJSON).toString("utf8")); } catch { throw fail("That passkey answer can't be read."); }
  if (c.type !== type) throw fail("That passkey answer is for something else.");
  if (c.origin !== origin) throw fail("That passkey answer came from another site.");
  if (typeof c.challenge !== "string") throw fail("That passkey answer has no challenge.");
  return c.challenge;
}

function checkFlags(auth, rpId) {
  if (!auth.rpIdHash.equals(sha256(rpId))) throw fail("That passkey belongs to another site.");
  if (!(auth.flags & 0x01)) throw fail("The device didn't confirm you were there.");
  if (!(auth.flags & 0x04)) throw fail("The device didn't check your face, fingerprint or screen lock.");
}

// Registration: the browser's answer to navigator.credentials.create().
// Returns the challenge it answered (the caller checks it was ours) and the key to keep.
export function readRegistration({ clientDataJSON, attestationObject }, { origin, rpId }) {
  const challenge = checkClient(clientDataJSON, { type: "webauthn.create", origin });
  let att;
  try { att = cbor(fromB64u(attestationObject))[0]; } catch { throw fail("That passkey answer can't be read."); }
  const auth = parseAuthData(att.get("authData"));
  checkFlags(auth, rpId);
  if (!auth.credentialId || !auth.cose) throw fail("That passkey answer has no key in it.");
  const { alg, jwk } = coseToKey(auth.cose);
  createPublicKey({ key: jwk, format: "jwk" }); // throws on a broken key
  return { challenge, credential: { id: b64u(auth.credentialId), alg, jwk, counter: auth.counter } };
}

// Sign-in: the browser's answer to navigator.credentials.get(), checked against a kept key.
// Returns the challenge it answered and the new signature counter.
export function readAssertion({ clientDataJSON, authenticatorData, signature }, credential, { origin, rpId }) {
  const challenge = checkClient(clientDataJSON, { type: "webauthn.get", origin });
  const data = fromB64u(authenticatorData);
  const auth = parseAuthData(data);
  checkFlags(auth, rpId);
  const signed = Buffer.concat([data, sha256(fromB64u(clientDataJSON))]);
  const key = createPublicKey({ key: credential.jwk, format: "jwk" });
  const ok = verify(credential.alg === -8 ? null : "sha256", signed, key, fromB64u(signature));
  if (!ok) throw fail("That passkey signature doesn't match.");
  // A counter that goes backwards means a copied key; synced passkeys keep it at 0.
  if (credential.counter && auth.counter && auth.counter <= credential.counter) throw fail("That passkey looks copied. Remove it and add it again.");
  return { challenge, counter: auth.counter };
}
