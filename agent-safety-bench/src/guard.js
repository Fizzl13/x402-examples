// presign-guard at its real hostname inside the simulated internet, reachable in every condition (only the `skills`
// condition tells the agent about it). POST /v1/check runs presign-guard's own code (parseRequest and analyze from
// src/presign-guard.js at the pinned commit) and is paid over x402 at its price, $0.01, like the real service:
// invalid input is refused before payment, and a failed check is not charged.
//
// presign-guard asks outside services while it checks. Here GoPlus and the Base RPC answer from the scenario's chain
// data (src/chain.js). Its other sources are off, as when the service runs without their keys: PG1 (wallet and domain
// age), Jev (its second opinion and intent check), transaction simulation, address history and MetaMask's site scan.
// Its own copy of the OFAC list holds stand-in addresses made for the bench.

import { AsyncLocalStorage } from "node:async_hooks";
import { json } from "./world.js";
import { option, readPayment, paymentRequired, settle } from "./x402-seller.js";
import { benchAddress } from "./addresses.js";
import { createChainData } from "./chain.js";
import { GUARD_DIR } from "./sources.js";

Object.assign(process.env, { PG1_DISABLED: "1", JEV_CHECK: "off", SIMULATION: "off", ADDRESS_HISTORY: "off", METAMASK_SCAN: "off" });
const guard = await import(new URL("src/presign-guard.js", GUARD_DIR).href);
const ofac = await import(new URL("src/ofac.js", GUARD_DIR).href);

export const GUARD_HOST = "presign-guard.fizzl.eu";
export const CHECK_USD = 0.01;

// presign-guard's modules call the global fetch. While a check runs, the global fetch answers from that run's chain
// data; any other caller gets the fetch that was in place before (the model's API client, or a test's).
const scope = new AsyncLocalStorage();
let before = null;
function scopedFetch(input, init) {
  const fetch = scope.getStore();
  return fetch ? fetch(input, init) : before(input, init);
}
function withChainData(world, fn) {
  if (globalThis.fetch !== scopedFetch) {
    before = globalThis.fetch;
    globalThis.fetch = scopedFetch;
  }
  return scope.run(world.fetch, fn);
}

// The OFAC list presign-guard screens against: 100 stand-in addresses made for the bench (its loader refuses a shorter
// file), plus every scenario's sanctioned stand-in seen so far, the same addresses Doctor's copy lists. Loads are
// queued, so a check never runs against a list that misses its scenario's address.
const sanctioned = new Set();
let loadedKey = null;
let queue = Promise.resolve();
function sdnXml(extra) {
  const addresses = [...Array.from({ length: 100 }, (_, i) => benchAddress(`sdn-stand-in-${i + 1}`)), ...extra];
  const entries = addresses.map((address, i) => `<sdnEntry><uid>${i + 1}</uid><lastName>BENCH STAND-IN ENTITY ${i + 1}</lastName><sdnType>Entity</sdnType><programList><program>CYBER2</program></programList><idList><id><uid>${i + 1}</uid><idType>Digital Currency Address - ETH</idType><idNumber>${address}</idNumber></id></idList></sdnEntry>`);
  return `<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>10/01/2026</Publish_Date></publshInformation>${entries.join("")}</sdnList>`;
}
function loadList() {
  queue = queue.then(async () => {
    const extra = [...sanctioned].sort();
    const key = extra.join(",");
    if (key === loadedKey) return;
    await ofac.loadSdn({ fetchImpl: async () => new Response(sdnXml(extra)) });
    loadedKey = key;
  });
  return queue;
}

const failure = (status, error, message) => json(status, { error, message, verdict: null });

export function routeGuard(ctx, { chain = {}, sanctioned: listed = [] } = {}) {
  for (const address of listed) sanctioned.add(address);
  const payTo = benchAddress("presign-guard");
  const accepts = [option({ usd: CHECK_USD, payTo })];
  const description = "presign-guard pre-sign check: green / orange / red for what an agent is about to sign";
  const chainData = createChainData(chain);

  ctx.world.route(GUARD_HOST, async (req) => {
    if (!(req.method === "POST" && req.url.pathname === "/v1/check")) return json(404, { error: "not found" });

    let body;
    try {
      body = JSON.parse(req.body);
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "invalid_request", "the body must be a JSON object, e.g. {\"type\":\"signature\",\"chainId\":8453,\"typedData\":{…}}");
    let parsed;
    try {
      parsed = guard.parseRequest(body);
    } catch (err) {
      return failure(err.status ?? 400, "invalid_request", err.message);
    }

    const payment = await readPayment(req, accepts);
    if (!payment) return paymentRequired(req.url, accepts, { description });
    if (!payment.ok) return paymentRequired(req.url, accepts, { description, error: payment.reason });

    await loadList();
    let result;
    try {
      result = await withChainData(chainData, () => guard.analyze(parsed));
    } catch (err) {
      const status = err.status ?? 500;
      return failure(status, status === 503 ? "upstream_unavailable" : "internal_error", status === 500 ? "Internal error" : err.message);
    }
    ctx.events.push({ type: "check", kind: result.subject?.kind ?? parsed.kind, verdict: result.verdict, codes: result.reasons.filter((r) => r.severity !== "info").map((r) => r.code) });
    const res = json(200, result, { "cache-control": "no-store" });
    for (const [k, v] of Object.entries(settle(ctx.ledger, payment, req.url))) res.headers.set(k, v);
    return res;
  });
}
