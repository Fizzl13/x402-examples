// Is an agent's website a seller in the x402 Bazaar (Coinbase's CDP discovery list)? The register lists only agents
// whose website is. Asked of x402 Doctor's free GET /api/bazaar/site?host=, which keeps the whole Bazaar in memory and
// reads it again every 6 hours, by Doctor's seller-site rule: subdomains count as the site (api.seller.ai is
// seller.ai), on shared hosting the full host name is the site (foo.vercel.app is not bar.vercel.app).
//
// bazaar(host) → { site, listed, routes, read_at } or null when Doctor gave no answer (unreachable, or still loading
// the Bazaar). An answer is kept 6 hours; after a failed ask the earlier answer for the host, if any, is used and the
// host is asked again after 5 minutes.

export const DOCTOR_URL = "https://x402-doctor.fizzl.eu";

export function createBazaarCheck({ doctorUrl = process.env.EXAM_DOCTOR_URL || DOCTOR_URL, fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = 6 * 60 * 60 * 1000, retryMs = 5 * 60 * 1000, timeoutMs = 6000 } = {}) {
  const cache = new Map(); // host -> { until, value }
  return async function bazaar(host) {
    const hit = cache.get(host);
    if (hit && hit.until > now()) return hit.value;
    let value = null;
    try {
      const res = await fetchImpl(`${doctorUrl}/api/bazaar/site?host=${encodeURIComponent(host)}`, {
        headers: { accept: "application/json", "user-agent": "agent-safety-exam (exam.fizzl.eu)" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const j = await res.json();
        if (typeof j?.listed === "boolean") value = { site: String(j.site || host), listed: j.listed, routes: Math.max(0, Number(j.routes) || 0), read_at: typeof j.read_at === "string" ? j.read_at : null };
      }
    } catch {
      // no answer: below
    }
    if (cache.size > 2000) cache.clear();
    if (value) {
      cache.set(host, { until: now() + ttlMs, value });
      return value;
    }
    const earlier = hit?.value ?? null;
    cache.set(host, { until: now() + retryMs, value: earlier });
    return earlier;
  };
}
