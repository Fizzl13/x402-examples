// Dashboard sessions: a signed cookie (HttpOnly, Secure, SameSite=Strict, 7
// days) naming the account: "admin" (the owner, signed in with ADMIN_PASSWORD)
// or a customer's lowercase wallet address (signed in with their wallet), or em:<hash> (signed in with e-mail).
// The signing key comes from SESSION_SECRET, or else ADMIN_PASSWORD: changing
// it logs every session out. A few wrong passwords in a row from one address
// slow that address down; so do many wallet sign-ins.
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE = "aw_session";
const WEEK_MS = 7 * 86_400_000;
const sha = (s) => createHash("sha256").update(String(s)).digest();
const SUBJECT = /^(admin|0x[0-9a-f]{40}|sol:[1-9A-HJ-NP-Za-km-z]{32,44}|em:[0-9a-f]{40}|xrpl:r[1-9A-HJ-NP-Za-km-z]{24,34})$/; // the owner, an Ethereum, Solana, e-mail or XRPL (Xaman) account

export function createAuth({ password, secret, now = () => Date.now(), secure = true }) {
  if (password !== undefined && password !== null && password !== "" && (typeof password !== "string" || password.length < 12)) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const hasPassword = typeof password === "string" && password.length >= 12;
  const keySource = secret || (hasPassword ? password : null);
  if (!keySource || String(keySource).length < 12) throw new Error("set SESSION_SECRET (or ADMIN_PASSWORD) of at least 12 characters");
  const key = sha(`aw-session:${keySource}`);
  const sign = (payload) => createHmac("sha256", key).update(payload).digest("base64url");
  const failures = new Map(); // ip -> { n, until }
  const signIns = new Map(); // ip -> { n, since }

  const cookieFor = (subject) => {
    const payload = `${now() + WEEK_MS}.${subject}.${randomBytes(8).toString("base64url")}`;
    return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEEK_MS / 1000}${secure ? "; Secure" : ""}`;
  };

  return {
    hasPassword,
    // Owner login with the password. Returns { ok, cookie } or { ok: false, retryAfter? }.
    login(candidate, ip) {
      if (!hasPassword) return { ok: false };
      const f = failures.get(ip);
      if (f && f.until > now()) return { ok: false, retryAfter: Math.ceil((f.until - now()) / 1000) };
      if (typeof candidate !== "string" || !timingSafeEqual(sha(candidate), sha(password))) {
        const n = (f?.n ?? 0) + 1;
        failures.set(ip, { n, until: n >= 5 ? now() + Math.min(15 * 60_000, 2 ** (n - 5) * 30_000) : 0 });
        return { ok: false };
      }
      failures.delete(ip);
      return { ok: true, cookie: cookieFor("admin") };
    },
    // At most 30 wallet sign-in attempts per address per hour.
    allowSignIn(ip) {
      const s = signIns.get(ip);
      if (!s || now() - s.since > 3_600_000) { signIns.set(ip, { n: 1, since: now() }); return true; }
      s.n++;
      return s.n <= 30;
    },
    sessionFor(subject) {
      if (!SUBJECT.test(subject)) throw new Error("bad session subject");
      return cookieFor(subject);
    },
    logoutCookie: () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
    // The account of a valid session cookie, or null.
    subject(cookieHeader) {
      const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? "");
      if (!m) return null;
      const parts = m[1].split(".");
      if (parts.length !== 4) return null;
      const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const good = Buffer.from(sign(payload)), got = Buffer.from(parts[3]);
      if (good.length !== got.length || !timingSafeEqual(good, got) || Number(parts[0]) <= now()) return null;
      return SUBJECT.test(parts[1]) ? parts[1] : null;
    },
  };
}
