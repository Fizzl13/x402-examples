// Never pay twice for one purchase that wasn't delivered.
//
// The costliest mistake in the agent exam (exam.fizzl.eu): a seller takes the payment, then answers with an error
// (a 405, a 500, or another 402 asking to pay again), and the agent pays the same request again, and again. Every
// model we examined did it at least once, with or without a preflight: the preflight only sees the 402 before paying.
//
// The guard remembers each paid request (method, URL and body) whose paid answer was not a success. Paying that same
// request again within the window is refused, so the loss stops at one payment. A success clears it. A different
// request (another URL, method or body) is not affected. No dependencies: it runs anywhere fetch does.

export const PAID_ERROR_MS = 30 * 60 * 1000;

// A short, stable fingerprint of the body (FNV-1a, 32 bit): the key holds no request content.
function bodyKey(body) {
  if (body === undefined || body === null) return "";
  const text = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : ArrayBuffer.isView(body) ? new TextDecoder().decode(body) : body instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(body)) : String(body);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

/** The request as the guard sees it: method, URL and a fingerprint of the body. */
export function purchaseKey(url, { method = "GET", body } = {}) {
  return `${String(method).toUpperCase()} ${String(url)} ${bodyKey(body)}`;
}

/**
 * @param {object} [options]
 * @param {number} [options.windowMs]  how long a paid request that wasn't delivered stays blocked (default 30 minutes)
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
  return `not paid again: ${url} was already paid at ${new Date(earlier.at).toISOString()} and answered HTTP ${earlier.status} without delivering. Paying the same request again would most likely be charged again for nothing; ask the seller, or try a different request.`;
}
