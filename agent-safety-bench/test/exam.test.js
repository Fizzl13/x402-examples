// The hosted exam end to end: a real HTTP server, agents paying with the official x402 client over HTTP, and the
// bench's two scripted agents as the examinees.

process.env.X402_BENCH_NETWORK = "base-sepolia";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";

const { createExamServer, examMessage, canonical, LIMITS } = await import("../src/exam/server.js");
const { memoryStore } = await import("../src/exam/store.js");

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start(opts = {}) {
  const holder = {};
  const store = opts.store || memoryStore();
  // The origin is only known once the port is: build the app lazily behind a forwarding handler.
  const http = (await import("node:http")).createServer((req, res) => holder.app(req, res));
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  servers.push(http);
  const origin = `http://127.0.0.1:${http.address().port}`;
  const exam = createExamServer({ origin, store, signingKey: generatePrivateKey(), log: {}, ...opts });
  servers.push({ close: exam.close });
  holder.app = exam.app;
  return { origin, exam, store };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function freeExam(origin, operatorKey = generatePrivateKey(), agent = { name: "test-agent", version: "1" }) {
  const op = privateKeyToAccount(operatorKey);
  const m = await (await fetch(`${origin}/v1/exams/message?agent=${encodeURIComponent(agent.name)}&version=${agent.version}&operator=${op.address}`)).json();
  const signature = await op.signMessage({ message: m.message });
  return post(`${origin}/v1/exams`, { agent, operator: op.address, signature });
}

const { takeTask, sitAsReference, REFERENCES } = await import("../src/exam/reference.js");

async function sit(agentName) {
  const { origin, exam } = await start();
  const res = await freeExam(origin, undefined, { name: agentName, version: "1" });
  assert.equal(res.status, 201);
  const sheet = await res.json();
  assert.equal(sheet.tasks.length, 19);
  for (const t of sheet.tasks) {
    const answer = await takeTask(agentName, exam.exams.get(sheet.exam).task(t.id));
    const a = await post(`${origin}/v1/exams/${sheet.exam}/answers`, { task: t.id, answer: answer ?? "" });
    assert.equal(a.status, 200);
  }
  const result = await (await post(`${origin}/v1/exams/${sheet.exam}/finish`, {})).json();
  return { origin, sheet, result };
}

test("the sheet hides which tasks are traps and points at exam addresses only", async () => {
  const { origin } = await start();
  const sheet = await (await freeExam(origin)).json();
  const text = JSON.stringify(sheet.tasks);
  assert.ok(!/\.example\b/.test(text), "no scenario host leaks into the sheet");
  assert.ok(sheet.tasks.every((t) => /^t\d+$/.test(t.id) && !("kind" in t)));
  assert.ok(text.includes(`${origin}/e/${sheet.exam}/`));
});

test("follow-preflight passes the exam over HTTP; always-pay does not", async () => {
  const good = (await sit("follow-preflight")).result;
  assert.equal(good.traps.of, 14);
  assert.equal(good.honest.of, 5);
  // Every trap (wrong data is a caution since x402-doctor#561); every honest task but the honest caution (a mechanical
  // rule refuses every caution).
  assert.deepEqual(good.tasks.filter((t) => t.kind === "trap" && !t.safe).map((t) => t.scenario), []);
  assert.deepEqual(good.tasks.filter((t) => t.kind === "honest" && !t.done).map((t) => t.scenario), ["honest-caution"]);
  assert.equal(good.admitted, true);
  assert.ok(good.checks_usd > 0);

  const bad = await sit("always-pay");
  assert.equal(bad.result.admitted, false);
  assert.ok(bad.result.traps.avoided <= 2, JSON.stringify(bad.result.traps));
  assert.ok(bad.result.lost_usd > 1);

  // Signed, and in the index.
  const { signature, signer, details, ...record } = bad.result;
  assert.ok(await verifyMessage({ address: signer, message: canonical(record), signature }));
  const index = await (await fetch(`${bad.origin}/v1/index`)).json();
  assert.equal(index.agents.length, 1);
  assert.equal(index.agents[0].admitted, false);
  const page = await (await fetch(`${bad.origin}/`)).text();
  assert.ok(page.includes("always-pay"));
  const badge = await (await fetch(`${bad.origin}/badge/${bad.result.id}.svg`)).text();
  assert.ok(badge.includes("not admitted"));
});

test("the first exam per wallet is free; the next asks $0.10 over x402, and the fee pays for one exam", async () => {
  const settled = [];
  const facilitator = {
    verify: async (p) => (p?.payload?.authorization?.value === "100000" ? { valid: true, payer: p.payload.authorization.from } : { valid: false, reason: "wrong amount" }),
    settle: async (p) => {
      settled.push(p);
      return { settled: true, transaction: `0x${"ab".repeat(32)}` };
    },
  };
  const { origin } = await start({ facilitator });
  const key = generatePrivateKey();
  assert.equal((await freeExam(origin, key)).status, 201);
  const again = await freeExam(origin, key);
  assert.equal(again.status, 402);
  const challenge = JSON.parse(Buffer.from(again.headers.get("payment-required"), "base64").toString());
  assert.equal(challenge.accepts[0].amount, "100000");
  assert.equal(challenge.accepts[0].network, "eip155:8453");

  // Paid with the official x402 client, from the operator's wallet (mainnet USDC; the facilitator here is a stand-in).
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const http = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(key)) }] }));
  const payload = await http.createPaymentPayload(http.getPaymentRequiredResponse((n) => again.headers.get(n)));
  const paid = await post(`${origin}/v1/exams`, { agent: { name: "test-agent", version: "2" } }, http.encodePaymentSignatureHeader(payload));
  assert.equal(paid.status, 201, await paid.clone().text());
  assert.equal((await paid.json()).operator, privateKeyToAccount(key).address);
  assert.equal(settled.length, 1);
});

test("a free exam needs the operator's signature, and free exams are limited per IP", async () => {
  const { origin } = await start();
  const op = privateKeyToAccount(generatePrivateKey());
  const unsigned = await post(`${origin}/v1/exams`, { agent: { name: "x", version: "1" }, operator: op.address });
  assert.equal(unsigned.status, 401);
  const other = privateKeyToAccount(generatePrivateKey());
  const forged = await post(`${origin}/v1/exams`, { agent: { name: "x", version: "1" }, operator: op.address, signature: await other.signMessage({ message: examMessage({ name: "x", version: "1", operator: op.address, date: new Date().toISOString().slice(0, 10) }) }) });
  assert.equal(forged.status, 401);
  for (let i = 0; i < LIMITS.freePerIpPerDay; i++) assert.equal((await freeExam(origin)).status, 201);
  assert.equal((await freeExam(origin)).status, 429);
});

test("reference rows: the scripted agents sit in-process, marked reference, listed after real agents", async () => {
  const { origin, exam } = await start();
  const r = await sitAsReference("follow-preflight", { origin, exams: exam.exams, startSitting: exam.startReference });
  assert.equal(r.reference, true);
  assert.equal(r.operator, null);
  assert.equal(r.agent.name, REFERENCES["follow-preflight"].name);
  assert.equal(r.admitted, true);
  assert.equal((await freeExam(origin)).status, 201); // a real sitting, unfinished: not in the index yet
  const page = await (await fetch(`${origin}/`)).text();
  assert.ok(page.includes("reference"));
});

test("a reference row sat with other pinned code is replaced in the index, not listed next to the new one", async () => {
  const { origin, exam } = await start();
  const ref = REFERENCES["follow-preflight"];
  assert.match(ref.version, /^bench-[0-9a-f]{7}-[0-9a-f]{7}$/, "the version names the pinned Doctor and presign-guard commits");
  const old = await sitAsReference("follow-preflight", { origin, exams: exam.exams, startSitting: () => exam.startReference({ ...ref, version: "bench" }) });
  assert.equal(old.agent.version, "bench");
  const fresh = await sitAsReference("follow-preflight", { origin, exams: exam.exams, startSitting: exam.startReference });
  const rows = (await (await fetch(`${origin}/v1/index`)).json()).agents.filter((a) => a.reference && a.agent.name === ref.name);
  assert.deepEqual(rows.map((a) => a.agent.version), [ref.version]);
  assert.equal(rows[0].score, fresh.score);
});

test("agent.url: only an https address is accepted, and the index links it", async () => {
  const { agentUrlOf } = await import("../src/exam/server.js");
  assert.deepEqual(agentUrlOf(undefined), { url: null });
  assert.deepEqual(agentUrlOf("https://my-agent.example/about"), { url: "https://my-agent.example/about" });
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "http://my-agent.example", "https://user:pw@my-agent.example", "https://localhost", "https://a.example/\"><script>", `https://a.example/${"x".repeat(200)}`, "my-agent.example"]) {
    assert.ok(agentUrlOf(bad).error, bad);
  }

  const { origin } = await start();
  const refused = await freeExam(origin, undefined, { name: "linked", version: "1", url: "javascript:alert(1)" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /https/);
  const ok = await freeExam(origin, undefined, { name: "linked", version: "1", url: "https://my-agent.example" });
  assert.equal(ok.status, 201);
  const sheet = await ok.json();
  await post(`${origin}/v1/exams/${sheet.exam}/finish`, {});
  const page = await (await fetch(`${origin}/`)).text();
  assert.ok(page.includes(`href="https://my-agent.example/" rel="nofollow ugc noopener" target="_blank">my-agent.example</a>`));
  assert.ok(!page.includes("javascript:"));
});

test("EXAM_SIGNING_KEY: with or without 0x, spaces or quotes; a wrong one leaves results unsigned instead of stopping the server", async () => {
  const { signerFrom } = await import("../src/exam/server.js");
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const quiet = { error() {} };
  assert.equal(signerFrom(key, quiet).address, address);
  assert.equal(signerFrom(key.slice(2), quiet).address, address);
  assert.equal(signerFrom(`  "${key.toUpperCase().replace("0X", "0x")}" \n`, quiet).address, address);
  const said = [];
  assert.equal(signerFrom("not a key", { error: (m) => said.push(m) }), null);
  assert.match(said[0], /not a private key/);
  assert.ok(!said[0].includes("not a key"), "the log never repeats the value");
  assert.equal(signerFrom("", quiet), null);
  const { origin } = await start({ signingKey: "abc" });
  assert.equal((await (await fetch(`${origin}/health`)).json()).signer, null);
});

test("redis store (REDIS_TEST_URL): the free-exam rule, counters and the index survive a new server", { skip: !process.env.REDIS_TEST_URL }, async () => {
  const { redisStore } = await import("../src/exam/store.js");
  const prefix = `exam-test-${Date.now()}:`;
  const store = await redisStore(process.env.REDIS_TEST_URL, { prefix });
  assert.equal(await store.setOnce("free:0xabc", { date: "2026-11-08" }), true);
  assert.equal(await store.setOnce("free:0xabc", { date: "2026-11-09" }), false);
  assert.deepEqual(await store.get("free:0xabc"), { date: "2026-11-08" });
  assert.equal(await store.incr("ip:1", 60), 1);
  assert.equal(await store.incr("ip:1", 60), 2);
  const first = await start({ store });
  const r = await sitAsReference("always-pay", { origin: first.origin, exams: first.exam.exams, startSitting: first.exam.startReference });
  // A new server on the same Redis lists the result.
  const again = await redisStore(process.env.REDIS_TEST_URL, { prefix });
  const second = await start({ store: again });
  const index = await (await fetch(`${second.origin}/v1/index`)).json();
  await store.close();
  await again.close();
  assert.deepEqual(index.agents.map((a) => a.id), [r.id]);
});

test("live view: a watch link shows every request and answer, never the exam id; verdicts only for references", async () => {
  const { origin, exam } = await start();
  const sheet = await (await freeExam(origin)).json();
  const w = sheet.watch.split("/live/")[1];
  assert.match(w, /^[0-9a-f]{18}$/);
  // The order of the tasks is random: take one whose seller answers a plain GET (the summary task takes a POST).
  const t = sheet.tasks.find((x) => !/\bPOST\b/.test(x.task));
  const url = t.task.match(/https?:\/\/\S+?\/e\/\S+?(?=[\s)]|$)/)[0].replace(/[.,;]$/, "");
  assert.equal((await fetch(url)).status, 402);
  await post(`${origin}/v1/exams/${sheet.exam}/answers`, { task: t.id, answer: "refused" });
  const snap = await (await fetch(`${origin}/v1/watch/${w}`)).json();
  assert.ok(!JSON.stringify(snap).includes(sheet.exam), "the live view never shows the exam id");
  assert.deepEqual(snap.events.map((e) => e.type), ["start", "request", "answer"]);
  assert.equal(snap.events[1].status, 402);
  assert.ok(snap.events[1].ask.usd > 0);
  assert.equal(snap.events[2].verdict, undefined, "a real examinee's verdicts wait for the finish");
  assert.equal((await fetch(`${origin}/live/${w}`)).status, 200);
  const live = await (await fetch(`${origin}/v1/live`)).json();
  assert.ok(live.live.some((l) => l.watch === w));
  assert.ok(!JSON.stringify(live).includes(sheet.exam));

  // The stream replays what happened so far and ends at the finish.
  const streamed = fetch(`${origin}/v1/watch/${w}/stream`).then((r) => r.text());
  await new Promise((r) => setTimeout(r, 50));
  await post(`${origin}/v1/exams/${sheet.exam}/finish`, {});
  const text = await streamed;
  const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(events.at(-1).type, "finish");
  assert.equal(events.at(-1).result.tasks.length, 19);
  assert.ok(!text.includes(sheet.exam) || events.at(-1).result.id === sheet.exam);

  // A reference sitting shows each verdict as it is answered, and its replay is stored with the result.
  const r = await sitAsReference("follow-preflight", { origin, exams: exam.exams, startSitting: exam.startReference });
  const replay = await (await fetch(`${origin}/v1/replay/${r.id}`)).json();
  const answers = replay.events.filter((e) => e.type === "answer");
  assert.equal(answers.length, 19);
  assert.ok(answers.every((e) => e.verdict && typeof e.verdict.safe === "boolean"));
  assert.ok(replay.events.some((e) => e.type === "request" && e.to === "doctor" && e.verdict));
  assert.ok(!JSON.stringify(replay.events.filter((e) => e.type !== "finish")).includes(r.id));
  assert.equal((await fetch(`${origin}/r/${r.id}`)).status, 200);
});

test("findable: MCP tools (check, index, how-to, demo), server card, llms.txt, robots, sitemap, share image", async () => {
  const { origin, exam } = await start({ demoPace: 0 });
  const r = await sitAsReference("follow-preflight", { origin, exams: exam.exams, startSitting: exam.startReference });
  const rpc = async (method, params, id = 1) => (await post(`${origin}/mcp`, { jsonrpc: "2.0", id, method, params }, { accept: "application/json, text/event-stream" })).json();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "agent-safety-exam");
  assert.equal((await post(`${origin}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(tools, ["agent_safety_check", "agent_safety_index", "agent_safety_exam_howto", "agent_safety_demo"]);
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const found = (await call("agent_safety_check", { agent: "doctor's go" })).structuredContent;
  assert.equal(found.found, true);
  assert.equal(found.admitted, true);
  assert.equal(found.replay, `${origin}/r/${r.id}`);
  assert.equal((await call("agent_safety_check", { result_id: r.id })).structuredContent.signature, r.signature);
  assert.equal((await call("agent_safety_check", { agent: "nobody" })).structuredContent.found, false);
  assert.equal((await call("agent_safety_check", {})).isError, true);
  assert.equal((await call("agent_safety_index", { admitted_only: true })).structuredContent.agents.length, 1);
  const op = privateKeyToAccount(generatePrivateKey()).address;
  const how = (await call("agent_safety_exam_howto", { agent: "my-agent", operator: op })).structuredContent;
  assert.equal(how.message_to_sign, examMessage({ name: "my-agent", version: "1", operator: op, date: new Date().toISOString().slice(0, 10) }));
  assert.equal(how.free_exam_available, true);
  const demo = (await call("agent_safety_demo", { agent: "always-pay" })).structuredContent;
  assert.match(demo.watch_live, /\/live\/[0-9a-f]{18}$/);
  assert.equal((await rpc("nope")).error.code, -32601);
  assert.equal((await fetch(`${origin}/mcp`)).status, 405);

  const card = await (await fetch(`${origin}/.well-known/mcp/server-card.json`)).json();
  assert.equal(card.tools.length, 4);
  const llms = await (await fetch(`${origin}/llms.txt`)).text();
  assert.match(llms, /^# Agent Safety Index/);
  assert.ok(llms.includes(`${origin}/mcp`));
  assert.match(await (await fetch(`${origin}/robots.txt`)).text(), /Disallow: \/e\//);
  assert.ok((await (await fetch(`${origin}/sitemap.xml`)).text()).includes(`${origin}/r/${r.id}`));
  const og = await fetch(`${origin}/og.png`);
  assert.equal(og.headers.get("content-type"), "image/png");
  assert.ok((await og.arrayBuffer()).byteLength > 10_000);
  const font = await fetch(`${origin}/fonts/unbounded-latin-800-normal.woff2`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get("cache-control"), /immutable/);
  const page = await (await fetch(`${origin}/`)).text();
  assert.ok(page.includes("application/ld+json") && page.includes("og:image"));
});

test("demo: a scripted agent sits an exam to watch; it is never stored or listed in the index", async () => {
  const { origin, exam } = await start({ demoPace: 0 });
  const res = await post(`${origin}/v1/demo`, { agent: "always-pay" });
  assert.equal(res.status, 201);
  const { page } = await res.json();
  const w = page.split("/live/")[1];
  let snap;
  for (let i = 0; i < 100; i++) {
    snap = await (await fetch(`${origin}/v1/watch/${w}`)).json();
    if (snap.finished) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(snap.finished, true);
  assert.ok(snap.demo);
  const fin = snap.events.find((e) => e.type === "finish");
  assert.equal(fin.result.admitted, false);
  assert.equal(fin.result.id, null);
  assert.equal((await (await fetch(`${origin}/v1/index`)).json()).agents.length, 0);
  assert.ok([...exam.exams.values()].every((e) => e.meta.demo));
});

test("usage log: exams, refusals, finishes, demos, pages and MCP calls, anonymous, into events/exam/<day>/<HH>.jsonl", async () => {
  const { createUsage } = await import("../src/exam/usage.js");
  const files = new Map();
  const fakeGitHub = async (url, init = {}) => {
    const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1]);
    if (!init.method) return files.has(path) ? new Response(JSON.stringify({ sha: "x", content: Buffer.from(files.get(path)).toString("base64") }), { status: 200 }) : new Response("{}", { status: 404 });
    files.set(path, Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8"));
    return new Response("{}", { status: 201 });
  };
  const opKey = generatePrivateKey();
  const usage = createUsage({ token: "t", salt: "s", ownWallets: [], fetch: fakeGitHub, batchMs: 0, log: {} });
  const { origin } = await start({ usage, demoPace: 0 });
  const sheet = await (await freeExam(origin, opKey)).json();
  assert.equal((await freeExam(origin, opKey)).status, 402); // the free exam is used: a refusal
  await post(`${origin}/v1/exams/${sheet.exam}/finish`, {});
  await fetch(`${origin}/`);
  await post(`${origin}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_safety_index", arguments: {} } });
  await post(`${origin}/v1/demo`, { agent: "always-pay" });
  for (let i = 0; i < 40 && ![...files.values()].join("").includes('"demo"'); i++) await new Promise((r) => setTimeout(r, 25));
  await usage.flush();
  const paths = [...files.keys()];
  assert.ok(paths.every((p) => /^events\/exam\/\d{4}-\d{2}-\d{2}\/\d{2}\.jsonl$/.test(p)), paths.join());
  const events = [...files.values()].join("").trim().split("\n").map((l) => JSON.parse(l));
  const by = (route) => events.filter((e) => e.route === route);
  assert.equal(by("exam started")[0].input.kind, "free");
  assert.equal(by("exam refused")[0].input.reason, "free exam used");
  assert.equal(by("exam finished")[0].input.kind, "free");
  assert.equal(typeof by("exam finished")[0].result.score, "number");
  assert.ok(by("page").some((e) => e.input.page === "index"));
  assert.ok(by("mcp").some((e) => e.input.tool === "agent_safety_index"));
  assert.equal(by("demo")[0].input.agent, "always-pay");
  // Anonymous: no operator address, no IP, no exam id.
  const text = JSON.stringify(events);
  assert.ok(!text.toLowerCase().includes(privateKeyToAccount(opKey).address.toLowerCase().slice(2)));
  assert.ok(!text.includes("127.0.0.1") && !text.includes(sheet.exam));
  assert.ok(events.every((e) => e.service === "exam" && (!e.visitor || /^[0-9a-f]{12}$/.test(e.visitor))));
});
