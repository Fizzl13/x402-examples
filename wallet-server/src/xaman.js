// Sign in with Xaman (the XRP Ledger wallet): OpenID Connect with PKCE against Xaman's OAuth2 server.
// Only the app's public API key is needed (no secret): the server keeps the PKCE verifier, Xaman asks the
// user in the app, and the userinfo `sub` is the XRPL account (r…) that signed in.
import { createHash, randomBytes } from "node:crypto";

export const XAMAN_OAUTH = "https://oauth2.xumm.app";
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authUrl({ apiKey, redirectUri, state, challenge }) {
  const q = new URLSearchParams({ client_id: apiKey, redirect_uri: redirectUri, response_type: "code", scope: "openid", state, code_challenge: challenge, code_challenge_method: "S256" });
  return `${XAMAN_OAUTH}/auth?${q}`;
}

// code + verifier -> the XRPL account that signed in (throws when Xaman says no or answers oddly).
export async function accountFor({ apiKey, redirectUri, code, verifier, fetch: fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${XAMAN_OAUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: apiKey, redirect_uri: redirectUri, code_verifier: verifier }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = await res.json().catch(() => null);
  if (!res.ok || !token?.access_token) throw Object.assign(new Error(`Xaman sign-in failed: ${token?.error_description ?? token?.error ?? `HTTP ${res.status}`}`), { status: 401 });
  const me = await (await fetchImpl(`${XAMAN_OAUTH}/userinfo`, { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) })).json().catch(() => null);
  const account = me?.sub ?? me?.account;
  if (!ADDRESS_RE.test(String(account ?? ""))) throw Object.assign(new Error("Xaman did not say which XRPL account signed in"), { status: 401 });
  return { account, networkType: me?.networkType ?? null };
}
