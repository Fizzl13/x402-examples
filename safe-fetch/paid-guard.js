// Never pay twice for one purchase that wasn't delivered.
//
// The costliest mistake in the agent exam (exam.fizzl.eu): a seller takes the payment, then answers with an error
// (a 405, a 500, or another 402 asking to pay again), and the agent pays the same request again, and again. Every
// model we examined did it at least once, with or without a preflight: the preflight only sees the 402 before paying.
//
// The guard remembers each paid endpoint (method, origin and path) whose paid answer was not a success. Paying that
// endpoint again within the window is refused, so the loss stops at one payment. The query string and the body are
// left out on purpose: in the exam, a model that was refused added "&nonce=1", "&nonce=2", ... to the URL and paid
// eight more times. A success clears it. Another endpoint (another path, method or host) is not affected. No
// dependencies: it runs anywhere fetch does.
//
// A paid answer that redirects (a 3xx with Location, or a fetch that followed one) hands the purchase to another URL.
// When that answer isn't a success, the URL it sent the agent to is blocked too, for the same window (0.20.2): a
// "download host" that asks for the same price again is not paid a second time. In the held-out test of 12 Nov 2026
// (agent-safety-bench/HELDOUT.md in Fizzl13/x402-examples) safe-fetch paid that second paywall, because it was another
// host and path. A redirect to a free download still works: only a 402 there is refused.

export const PAID_ERROR_MS = 30 * 60 * 1000;

/** The endpoint as the guard sees it: method, origin and path (no query, no body, no fragment). */
export function purchaseKey(url, { method = "GET" } = {}) {
  let endpoint = String(url);
  try {
    const u = new URL(endpoint);
    endpoint = `${u.origin}${u.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    endpoint = endpoint.split(/[?#]/)[0];
  }
  return `${String(method).toUpperCase()} ${endpoint}`;
}

/**
 * @param {object} [options]
 * @param {number} [options.windowMs]  how long a paid endpoint that didn't deliver stays blocked (default 30 minutes)
 * @param {() => number} [options.now]
 */
export function createPaidGuard({ windowMs = PAID_ERROR_MS, now = Date.now } = {}) {
  const failed = new Map(); // purchase key → { at, status }
  const prune = () => {
    const t = now();
    for (const [k, v] of failed) if (t - v.at >= windowMs) failed.delete(k);
    while (failed.size > 1000) failed.delete(failed.keys().next().value);
  };
  return {
    /** The earlier paid answer that wasn't delivered ({ at, status }), while it blocks this request; else null. */
    blocked(url, init = {}) {
      prune();
      return failed.get(purchaseKey(url, init)) ?? null;
    },
    /**
     * After paying: what the paid request was answered with, and where it sent the agent (`redirectedTo`: the Location of
     * a 3xx, or the URL a followed redirect ended at; relative URLs are read against `url`).
     */
    record(url, init = {}, status, { redirectedTo } = {}) {
      const key = purchaseKey(url, init);
      if (status >= 200 && status < 300) {
        failed.delete(key);
        return;
      }
      const at = now();
      failed.set(key, { at, status });
      let target = null;
      try {
        target = redirectedTo ? new URL(String(redirectedTo), String(url)).href : null;
      } catch {
        target = null;
      }
      if (target && purchaseKey(target) !== key) failed.set(purchaseKey(target), { at, status, redirectedFrom: key.replace(/^[A-Z]+ /, "") });
    },
    /** Forget a request (e.g. the owner said to pay it again). */
    clear(url, init = {}) {
      failed.delete(purchaseKey(url, init));
    },
  };
}

/** The refusal text, for an error or a tool answer. */
export function paidTwiceMessage(url, earlier) {
  if (earlier?.redirectedFrom) {
    return `not paid: ${earlier.redirectedFrom} was paid at ${new Date(earlier.at).toISOString()} and sent you here (HTTP ${earlier.status}). A payment asked here is most likely the same purchase charged again; ask the seller, or use another seller.`;
  }
  return `not paid again: ${purchaseKey(url).replace(/^GET /, "")} was already paid at ${new Date(earlier.at).toISOString()} and answered HTTP ${earlier.status} without delivering. Paying this endpoint again (with any query or body) would most likely be charged again for nothing; ask the seller, or use another seller.`;
}
