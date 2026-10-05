// Search ranked by meaning (src/jev-rank.js) and its use in catalog.search: Jev reorders the best keyword
// matches; off or failing keeps the keyword order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRanker } from "../src/jev-rank.js";
import { createCatalog } from "../src/catalog.js";

const quiet = { warn() {} };
const jev = (scoreOf, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (status !== 200) return new Response("{}", { status });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: "score", score: scoreOf(q.instructions.service.description) }]));
    return Response.json({ model: "jev-test", answers, usage: {} });
  };
  return { fetch, calls };
};
const items = [
  { url: "https://a.test/news", host: "a.test", description: "Token news headlines" },
  { url: "https://b.test/honeypot", host: "b.test", description: "Honeypot and rug-pull check for a token before you buy" },
  { url: "https://c.test/price", host: "c.test", description: "Token price feed" },
];

test("ranker: Jev's scores reorder the matches, with a relevance; cached per query; off or failing keeps the order", async () => {
  const j = jev((d) => (d.startsWith("Honeypot") ? 3 : d.includes("price") ? 1 : 0.2));
  const r = createRanker({ apiKey: "k", fetch: j.fetch, log: quiet });
  const out = await r.rank("is this token safe to buy", items);
  assert.deepEqual(out.map((x) => x.host), ["b.test", "c.test", "a.test"]);
  assert.equal(out[0].relevance, 1);
  assert.equal(j.calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(j.calls[0].headers.authorization, "Bearer k");
  assert.equal(j.calls[0].body.state.query, "is this token safe to buy");
  await r.rank("is this token safe to buy", items);
  assert.equal(j.calls.length, 1); // cached
  assert.deepEqual((await createRanker({ apiKey: "", fetch: j.fetch }).rank("q", items)).map((x) => x.host), ["a.test", "b.test", "c.test"]);
  assert.deepEqual((await createRanker({ apiKey: "k", fetch: jev(() => 0, 529).fetch, log: quiet }).rank("q", items)).map((x) => x.host), ["a.test", "b.test", "c.test"]);
});

test("catalog.search: best-sort with words uses the ranker; cheap-sort does not", async () => {
  const usdc = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount, payTo: "0x1111111111111111111111111111111111111111" });
  const catalogItems = [
    { resource: "https://a.test/news", description: "Token news headlines", accepts: [usdc("1000")] },
    { resource: "https://b.test/honeypot", description: "Honeypot and rug-pull check for a token before you buy", accepts: [usdc("5000")] },
  ];
  const j = jev((d) => (d.startsWith("Honeypot") ? 3 : 0));
  const catalog = createCatalog({ url: "https://catalog.test/d", fetch: async () => Response.json({ items: catalogItems }), ranker: createRanker({ apiKey: "k", fetch: j.fetch, log: quiet }) });
  const best = await catalog.search("token");
  assert.deepEqual(best.results.map((r) => r.host), ["b.test", "a.test"]);
  assert.equal(best.results[0].relevance, 1);
  const cheap = await catalog.search("token", { sort: "cheap" });
  assert.deepEqual(cheap.results.map((r) => r.host), ["a.test", "b.test"]);
});
