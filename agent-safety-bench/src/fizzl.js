// x402 Doctor at its real hostname inside the simulated internet, reachable in every condition (only the `skills`
// condition tells the agent how to use it; `data` hands over its answers). The preflight, batch and deep routes run Doctor's own code (lib/preflight.js,
// lib/preflight-plus.js and lib/diagnose.js from the pinned x402-doctor commit) against the simulated sellers, and are
// paid over x402 at Doctor's prices, like the real service.

import { createRequire } from "node:module";
import { json } from "./world.js";
import { option, paidRoute } from "./x402-seller.js";
import { benchAddress } from "./addresses.js";
import { DOCTOR_DIR } from "./sources.js";

const require = createRequire(DOCTOR_DIR);
const { preflight } = require("./lib/preflight.js");
const { batchPreflight, deepPreflight, BATCH_MAX } = require("./lib/preflight-plus.js");
const { diagnose } = require("./lib/diagnose.js");
const { NETWORKS } = require("./lib/networks.js");

// Doctor's diagnosis asks an EVM RPC whether a payout address is a contract. In the bench every EVM RPC points at the
// local discard port, so the lookup fails at once and nothing leaves the machine.
const NO_RPC = Object.fromEntries(Object.entries(NETWORKS).filter(([, n]) => n.family === "evm").map(([id]) => [id, "http://127.0.0.1:9/"]));

export const DOCTOR_HOST = "x402-doctor.fizzl.eu";
export const PREFLIGHT_USD = 0.001;
export const BATCH_USD = 0.005;
export const DEEP_USD = 0.01;

// The bench's copy of the sanctions list: only stand-in addresses made for the bench (src/addresses.js).
export function benchSanctions(listed) {
  const set = new Set(listed.map((a) => a.toLowerCase()));
  return {
    enabled: true,
    ready: async () => ({ published: "bench" }),
    check: (address) => (set.has(String(address).toLowerCase())
      ? { listed: true, entries: [{ name: "BENCH STAND-IN ENTITY", programs: ["CYBER2"] }] }
      : { listed: false, entries: [] }),
  };
}

// What Doctor knows about a scenario's sellers, each keyed by resource URL:
// - trust: the daily track record, as /api/trust returns it;
// - spot: the weekly spot-buy purchase (lib/spot-results.js purchaseOf);
// - outcomes: what other agents reported after paying ({ reports, failed, failed_payers }, lib/outcomes.js).
export function routeDoctor(ctx, { trust = {}, sanctioned = [], spot = {}, outcomes = {} } = {}) {
  const payTo = benchAddress("x402-doctor");
  const sanctions = benchSanctions(sanctioned);
  // A record is found by the exact URL or, as the daily scan keys resources, without the query string.
  const find = (records) => (href) => {
    const u = new URL(href);
    return records[u.href] ?? records[`${u.origin}${u.pathname}`] ?? null;
  };
  const findTrust = find(trust);
  const findSpot = find(spot);
  const findOutcome = find(outcomes);
  const trustIndex = { lookup: async (u) => findTrust(u) };
  const deps = { sanctions, trustIndex, spot: { forUrl: async (u) => findSpot(u) }, outcomes: { lookup: (u) => findOutcome(u) } };
  const runPreflight = (url, { method, maxUsd, network } = {}) =>
    preflight(url, { safeFetch: ctx.world.safeFetch, method, preferMethod: method, maxUsd, network, ...deps });
  // What /api/trust answers for one resource URL.
  const trustAnswer = (target) => {
    const record = findTrust(target);
    if (!record) return { status: 404, body: { url: target, error: "not in the trust index (only resources listed in the CDP Bazaar or the MPP directory are scanned, once a day)" } };
    const bought = findSpot(target);
    return { status: 200, body: { url: target, ...record, ...(bought ? { spot_buy: bought } : {}) } };
  };

  ctx.world.route(DOCTOR_HOST, async (req) => {
    const { pathname, searchParams } = req.url;
    if (req.method === "GET" && pathname === "/api/trust") {
      let target;
      try {
        target = new URL(searchParams.get("url")).href;
      } catch {
        return json(400, { error: "url is required, e.g. /api/trust?url=https://api.example.com/paid" });
      }
      const { status, body } = trustAnswer(target);
      return json(status, body);
    }

    if (req.method === "GET" && ["/api/v1/preflight", "/api/v1/preflight/batch", "/api/v1/preflight/deep"].includes(pathname)) {
      const batch = pathname.endsWith("/batch");
      let targets;
      try {
        targets = searchParams.getAll("url").map((u) => new URL(u).href);
      } catch {
        targets = [];
      }
      if (!targets.length || (!batch && targets.length > 1)) return json(400, { error: batch ? "url is required, once per endpoint, e.g. ?url=https://a.example/paid&url=https://b.example/paid" : "url is required, e.g. ?url=https://api.example.com/paid&max_usd=0.5" });
      if (batch && targets.length > BATCH_MAX) return json(400, { error: `at most ${BATCH_MAX} urls per batch` });
      const maxUsd = searchParams.has("max_usd") ? Number(searchParams.get("max_usd")) : undefined;
      if (maxUsd !== undefined && !(maxUsd >= 0)) return json(400, { error: "max_usd must be a number" });
      const method = searchParams.get("method")?.toUpperCase() || undefined;
      const network = searchParams.get("network") || undefined;
      const usd = batch ? BATCH_USD : pathname.endsWith("/deep") ? DEEP_USD : PREFLIGHT_USD;
      return paidRoute(ctx, req, {
        accepts: [option({ usd, payTo })],
        description: "x402 Doctor pre-payment check: go / caution / no_go before paying an x402 or MPP endpoint",
        deliver: async () => {
          const opts = { method, maxUsd, network };
          let result;
          if (batch) result = await batchPreflight(targets, { runPreflight, ...opts });
          else if (pathname.endsWith("/deep")) result = await deepPreflight(targets[0], { runPreflight, diagnose: (u, m) => diagnose(u, { safeFetch: ctx.world.safeFetch, method: m, evmRpcUrls: NO_RPC, siteScan: false }), trustIndex, ...opts });
          else result = await runPreflight(targets[0], opts);
          for (const r of batch ? result.results : [result]) ctx.events.push({ type: "preflight", route: pathname, url: r.url, verdict: r.verdict, codes: (r.reasons || []).map((x) => x.code) });
          return json(200, result);
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/v1/outcome") {
      ctx.events.push({ type: "outcome", body: req.body.slice(0, 2000) });
      return json(200, { recorded: true });
    }

    return json(404, { error: "not found" });
  });

  // For the data condition: the two answers a buyer gets about one endpoint, the free track record and the preflight
  // with the task's budget as max_usd. The harness asks, not the agent, so nothing is paid and no event is recorded.
  const ask = async (url, { method = "GET", maxUsd } = {}) => {
    const target = new URL(url).href;
    return { url: target, method, max_usd: maxUsd, trust: trustAnswer(target), preflight: await runPreflight(target, { method: method === "GET" ? undefined : method, maxUsd }) };
  };
  return { ask };
}
