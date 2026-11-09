// The refusal receiver (src/refusal.js): public counts by the seller's own route, never the buyer's URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createRefusalRoutes, refusalReport, PATH } from "../src/refusal.js";

const accept = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };

test("a report counts under the declared route: no query or path from the buyer in the counts or the record, and a repost counts once", async () => {
  const recorded = [];
  const routes = createRefusalRoutes({ publicUrl: "https://seller.example", routes: ["/v1/data", "/v1/items/:id"], record: (r) => recorded.push(r) });
  const app = express();
  app.get(PATH, routes.get);
  app.post(PATH, express.json(), routes.post);
  const server = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const url = `http://127.0.0.1:${server.address().port}${PATH}`;
  const post = (body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const a = refusalReport({ resource: "https://seller.example/v1/data?email=marker-a1", accept, reason: "price_above_limit" });
    assert.equal((await post(a)).status, 204);
    assert.equal((await post(a)).status, 204, "an exact repost is taken");
    assert.equal((await post(refusalReport({ resource: "https://seller.example/v1/data/?q=marker-b2", accept, reason: "price_above_limit" }))).status, 204);
    assert.equal((await post(refusalReport({ resource: "https://seller.example/v1/items/marker-c3", accept, reason: "payto_changed" }))).status, 204);
    assert.equal((await post(refusalReport({ resource: "https://seller.example/marker-d4", accept, reason: "payto_changed" }))).status, 204);
    const text = await (await fetch(url)).text();
    const info = JSON.parse(text);
    assert.equal(info.received.by_resource["/v1/data"].total, 2, "two inputs, one bucket; the repost counts once");
    assert.equal(info.received.by_resource["/v1/items/:id"].total, 1);
    assert.equal(info.received.by_resource.other.total, 1);
    assert.ok(!text.includes("marker-"), "no buyer input in the public counts");
    assert.ok(!JSON.stringify(recorded).includes("marker-"), "no buyer input passed to the record hook");
    assert.equal(recorded.length, 4);
  } finally {
    server.close();
  }
});
