// One run: a fresh simulated internet, ledger and wallet for one scenario, one condition and one agent, scored from
// the ledger and the agent's answer.

import { createWorld } from "./world.js";
import { createLedger, round } from "./ledger.js";
import { createWallet } from "./wallet.js";
import { createTools } from "./tools.js";
import { routeDoctor, DOCTOR_HOST } from "./fizzl.js";
import { systemPrompt } from "./conditions.js";

export async function runOnce({ scenario, condition, agent, keepTranscript = true }) {
  const world = createWorld();
  const ledger = createLedger();
  const events = [];
  const ctx = { world, ledger, events };
  const env = scenario.setup(ctx) || {};
  routeDoctor(ctx, { trust: env.trust, sanctioned: env.sanctioned, spot: env.spot, outcomes: env.outcomes });
  const wallet = createWallet({ world, ledger });
  const tools = createTools({ world, wallet });

  const started = Date.now();
  let out = { answer: "", turns: 0 };
  let error = null;
  try {
    out = await agent.run({ scenario, system: agent.scripted ? null : systemPrompt(condition), task: scenario.task, tools, wallet });
  } catch (err) {
    error = err.message || String(err);
  }
  const ms = Date.now() - started;

  const score = scenario.score({ ledger, answer: out.answer });
  const unsafeUsd = round(score.unsafeUsd || 0);
  const isDoctor = (p) => p.host === DOCTOR_HOST;
  return {
    scenario: scenario.id,
    kind: scenario.kind,
    condition,
    agent: agent.name,
    safe: unsafeUsd === 0,
    done: scenario.kind === "honest" ? Boolean(score.done) && !error : score.done ?? null,
    unsafe_usd: unsafeUsd,
    spent_usd: ledger.total((p) => !isDoctor(p)),
    overhead_usd: ledger.total(isDoctor),
    payments: ledger.payments.map((p) => ({ host: p.host, usd: p.usd, settled: p.settled })),
    preflights: events.filter((e) => e.type === "preflight").map(({ url, verdict, codes }) => ({ url, verdict, codes })),
    outcomes_reported: events.filter((e) => e.type === "outcome").length,
    turns: out.turns ?? 0,
    stop: out.stop ?? null,
    usage: out.usage ?? null,
    error,
    ms,
    answer: String(out.answer || "").slice(0, 4000),
    ...(keepTranscript && out.transcript ? { transcript: out.transcript } : {}),
  };
}
