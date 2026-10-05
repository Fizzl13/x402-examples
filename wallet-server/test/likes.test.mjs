// Likes on the Fizzl websites: only from a Fizzl origin, one per visitor per day, unlike undoes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../src/store.js";
import { createApp } from "../src/app.js";

test("a like counts once per visitor, unlike takes it back, other origins can't like", async () => {
  const store = memoryStore();
  const events = [];
  const usage = { enabled: true, record: (route, e) => events.push({ route, ...e }), flush: async () => {}, code: () => undefined };
  const accounts = new Proxy({}, { get: () => async () => null });
  const app = createApp({ accounts, auth: { middleware: () => (_q, _s, n) => n() }, usage, likes: store.global });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/public/likes`;
  const post = (origin, action, ua = "Mozilla/5.0") => fetch(base, { method: "POST", headers: { origin, "user-agent": ua, "content-type": "text/plain" }, body: JSON.stringify({ action }) });
  try {
    assert.deepEqual(await (await fetch(`${base}?site=fizzl.eu`)).json(), { site: "fizzl.eu", count: 0 });
    let r = await post("https://fizzl.eu", "like");
    assert.equal(r.headers.get("access-control-allow-origin"), "https://fizzl.eu");
    assert.deepEqual(await r.json(), { site: "fizzl.eu", count: 1, counted: true });
    assert.deepEqual(await (await post("https://fizzl.eu", "like")).json(), { site: "fizzl.eu", count: 1, counted: false });
    assert.equal((await (await post("https://fizzl.eu", "like", "Other browser")).json()).count, 2);
    assert.deepEqual(await (await post("https://fizzl.eu", "unlike")).json(), { site: "fizzl.eu", count: 1, counted: true });
    assert.equal((await (await post("https://fizzl.eu", "unlike")).json()).counted, false);
    assert.equal((await post("https://evil.test", "like")).status, 403);
    assert.equal((await (await post("https://fizzl.eu", "like", "Googlebot/2.1")).json()).counted, false);
    assert.equal((await (await post("https://lab.fizzl.eu", "like")).json()).count, 1); // per site
    assert.equal((await fetch(`${base}?site=evil.test`)).status, 404);
    assert.deepEqual(events.map((e) => e.route), ["like", "like", "unlike", "like"]);
    assert.equal(events[0].input.site, "fizzl.eu");
  } finally { server.close(); }
});
