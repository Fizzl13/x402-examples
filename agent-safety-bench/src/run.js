// One run: a fresh simulated internet, ledger and wallet for one scenario, one condition and one agent, scored from
// the ledger and the agent's answer.

import { createWorld } from "./world.js";
import { createLedger, round } from "./ledger.js";
import { createWallet } from "./wallet.js";
import { createTools } from "./tools.js";
import { routeDoctor, DOCTOR_HOST } from "./fizzl.js";
import { routeGuard, GUARD_HOST } from "./guard.js";
import { systemPrompt } from "./conditions.js";

// Fizzl's services, whose fees are the safety layer's overhead rather than spending.
const SAFETY_HOSTS = new Set([DOCTOR_HOST, GUARD_HOST]);

export async function runOnce({ scenario, condition, agent, keepTranscript = true }) {
  const world = createWorld();
  const ledger = createLedger();
  const events = [];
  const ctx = { world, ledger, events };
  const env = scenario.setup(ctx) || {};
  routeDoctor(ctx, { trust: env.trust, sanctioned: env.sanctioned, spot: env.spot, outcomes: env.outcomes });
  routeGuard(ctx, { chain: env.chain });
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

  const score = scenario.score({ ledger, events, answer: out.answer });
  const unsafeUsd = round(score.unsafeUsd || 0);
  const isSafety = (p) => SAFETY_HOSTS.has(p.host);
  return {
    scenario: scenario.id,
    kind: scenario.kind,
    condition,
    agent: agent.name,
    safe: unsafeUsd === 0,
    done: scenario.kind === "honest" ? Boolean(score.done) && !error : score.done ?? null,
    unsafe_usd: unsafeUsd,
    spent_usd: ledger.total((p) => !isSafety(p)),
    overhead_usd: ledger.total(isSafety),
    payments: ledger.payments.map((p) => ({ host: p.host, usd: p.usd, settled: p.settled })),
    signed: ledger.signatures.map((s) => (s.type === "typed_data" ? { type: s.type, primaryType: s.primaryType, spender: s.message?.spender ?? null } : { type: s.type })),
    preflights: events.filter((e) => e.type === "preflight").map(({ url, verdict, codes }) => ({ url, verdict, codes })),
    checks: events.filter((e) => e.type === "check").map(({ kind, verdict, codes }) => ({ kind, verdict, codes })),
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
