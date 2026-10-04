// Web Push: notifications on the phone or computer where a customer installed
// the dashboard as an app (Add to Home Screen). Standard Web Push, no extra
// packages: VAPID (RFC 8292) to say who sends, and aes128gcm (RFC 8291) so
// only the device can read the message; the push service (Apple, Google,
// Mozilla) only passes it on.
//
// The server's VAPID key is VAPID_PRIVATE_KEY (32 bytes, base64url) when set,
// else it is derived from the session secret, like the Telegram webhook secret,
// so it works without setup. Changing that secret means devices must turn
// notifications on again.
import { createECDH, createHash, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// The order of P-256: a private key must be below it (and not 0).
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function keyFrom(seed) {
  let d = BigInt(`0x${createHash("sha256").update(`aw-vapid:${seed}`).digest("hex")}`) % (N - 1n) + 1n;
  return Buffer.from(d.toString(16).padStart(64, "0"), "hex");
}

// A browser's subscription: { endpoint: "https://…", keys: { p256dh, auth } }. Returns the clean copy or throws.
export function cleanSubscription(sub) {
  const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError("That isn't a push subscription."); }
  if (url.protocol !== "https:" || endpoint.length > 1000) throw new TypeError("That isn't a push subscription.");
  const p256dh = fromB64u(sub?.keys?.p256dh ?? ""), auth = fromB64u(sub?.keys?.auth ?? "");
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new TypeError("That isn't a push subscription.");
  return { endpoint, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
}

// Encrypts one message for one subscription (RFC 8291, a single aes128gcm record).
// A fresh server key pair per message; tests can pass their own salt and key.
export function encrypt(sub, payload, { salt = randomBytes(16), serverKey = null } = {}) {
  const ua = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  if (!serverKey) { serverKey = createECDH("prime256v1"); serverKey.generateKeys(); }
  const as = serverKey.getPublicKey();
  const shared = serverKey.computeSecret(ua);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ua, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = as.length;
  return Buffer.concat([header, as, body]);
}

export function createPush({ privateKey = null, seed, subject, fetch = globalThis.fetch, now = () => Date.now() }) {
  const d = privateKey ? fromB64u(privateKey) : keyFrom(seed);
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be 32 bytes, base64url");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const jwk = { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
  const signingKey = createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = b64u(pub);
  const tokens = new Map(); // push service origin -> { jwt, until }

  function vapid(audience) {
    const t = tokens.get(audience);
    if (t && t.until > now() + 3_600_000) return t.jwt;
    const exp = Math.floor(now() / 1000) + 12 * 3600;
    const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const claims = b64u(JSON.stringify({ aud: audience, exp, sub: subject }));
    const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: signingKey, dsaEncoding: "ieee-p1363" });
    const jwt = `${head}.${claims}.${b64u(sig)}`;
    tokens.set(audience, { jwt, until: exp * 1000 });
    return jwt;
  }

  return {
    publicKey,
    // Sends { title, body, url, tag, … } to one device. Returns "ok", or "gone" when the device
    // unsubscribed or the subscription expired (then forget it); throws on other failures.
    async send(sub, message, { ttl = 86_400, urgency = "high" } = {}) {
      const audience = new URL(sub.endpoint).origin;
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(ttl), urgency, authorization: `vapid t=${vapid(audience)}, k=${publicKey}` },
        body: encrypt(sub, JSON.stringify(message)),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 410) return "gone";
      if (!res.ok) throw new Error(`push service answered ${res.status}`);
      return "ok";
    },
  };
}
