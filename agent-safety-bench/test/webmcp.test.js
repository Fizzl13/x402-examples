// The site's WebMCP tools (src/exam/webmcp.js): every page loads /webmcp.js, which registers five tools with the
// browser's model context. Here the script runs against a real exam server, with a stand-in for the browser's
// document.modelContext, and each tool is called the way a browser agent would call it.

process.env.X402_BENCH_NETWORK = "base-sepolia";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { generatePrivateKey } from "viem/accounts";

const { createExamServer } = await import("../src/exam/server.js");
const { memoryStore } = await import("../src/exam/store.js");

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start() {
  const holder = {};
  const http = (await import("node:http")).createServer((req, res) => holder.app(req, res));
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  servers.push(http);
  const origin = `http://127.0.0.1:${http.address().port}`;
  const exam = createExamServer({ origin, store: memoryStore(), signingKey: generatePrivateKey(), log: {}, twins: null });
  servers.push({ close: exam.close });
  holder.app = exam.app;
  return { origin };
}

// A page with the start form (or without it), and a model context that keeps what the script registers.
function browser(origin, { form = true, api = "registerTool" } = {}) {
  const fields = { agent: { value: "" }, version: { value: "" }, site: { value: "" } };
  for (const f of Object.values(fields)) f.dispatchEvent = () => true;
  let scrolled = false;
  const startform = { elements: { namedItem: (n) => fields[n] ?? null } };
  const elements = form ? { startform, take: { scrollIntoView: () => { scrolled = true; } } } : {};
  const tools = new Map();
  const modelContext = api === "registerTool"
    ? { registerTool(tool) { if (tools.has(tool.name)) throw new Error("taken"); tools.set(tool.name, tool); return Promise.resolve(); } }
    : { provideContext({ tools: list }) { for (const t of list) tools.set(t.name, t); } };
  const context = {
    document: { modelContext, getElementById: (id) => elements[id] ?? null },
    navigator: {},
    location: { origin },
    fetch: (path, init) => fetch(new URL(path, origin), init),
    AbortController,
    Event: class { constructor(type) { this.type = type; } },
    addEventListener() {},
  };
  return { context, tools, fields, scrolled: () => scrolled };
}

const textOf = (out) => out.content.map((c) => c.text).join("");

test("every page loads /webmcp.js; the script registers five tools, four of them read-only", async () => {
  const { origin } = await start();
  for (const path of ["/", "/register", "/find"]) assert.match(await (await fetch(origin + path)).text(), /<script src="\/webmcp\.js" defer><\/script>/, path);
  const res = await fetch(`${origin}/webmcp.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  const b = browser(origin);
  vm.runInNewContext(await res.text(), b.context);
  assert.deepEqual([...b.tools.keys()], ["exam_overview", "search_register", "find_agents_by_website", "get_exam_result", "prepare_exam_start"]);
  for (const t of b.tools.values()) {
    assert.ok(t.description.length > 80 && t.inputSchema?.type === "object" && typeof t.execute === "function", t.name);
    assert.equal(Boolean(t.annotations?.readOnlyHint), t.name !== "prepare_exam_start", t.name);
  }
  assert.match(await (await fetch(`${origin}/llms.txt`)).text(), /WebMCP: every page registers its tools/);
});

test("the homepage and llms.txt ask for new traps, with a prefilled GitHub issue", async () => {
  const { origin } = await start();
  const home = await (await fetch(`${origin}/`)).text();
  assert.match(home, /Suggest a trap/);
  assert.match(home, /href="https:\/\/github\.com\/Fizzl13\/x402-examples\/issues\/new\?title=Trap%20idea%3A%20&amp;body=/);
  assert.match(await (await fetch(`${origin}/llms.txt`)).text(), /\[Suggest a trap\]\(https:\/\/github\.com\/Fizzl13\/x402-examples\/issues\/new\?/);
});

test("the read-only tools answer from the public APIs; a bad id or a missing site is an error, not a throw", async () => {
  const { origin } = await start();
  const b = browser(origin);
  vm.runInNewContext(await (await fetch(`${origin}/webmcp.js`)).text(), b.context);
  const call = (name, input) => b.tools.get(name).execute(input, {});
  assert.match(textOf(await call("exam_overview", {})), /Agent Safety/);
  const reg = JSON.parse(textOf(await call("search_register", {})));
  assert.ok(Array.isArray(reg.admitted) && Array.isArray(reg.lapsed));
  assert.equal(reg.register, `${origin}/register`);
  const found = JSON.parse(textOf(await call("find_agents_by_website", { site: "example.com" })));
  assert.ok(Array.isArray(found.agents));
  assert.equal((await call("find_agents_by_website", {})).isError, true);
  assert.equal((await call("get_exam_result", { id: "nope" })).isError, true);
  await assert.rejects(call("get_exam_result", { id: "0".repeat(24) }), /no such result/);
});

test("prepare_exam_start fills in the form and scrolls to it; it never signs; on a page without the form it points home", async () => {
  const { origin } = await start();
  const js = await (await fetch(`${origin}/webmcp.js`)).text();
  const b = browser(origin);
  vm.runInNewContext(js, b.context);
  const out = await b.tools.get("prepare_exam_start").execute({ agent: "Shopper", version: "2", site: "https://shopper.example" }, {});
  assert.deepEqual([b.fields.agent.value, b.fields.version.value, b.fields.site.value], ["Shopper", "2", "https://shopper.example"]);
  assert.equal(b.scrolled(), true);
  assert.match(textOf(out), /signs one free message/);
  const elsewhere = browser(origin, { form: false });
  vm.runInNewContext(js, elsewhere.context);
  assert.match(textOf(await elsewhere.tools.get("prepare_exam_start").execute({ agent: "Shopper" }, {})), /#take/);
});

test("a browser without a model context: nothing happens; an older one with provideContext gets the same tools", async () => {
  const { origin } = await start();
  const js = await (await fetch(`${origin}/webmcp.js`)).text();
  assert.doesNotThrow(() => vm.runInNewContext(js, { document: {}, navigator: {}, location: { origin } }));
  const old = browser(origin, { api: "provideContext" });
  vm.runInNewContext(js, old.context);
  assert.equal(old.tools.size, 5);
});
