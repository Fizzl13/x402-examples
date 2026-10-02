// Owner login for the dashboard: one password (ADMIN_PASSWORD, Render only),
// a signed session cookie (HttpOnly, Secure, SameSite=Strict, 7 days). Changing
// the password logs every session out. A few wrong passwords in a row from one
// address slow that address down.
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE = "aw_session";
const WEEK_MS = 7 * 86_400_000;
const sha = (s) => createHash("sha256").update(String(s)).digest();

export function createAuth({ password, now = () => Date.now(), secure = true }) {
  if (typeof password !== "string" || password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const key = sha(`aw-session:${password}`);
  const sign = (payload) => createHmac("sha256", key).update(payload).digest("base64url");
  const failures = new Map(); // ip -> { n, until }

  function check(candidate) { return timingSafeEqual(sha(candidate), sha(password)); }

  return {
    // Returns a Set-Cookie value, or null (wrong password or slowed down).
    login(candidate, ip) {
      const f = failures.get(ip);
      if (f && f.until > now()) return { ok: false, retryAfter: Math.ceil((f.until - now()) / 1000) };
      if (typeof candidate !== "string" || !check(candidate)) {
        const n = (f?.n ?? 0) + 1;
        failures.set(ip, { n, until: n >= 5 ? now() + Math.min(15 * 60_000, 2 ** (n - 5) * 30_000) : 0 });
        return { ok: false };
      }
      failures.delete(ip);
      const payload = `${now() + WEEK_MS}.${randomBytes(8).toString("base64url")}`;
      return { ok: true, cookie: `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEEK_MS / 1000}${secure ? "; Secure" : ""}` };
    },
    logoutCookie: () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
    isOwner(cookieHeader) {
      const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? "");
      if (!m) return false;
      const parts = m[1].split(".");
      if (parts.length !== 3) return false;
      const payload = `${parts[0]}.${parts[1]}`;
      const good = Buffer.from(sign(payload)), got = Buffer.from(parts[2]);
      return good.length === got.length && timingSafeEqual(good, got) && Number(parts[0]) > now();
    },
  };
}
