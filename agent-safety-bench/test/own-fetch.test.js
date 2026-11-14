// bin/exam-agent.js --fetch: a builder's own paying fetch in the payment path. The example module
// (examples/paying-fetch.example.mjs, the plain official x402 client) pays the exam's own sellers on Base Sepolia, and
// refuses with a code the agent sees. The model loop itself is the same as the other modes and isn't run here.

process.env.X402_BENCH_NETWORK = "base-sepolia";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const { createExamServer } = await import("../src/exam/server.js");
const { memoryStore } = await import("../src/exam/store.js");
const createPayingFetch = (await import("../examples/paying-fetch.example.mjs")).default;

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

const json = { "content-type": "application/json" };
const firstUrl = (text) => String(text).match(/https?:\/\/[^\s)"'`]+/)[0].replace(/[.,;:]+$/, "");

test("the example paying fetch pays the exam's sellers itself and refuses an over-budget price with a code", async () => {
  const { origin } = await start();
  const op = privateKeyToAccount(generatePrivateKey());
  const agent = { name: "own-fetch test", version: "1" };
  const m = await (await fetch(`${origin}/v1/exams/message?agent=${encodeURIComponent(agent.name)}&version=1&operator=${op.address}`)).json();
  const sheet = await (await fetch(`${origin}/v1/exams`, { method: "POST", headers: json, body: JSON.stringify({ agent, operator: op.address, signature: await op.signMessage({ message: m.message }) }) })).json();
  assert.ok(sheet.tasks.length > 10);

  const privateKey = generatePrivateKey();
  const outcomes = { paid: 0, refused: [] };
  for (const t of sheet.tasks) {
    const payingFetch = createPayingFetch({ account: privateKeyToAccount(privateKey), privateKey, network: "eip155:84532", task: t.task, budgetUsd: Number(t.budget_usd) });
    try {
      const r = await payingFetch(firstUrl(t.task), { method: "GET" });
      if (r.ok) outcomes.paid++;
    } catch (err) {
      outcomes.refused.push(err.code);
    }
  }
  assert.ok(outcomes.paid >= 5, `paid and answered: ${outcomes.paid}`);
  assert.ok(outcomes.refused.includes("over_budget"), `refusals: ${outcomes.refused.join(", ")}`);
});

test("exam-agent --fetch loads the module, names the agent after it, and refuses to mix with the Fizzl modes", async () => {
  const run = promisify(execFile);
  const bin = new URL("../bin/exam-agent.js", import.meta.url).pathname;
  const mod = new URL("../examples/paying-fetch.example.mjs", import.meta.url).pathname;
  const { stdout } = await run(process.execPath, [bin, "--model", "claude-haiku-5-5", "--fetch", mod, "--name", "My agent + MyGuard", "--dry"]);
  assert.match(stdout, /agent My agent \+ MyGuard/);
  assert.match(stdout, /tools http_request, pay_and_request/);
  await assert.rejects(run(process.execPath, [bin, "--model", "m", "--fetch", mod, "--safe-fetch", "--dry"]), /leave out --safe-fetch/);
});
