#!/usr/bin/env node
// x402 Agent Safety Bench: run scenarios against an agent and print the tables.
//
//   node bin/bench.js --agent always-pay [--conditions wallet]
//   node bin/bench.js --agent follow-preflight
//   ANTHROPIC_API_KEY=… node bin/bench.js --agent claude --model <Claude model id>[,<another id>…] [--conditions bare,cautious,skills,wallet,skills-wallet,data] [--repeats 3]
//   OPENROUTER_API_KEY=… node bin/bench.js --agent openrouter --model <vendor/model>[,…]   (or --agent openai with OPENAI_API_KEY)
//   node bin/bench.js --report results/one.jsonl [results/two.jsonl …]

import { parseArgs } from "node:util";
import { mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pick } from "../src/scenarios/index.js";
import { CONDITIONS, taskEndpoints } from "../src/conditions.js";
import { SCRIPTED } from "../src/agents/scripted.js";
import { claudeAgent } from "../src/agents/claude.js";
import { openaiAgent, ENDPOINTS } from "../src/agents/openai.js";
import { runOnce } from "../src/run.js";
import { markdown } from "../src/report.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", default: "claude" },
    model: { type: "string" },
    conditions: { type: "string" },
    scenarios: { type: "string", default: "all" },
    repeats: { type: "string" },
    concurrency: { type: "string", default: "3" },
    thinking: { type: "string", default: "adaptive" },
    "max-turns": { type: "string", default: "20" },
    out: { type: "string" },
    report: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

if (values.report) {
  const records = positionals.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  console.log(markdown(records));
  process.exit(0);
}

const scripted = SCRIPTED[values.agent];
let agents;
if (scripted) agents = [scripted];
else if (values.agent === "claude") {
  if (!values.model) {
    console.error("--model is required for the claude agent (a Claude model id)");
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(2);
  }
  // Several models compare in one run: --model a,b,c.
  const models = [...new Set(values.model.split(",").map((m) => m.trim()).filter(Boolean))];
  agents = models.map((model) => claudeAgent({ model, thinking: values.thinking, maxTurns: Number(values["max-turns"]) }));
} else if (ENDPOINTS[values.agent]) {
  // Other vendors' models, through an endpoint that speaks OpenAI's Chat Completions format.
  const { keyEnv } = ENDPOINTS[values.agent];
  if (!values.model) {
    console.error(`--model is required for the ${values.agent} agent (a model id as ${values.agent} names it)`);
    process.exit(2);
  }
  if (!process.env[keyEnv]) {
    console.error(`${keyEnv} is not set`);
    process.exit(2);
  }
  const models = [...new Set(values.model.split(",").map((m) => m.trim()).filter(Boolean))];
  agents = models.map((model) => openaiAgent({ model, endpoint: values.agent, maxTurns: Number(values["max-turns"]) }));
} else {
  console.error(`unknown agent ${values.agent}; use claude, ${Object.keys(ENDPOINTS).join(", ")}, ${Object.keys(SCRIPTED).join(", ")}`);
  process.exit(2);
}

let scenarios;
try {
  scenarios = pick(values.scenarios);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
// A scripted agent has no prompt, so its only conditions are its own ("scripted") and the guarded wallet ("wallet").
const conditions = (values.conditions ?? (scripted ? "scripted" : Object.keys(CONDITIONS).join(","))).split(",").map((c) => c.trim());
for (const c of conditions) if (scripted ? !["scripted", "wallet"].includes(c) : !CONDITIONS[c]) {
  console.error(`unknown condition ${c}; use ${scripted ? "scripted, wallet" : Object.keys(CONDITIONS).join(", ")}`);
  process.exit(2);
}
const repeats = Number(values.repeats ?? (scripted ? 1 : 3));
// The data condition hands over Doctor's answers about the endpoints a task names. A signing task names only a site,
// so there it would be the bare prompt: those runs are left out.
const noData = scenarios.filter((s) => !taskEndpoints(s.task).length);
const jobs = [];
for (let i = 0; i < repeats; i++) for (const agent of agents) for (const condition of conditions) for (const scenario of scenarios) {
  if (condition === "data" && noData.includes(scenario)) continue;
  jobs.push({ agent, scenario, condition, repeat: i + 1 });
}

const label = agents.length === 1 ? agents[0].name : "claude-models";
const out = values.out || `results/${label.replace(/[^a-z0-9.-]+/gi, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
mkdirSync(dirname(out), { recursive: true });
const file = createWriteStream(out);
console.error(`${jobs.length} runs: ${scenarios.length} scenarios × ${conditions.length} condition(s) × ${agents.length} agent(s) × ${repeats} repeat(s), ${agents.map((a) => a.name).join(", ")} → ${out}`);
if (conditions.includes("data") && noData.length) console.error(`data: left out ${noData.map((s) => s.id).join(", ")} (no endpoint in the task)`);

const records = [];
let next = 0;
// An empty credit balance or a bad key fails every run after it: stop instead of recording them all as errors.
const FATAL = /credit balance is too low|invalid x-api-key|authentication_error|permission_error|HTTP 401|HTTP 402|insufficient_quota/i;
let stopped = null;
async function worker() {
  while (next < jobs.length && !stopped) {
    const job = jobs[next++];
    const record = { ...(await runOnce({ scenario: job.scenario, condition: job.condition, agent: job.agent })), repeat: job.repeat, at: new Date().toISOString() };
    records.push(record);
    file.write(`${JSON.stringify(record)}\n`);
    const verdict = record.error ? "error" : record.kind === "trap" ? (record.safe ? "safe" : `UNSAFE $${record.unsafe_usd}`) : (record.done ? "done" : "not done");
    console.error(`[${records.length}/${jobs.length}] ${agents.length > 1 ? `${job.agent.name} ` : ""}${job.condition} ${job.scenario.id} #${job.repeat}: ${verdict}${record.error ? ` (error: ${record.error})` : ""}`);
    if (record.error && FATAL.test(record.error)) stopped = record.error;
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
if (stopped) console.error(`Stopped after ${records.length} of ${jobs.length} runs: ${stopped}`);
await new Promise((resolve) => file.end(resolve));
console.log(markdown(records));
// A run cut short by a credit or key error measured nothing: fail, so a CI run shows red.
if (stopped) process.exitCode = 1;
