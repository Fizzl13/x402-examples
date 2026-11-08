// The hosted exam end to end: a real HTTP server, agents paying with the official x402 client over HTTP, and the
// bench's two scripted agents as the examinees.

process.env.X402_BENCH_NETWORK = "base-sepolia";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";

const { createExamServer, examMessage, canonical, LIMITS } = await import("../src/exam/server.js");
const { memoryStore } = await import("../src/exam/store.js");
const { createWallet } = await import("../src/wallet.js");
const { SCRIPTED } = await import("../src/agents/scripted.js");
const { DOCTOR_HOST } = await import("../src/fizzl.js");

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

// A scripted bench agent taking a task over HTTP: its scenario plan's URLs are the scenario's own, so they are mapped to
// the exam's, and its calls to x402 Doctor go where the live Doctor forwards them for an exam address.
async function takeTask(agentName, exam, sitting) {
  const task = exam.exams.get(sitting.exam).task(sitting.taskId);
  const mapUrl = (raw) => {
    const u = new URL(raw);
    if (u.hostname === DOCTOR_HOST) {
      const q = new URLSearchParams();
      for (const [k, v] of u.searchParams) q.append(k, task.toExam(v));
      return `${task.prefix}/${DOCTOR_HOST}${u.pathname}?${q}`;
    }
    return task.toExam(raw);
  };
  const net = { fetch: (input, init) => fetch(mapUrl(String(input)), init) };
  const ledger = { signed() {}, signedData() {}, signedXrpl() {} };
  const wallet = createWallet({ world: net, ledger, privateKey: generatePrivateKey() });
  const tools = { run: async (_name, { method, url, headers, body }) => {
    const r = await net.fetch(url, { method, headers, body });
    return { status: r.status, body: await r.text() };
  } };
  const out = await SCRIPTED[agentName].run({ scenario: task.scenario, wallet, tools });
  return out.answer;
}

async function sit(agentName) {
  const { origin, exam } = await start();
  const res = await freeExam(origin, undefined, { name: agentName, version: "1" });
  assert.equal(res.status, 201);
  const sheet = await res.json();
  assert.equal(sheet.tasks.length, 19);
  for (const t of sheet.tasks) {
    const answer = await takeTask(agentName, exam, { exam: sheet.exam, taskId: t.id });
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
  // Every trap but wrong-data (Doctor only knows it as an info line); every honest task but the honest caution (a
  // mechanical rule refuses every caution).
  assert.deepEqual(good.tasks.filter((t) => t.kind === "trap" && !t.safe).map((t) => t.scenario), ["wrong-data"]);
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
