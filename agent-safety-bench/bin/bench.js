#!/usr/bin/env node
// x402 Agent Safety Bench: run scenarios against an agent and print the tables.
//
//   node bin/bench.js --agent always-pay
//   node bin/bench.js --agent follow-preflight
//   ANTHROPIC_API_KEY=… node bin/bench.js --agent claude --model <Claude model id> [--conditions bare,cautious,skills] [--repeats 3]
//   node bin/bench.js --report results/one.jsonl [results/two.jsonl …]

import { parseArgs } from "node:util";
import { mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pick } from "../src/scenarios/index.js";
import { CONDITIONS } from "../src/conditions.js";
import { SCRIPTED } from "../src/agents/scripted.js";
import { claudeAgent } from "../src/agents/claude.js";
import { runOnce } from "../src/run.js";
import { markdown } from "../src/report.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", default: "claude" },
    model: { type: "string" },
    conditions: { type: "string", default: Object.keys(CONDITIONS).join(",") },
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
let agent;
if (scripted) agent = scripted;
else if (values.agent === "claude") {
  if (!values.model) {
    console.error("--model is required for the claude agent (a Claude model id)");
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(2);
  }
  agent = claudeAgent({ model: values.model, thinking: values.thinking, maxTurns: Number(values["max-turns"]) });
} else {
  console.error(`unknown agent ${values.agent}; use claude, ${Object.keys(SCRIPTED).join(", ")}`);
  process.exit(2);
}

let scenarios;
try {
  scenarios = pick(values.scenarios);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const conditions = scripted ? ["scripted"] : values.conditions.split(",").map((c) => c.trim());
for (const c of conditions) if (!scripted && !CONDITIONS[c]) {
  console.error(`unknown condition ${c}; use ${Object.keys(CONDITIONS).join(", ")}`);
  process.exit(2);
}
const repeats = Number(values.repeats ?? (scripted ? 1 : 3));
const jobs = [];
for (let i = 0; i < repeats; i++) for (const condition of conditions) for (const scenario of scenarios) jobs.push({ scenario, condition, repeat: i + 1 });

const out = values.out || `results/${agent.name.replace(/[^a-z0-9.-]+/gi, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
mkdirSync(dirname(out), { recursive: true });
const file = createWriteStream(out);
console.error(`${jobs.length} runs: ${scenarios.length} scenarios × ${conditions.length} condition(s) × ${repeats} repeat(s), agent ${agent.name} → ${out}`);

const records = [];
let next = 0;
// An empty credit balance or a bad key fails every run after it: stop instead of recording them all as errors.
const FATAL = /credit balance is too low|invalid x-api-key|authentication_error|permission_error/i;
let stopped = null;
async function worker() {
  while (next < jobs.length && !stopped) {
    const job = jobs[next++];
    const record = { ...(await runOnce({ scenario: job.scenario, condition: job.condition, agent })), repeat: job.repeat, at: new Date().toISOString() };
    records.push(record);
    file.write(`${JSON.stringify(record)}\n`);
    const verdict = record.kind === "trap" ? (record.safe ? "safe" : `UNSAFE $${record.unsafe_usd}`) : (record.done ? "done" : "not done");
    console.error(`[${records.length}/${jobs.length}] ${job.condition} ${job.scenario.id} #${job.repeat}: ${verdict}${record.error ? ` (error: ${record.error})` : ""}`);
    if (record.error && FATAL.test(record.error)) stopped = record.error;
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
if (stopped) console.error(`Stopped after ${records.length} of ${jobs.length} runs: ${stopped}`);
await new Promise((resolve) => file.end(resolve));
console.log(markdown(records));
// A run cut short by a credit or key error measured nothing: fail, so a CI run shows red.
if (stopped) process.exitCode = 1;
