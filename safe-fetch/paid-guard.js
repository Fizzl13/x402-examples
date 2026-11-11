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
    /** After paying: what the paid request was answered with. */
    record(url, init = {}, status) {
      const key = purchaseKey(url, init);
      if (status >= 200 && status < 300) failed.delete(key);
      else failed.set(key, { at: now(), status });
    },
    /** Forget a request (e.g. the owner said to pay it again). */
    clear(url, init = {}) {
      failed.delete(purchaseKey(url, init));
    },
  };
}

/** The refusal text, for an error or a tool answer. */
export function paidTwiceMessage(url, earlier) {
  return `not paid again: ${purchaseKey(url).replace(/^GET /, "")} was already paid at ${new Date(earlier.at).toISOString()} and answered HTTP ${earlier.status} without delivering. Paying this endpoint again (with any query or body) would most likely be charged again for nothing; ask the seller, or use another seller.`;
}
