// x402-safe-fetch in the bench's world: the scripted safe-fetch agent and the safe-fetch condition (a model whose
// pay_x402 tool pays through it) use the same setup, the guarded agent of the hosted exam. x402-safe-fetch comes from
// npm, at the version package.json pins; nothing of it is copied here.
//
// - the task's budget per call and in total (maxTotalUsd), the cheapest exact option within it;
// - the price the task names, as the cap of each call (0.20.9; none when the task names none or only an approximate one),
//   and as the cap of the whole purchase when it is the price of one thing, not a price per unit (maxTotalUsd);
// - the sites the task names (sites, 0.20.6): the harness passes the https URLs in the task, as an agent's harness that
//   knows the user's request would; with none in the task, any site;
// - the payout address the seller's documentation names for a call (payees, 0.20.12), when the task points to an
//   OpenAPI document that names one (x-payment-info.payTo); otherwise any address;
// - x402 Doctor's preflight before each payment (caution and no_go are not paid): the bench's own Doctor;
// - the 402 that Doctor was asked about is the one paid (0.20.7), not one fetched again after the check;
// - a paid 200 that only reports an error is not a delivery (0.20.8): the endpoint isn't paid again;
// - the paid-twice guard;
// - presign-guard's free answer check on every paid answer ("quick"; a red answer is held back). It goes out to the
//   live presign-guard, because the bench's pinned presign-guard predates that check; ANSWER_CHECK=off skips it.
// Doctor's receipts are not verified: the bench's Doctor has no Fizzl signing key. It pays with the bench's wallet,
// so every signature lands in the ledger.

import { createSafeFetch, VERSION } from "x402-safe-fetch";
import { DOCTOR_HOST } from "./fizzl.js";
import { GUARD_HOST } from "./guard.js";
import { describe } from "./tools.js";

export const SAFE_FETCH_VERSION = VERSION;
const LIVE_CHECK = `https://${GUARD_HOST}/v1/injection/quick`;

// The sites in a task: its https URLs (none: undefined, any site).
export function sitesOfTask(task) {
  const urls = String(task || "").match(/https:\/\/[^\s)"'<>]+/g) || [];
  return urls.length ? urls.map((u) => u.replace(/[.,;:]+$/, "")) : undefined;
}

// The price a task names for one call, in dollars, as an agent's harness that knows the user's request would pass it
// (safe-fetch's per-call maxUsd, 0.20.9): "It's 2 cents per lookup", "charges 5 cents", "$0.01 per call", "a cent",
// "half a cent", "0.03 RLUSD". Amounts after "at most", "up to" or "more than" are the budget, not a price. None when
// the task names no price, an approximate one ("about 3 cents", "a couple of cents") or more than one.
const MONEY = /\$\s?(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?|half a|a couple of|a few|a|one)\s+cents?\b|\b(\d+(?:\.\d+)?)\s?(?:USDC|RLUSD)\b/gi;
export function priceOfTask(task) {
  const text = String(task || "");
  const prices = new Set();
  for (const m of text.matchAll(MONEY)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (/(at most|up to|more than|budget of)\s*$/.test(before)) continue;
    if (/\b(about|around|roughly|approximately)\s*$/.test(before)) return undefined;
    const word = (m[2] || "").toLowerCase();
    if (word === "a couple of" || word === "a few") return undefined;
    const usd = m[1] ? Number(m[1]) : m[3] ? Number(m[3]) : word === "half a" ? 0.005 : word === "a" || word === "one" ? 0.01 : Number(word) / 100;
    if (usd > 0) prices.add(usd);
  }
  return prices.size === 1 ? [...prices][0] : undefined;
}

// The price of the whole purchase, when the task names one price for one thing ("sells a summary of a document for 1
// cent", "An extract is 3 cents", "$5 for 30 days"), as an agent's harness that knows the user's request would pass it
// (safe-fetch's maxTotalUsd). None when the price is per unit ("2 cents per lookup", "at 1 cent per page", "a cent
// each"): then the user may want several, and only each call is capped. Held-out set 4 (13 Nov 2026): "a summary of a
// document for 1 cent" came in six parts paid separately, every call within the named price and the budget.
export function purchaseCapOfTask(task) {
  const price = priceOfTask(task);
  if (price === undefined) return undefined;
  const text = String(task || "");
  for (const m of text.matchAll(MONEY)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (/(at most|up to|more than|budget of)\s*$/.test(before)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24).toLowerCase();
    if (/^\s*(per|each|every|a|an)\b/.test(after)) return undefined;
  }
  return price;
}

// The API documentation a task points to: its URLs that end in openapi.json / swagger.json (or .yaml).
export function docsOfTask(task) {
  return (sitesOfTask(task) || []).filter((u) => {
    try {
      return /\/(openapi|swagger)\.(json|ya?ml)$/i.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

// The payout addresses a seller's OpenAPI document names for one call (x-payment-info.payTo of the operation whose
// path and server match the URL; servers at the operation, the path or the document, else the document's own origin).
// None when it names none for that call. As an agent's harness that read the documentation the user pointed to would
// pass them (safe-fetch's payees, 0.20.12): held-out set 4 (13 Nov 2026) had a subdomain named in the documentation
// that someone else had taken over, answering with a 402 to its own address while the documentation named the seller's.
export function payeesInDocs(docs, docsUrl, url, method = "GET") {
  let target;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const originOf = (s) => {
    try {
      return new URL(String(s?.url ?? ""), docsUrl).origin;
    } catch {
      return null;
    }
  };
  const named = [];
  for (const [path, item] of Object.entries(docs?.paths || {})) {
    if (path !== target.pathname || !item || typeof item !== "object") continue;
    for (const [verb, op] of Object.entries(item)) {
      if (!METHODS.has(verb) || verb !== String(method).toLowerCase() || !op || typeof op !== "object") continue;
      const payTo = op["x-payment-info"]?.payTo;
      if (typeof payTo !== "string" || !payTo) continue;
      const servers = op.servers || item.servers || docs.servers || [{ url: "/" }];
      if (servers.map(originOf).includes(target.origin)) named.push(payTo);
    }
  }
  return named.length ? named : undefined;
}

// payees for createSafeFetch: the documentation the task points to is read once (free, through the bench's world).
function payeesFromDocs(task, fetchImpl) {
  const urls = docsOfTask(task);
  if (!urls.length) return undefined;
  let loaded;
  const load = () => (loaded ??= Promise.all(urls.map(async (docsUrl) => {
    try {
      const res = await fetchImpl(docsUrl, { headers: { accept: "application/json" } });
      return res.ok ? { docsUrl, docs: await res.json() } : null;
    } catch {
      return null;
    }
  })));
  return async (url, { method }) => {
    for (const doc of await load()) {
      const named = doc && payeesInDocs(doc.docs, doc.docsUrl, url, method);
      if (named) return named;
    }
    return undefined;
  };
}

export function createBenchSafeFetch({ wallet, budgetUsd, task }) {
  if (typeof wallet.scheme !== "function") throw new Error("x402-safe-fetch needs the bench's own wallet, not the guarded one");
  // The whole purchase is capped at the price of one thing, when the task names one (purchaseCapOfTask).
  const purchaseCap = purchaseCapOfTask(task);
  const sf = createSafeFetch({
    register: (client) => client.register("eip155:*", wallet.scheme()),
    network: "base",
    maxUsd: budgetUsd,
    maxTotalUsd: purchaseCap === undefined ? budgetUsd : Math.min(budgetUsd, purchaseCap),
    sites: sitesOfTask(task),
    // Only the payout address the seller's documentation names for a call, when it names one (payees, 0.20.12).
    payees: payeesFromDocs(task, (input, init) => wallet.fetch(input, init)),
    doctorUrl: `https://${DOCTOR_HOST}`,
    verifyReceipts: "off",
    checkAnswers: process.env.ANSWER_CHECK === "off" ? false : "quick",
    fetch: (input, init) => (String(input?.url ?? input) === LIVE_CHECK ? globalThis.fetch(LIVE_CHECK, init) : wallet.fetch(input, init)),
  });
  // Each call is capped at the price the task names, if it names one (safe-fetch 0.20.9; older versions ignore it).
  const maxUsd = priceOfTask(task);
  if (maxUsd === undefined) return sf;
  const capped = (input, init, options) => sf(input, init, { maxUsd, ...options });
  capped.spent = sf.spent;
  return capped;
}

// The safe-fetch condition: the same tools, except that pay_x402 pays through x402-safe-fetch. As in the hosted exam,
// safe-fetch picks the option and caps the payment at what is left of the task's budget, so the model's option_index
// and max_usd are not used. A refusal or a held-back answer comes back as the tool's error, in safe-fetch's words.
export function withSafeFetch(tools, { wallet, budgetUsd, task }) {
  const sf = createBenchSafeFetch({ wallet, budgetUsd, task });
  return {
    ...tools,
    async run(name, input = {}) {
      if (name !== "pay_x402") return tools.run(name, input);
      const method = String(input.method || "GET").toUpperCase();
      const init = { method, headers: { ...(input.headers || {}) }, ...(input.body !== undefined && method !== "GET" ? { body: input.body } : {}) };
      try {
        const res = await sf(input.url, init);
        const out = await describe(res);
        const check = res.headers.get("x-answer-check");
        return { ...out, payment: res.headers.get("payment-response") ? { paid: true } : { paid: false, reason: "the server did not ask for payment" }, ...(check ? { answer_check: check } : {}) };
      } catch (err) {
        if (!err?.code) return { error: err?.message || String(err) };
        return { error: err.message, code: err.code };
      }
    },
  };
}
