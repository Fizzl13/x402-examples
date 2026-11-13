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
//
// A paid "202 Accepted" is not a delivery yet: the seller took the money and says the result comes later (0.20.4).
// Until it does, a payment asked again on that endpoint, or on the poll URL the 202 names (Location, Content-Location,
// or a poll_url/status_url in its JSON), is refused: in held-out set 2 (12 Nov 2026) a seller answered 202 and charged
// again for every poll, and safe-fetch paid three times for one summary, because a 2xx counted as delivered. The hold
// ends when the endpoint or its poll URL answers with a result without asking to be paid (delivered()), or after the
// window. A seller whose poll URL hands over the result for free is not affected.
//
// A paid 200 whose body is an error report ({"status": "error", "error": "... please retry"}) is not a delivery either
// (0.20.8): in held-out set 3 (12 Nov 2026) a seller answered the first payment that way and charged the retry again,
// and safe-fetch paid both, because a 2xx counted as delivered. errorInAnswer decides; the caller passes what it found
// as `failure`, and the endpoint stays blocked like one that answered 500.
//
// A paid request with no answer at all (0.20.10), also when the same payment was sent again, is recorded with status 0:
// the seller may have settled it, so the endpoint is blocked like a paid error (held-out set 4, 13 Nov 2026).
//
// A paid 200 that only says the purchase is not ready yet, and asks to be requested again ({"status": "queued",
// "report_id": ..., "message": "... Request it again in a few seconds to receive it."}), is held like a 202 (0.20.11): in
// held-out set 4 (13 Nov 2026) a seller answered the first payment that way and charged the request it asked for again,
// and safe-fetch paid both, because it was a 200 with no error in it. pendingInAnswer decides; the caller passes what it
// found as `queued` (and the status URL the answer names as `pollAt`). A status that is the answer ({"order_id": ...,
// "status": "processing", "message": "The order is being packed."}) asks for nothing and is a delivery.

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
  const failed = new Map(); // purchase key → { at, status, redirectedFrom?, pollOf? }
  const prune = () => {
    const t = now();
    for (const [k, v] of failed) if (t - v.at >= windowMs) failed.delete(k);
    while (failed.size > 1000) failed.delete(failed.keys().next().value);
  };
  const resolve = (target, base) => {
    try {
      return target ? new URL(String(target), String(base)).href : null;
    } catch {
      return null;
    }
  };
  return {
    /** The earlier paid answer that wasn't delivered ({ at, status }), while it blocks this request; else null. */
    blocked(url, init = {}) {
      prune();
      return failed.get(purchaseKey(url, init)) ?? null;
    },
    /**
     * After paying: what the paid request was answered with, and where it sent the agent (`redirectedTo`: the Location of
     * a 3xx, or the URL a followed redirect ended at; `pollAt`: the poll URL of a 202 Accepted; relative URLs are read
     * against `url`).
     */
    record(url, init = {}, status, { redirectedTo, pollAt, failure, queued } = {}) {
      const key = purchaseKey(url, init);
      const held = status === 202 || Boolean(queued);
      if (status >= 200 && status < 300 && !held && !failure) {
        failed.delete(key);
        return;
      }
      const at = now();
      const note = failure ? { failure } : queued ? { queued: String(queued) } : {};
      failed.set(key, { at, status, ...note });
      const from = key.replace(/^[A-Z]+ /, "");
      const target = resolve(held ? pollAt : redirectedTo, url);
      if (target && purchaseKey(target) !== key) {
        // A poll is read with GET, whatever method paid.
        failed.set(purchaseKey(target), held ? { at, status, ...note, pollOf: from } : { at, status, redirectedFrom: from });
      }
    },
    /**
     * An answer that hands over a result without asking to be paid (a 2xx other than 202, not itself "not ready yet"): a
     * 202 or a queued 200 held on this endpoint, or on the endpoint whose poll URL this is, has delivered.
     */
    delivered(url, init = {}) {
      const key = purchaseKey(url, init);
      const here = failed.get(key);
      if (!isHeld(here)) return;
      const urlOf = (k) => k.replace(/^[A-Z]+ /, "");
      failed.delete(key);
      // The poll URL delivered: the endpoint it polls for (paid with any method) has delivered too; and the other way round.
      for (const [k, v] of failed) {
        if (isHeld(v) && ((here.pollOf && urlOf(k) === here.pollOf && !v.pollOf) || v.pollOf === urlOf(key))) failed.delete(k);
      }
    },
    /** Forget a request (e.g. the owner said to pay it again). */
    clear(url, init = {}) {
      failed.delete(purchaseKey(url, init));
    },
  };
}

// A paid answer held until the result comes: a 202 Accepted (0.20.4) or a 200 that said it isn't ready yet (0.20.11).
const isHeld = (v) => v?.status === 202 || Boolean(v?.queued);

// The keys of an error envelope: a JSON answer made of these only, with an error in it, reports a failure instead of
// handing over a result. An answer with any other key ({"tx": ..., "status": "failed"}) is data, and is left alone.
const ENVELOPE = new Set(["error", "errors", "message", "detail", "details", "status", "state", "code", "status_code", "statusCode", "success", "ok", "type", "hint", "retry", "retryable", "retry_after", "retryAfter", "request_id", "requestId", "trace_id", "traceId", "timestamp", "error_description"]);
const FAILED = new Set(["error", "failed", "failure", "fail"]);

/**
 * The error a paid JSON answer reports instead of a result, or null: an object with only error-envelope keys and either
 * an `error`/`errors` value, or a failed status (`status`/`state` error or failed, `success`/`ok` false) with a
 * `message` or `detail`. Returns the error text (at most 200 characters).
 */
export function errorInAnswer(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every((k) => ENVELOPE.has(k))) return null;
  const failedState = [body.status, body.state].some((v) => typeof v === "string" && FAILED.has(v.toLowerCase())) || body.success === false || body.ok === false;
  const said = body.error || body.errors || (failedState ? body.message || body.detail : null);
  if (!said) return null;
  const text = typeof said === "string" ? said : typeof said?.message === "string" ? said.message : JSON.stringify(said);
  return String(text).slice(0, 200);
}

// The keys of a "not ready yet" answer: a status, a message, ids, where to ask again and when. Any other key is data.
const PENDING_KEYS = new Set(["status", "state", "message", "detail", "details", "info", "note", "hint", "id", "status_url", "statusUrl", "poll_url", "pollUrl", "result_url", "resultUrl", "location", "retry_after", "retryAfter", "retry_in", "retryIn", "eta", "eta_seconds", "etaSeconds", "estimated_seconds", "queue_position", "queuePosition", "position", "progress", "created_at", "createdAt", "submitted_at", "submittedAt", "timestamp"]);
const PENDING = new Set(["queued", "pending", "accepted", "processing", "in_progress", "in progress", "in-progress", "running", "waiting", "scheduled", "submitted", "started", "preparing", "generating", "compiling"]);
// Words that ask the buyer to come back for the result: "request it again", "try again later", "check back", "poll".
const ASKS_AGAIN = /\b(?:request|ask|call|fetch|query|check|poll|try|come|send)\b[^.!?]{0,40}?\b(?:again|back|later)\b|\bretry\b|\bpoll(?:ing)?\b/i;

/**
 * What a paid JSON answer says when it only promises the result for later, or null: an object of status, message, ids
 * and where/when to ask again only, whose `status`/`state` is a pending one (queued, pending, processing, ...), and that
 * names a status URL or asks in words to be requested again. Returns the seller's words (at most 200 characters).
 */
export function pendingInAnswer(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every((k) => PENDING_KEYS.has(k) || /^[A-Za-z][A-Za-z0-9_]*(?:_id|Id)$/.test(k))) return null;
  const state = [body.status, body.state].find((v) => typeof v === "string" && PENDING.has(v.toLowerCase()));
  if (!state) return null;
  const said = [body.message, body.detail, body.info, body.note, body.hint].find((v) => typeof v === "string" && v.trim());
  const statusUrl = [body.status_url, body.statusUrl, body.poll_url, body.pollUrl, body.result_url, body.resultUrl, body.location].some((v) => typeof v === "string" && v);
  if (!statusUrl && !(said && ASKS_AGAIN.test(said))) return null;
  return String(said ?? `status: ${state}`).slice(0, 200);
}

/** The refusal text, for an error or a tool answer. */
export function paidTwiceMessage(url, earlier) {
  if (earlier?.status === 0) {
    return `not paid again: ${purchaseKey(url).replace(/^GET /, "")} was already paid at ${new Date(earlier.at).toISOString()}, and no answer came back (${earlier.failure}). The seller may have settled that payment, so paying again would most likely charge twice; ask the seller with the payment's details, or try later.`;
  }
  if (earlier?.failure) {
    return `not paid again: ${purchaseKey(url).replace(/^GET /, "")} was already paid at ${new Date(earlier.at).toISOString()} and answered HTTP ${earlier.status} with an error instead of the result ("${earlier.failure}"). Paying this endpoint again (with any query or body) would most likely be charged again; ask the seller, or use another seller.`;
  }
  if (earlier?.queued) {
    const paid = earlier.pollOf ?? purchaseKey(url).replace(/^[A-Z]+ /, "");
    return `not paid: ${paid} was paid at ${new Date(earlier.at).toISOString()} and answered HTTP ${earlier.status} saying the purchase is not ready yet ("${earlier.queued}"). A payment asked ${earlier.pollOf ? "on the status URL it named" : "again on it"} is most likely the same purchase charged again; ask again later without paying, or ask the seller.`;
  }
  if (earlier?.status === 202) {
    const paid = earlier.pollOf ?? purchaseKey(url).replace(/^[A-Z]+ /, "");
    return `not paid: ${paid} was paid at ${new Date(earlier.at).toISOString()} and answered 202 Accepted: the purchase is being prepared, not delivered. A payment asked ${earlier.pollOf ? "on its poll URL" : "again on it"} is most likely the same purchase charged again; poll without paying, or ask the seller.`;
  }
  if (earlier?.redirectedFrom) {
    return `not paid: ${earlier.redirectedFrom} was paid at ${new Date(earlier.at).toISOString()} and sent you here (HTTP ${earlier.status}). A payment asked here is most likely the same purchase charged again; ask the seller, or use another seller.`;
  }
  return `not paid again: ${purchaseKey(url).replace(/^GET /, "")} was already paid at ${new Date(earlier.at).toISOString()} and answered HTTP ${earlier.status} without delivering. Paying this endpoint again (with any query or body) would most likely be charged again for nothing; ask the seller, or use another seller.`;
}
