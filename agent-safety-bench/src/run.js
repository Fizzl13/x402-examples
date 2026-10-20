// One run: a fresh simulated internet, ledger and wallet for one scenario, one condition and one agent, scored from
// the ledger and the agent's answer.

import { createWorld } from "./world.js";
import { createLedger, round } from "./ledger.js";
import { createWallet } from "./wallet.js";
import { createGuardedWallet } from "./guarded-wallet.js";
import { createTools } from "./tools.js";
import { routeDoctor, DOCTOR_HOST } from "./fizzl.js";
import { routeGuard, GUARD_HOST } from "./guard.js";
import { systemPrompt, taskEndpoints } from "./conditions.js";

// Fizzl's services, whose fees are the safety layer's overhead rather than spending.
const SAFETY_HOSTS = new Set([DOCTOR_HOST, GUARD_HOST]);
// The conditions with presign-guard-wallet in front of the key.
const GUARDED = new Set(["wallet", "skills-wallet"]);

// What a signature was, for the record: the allowance's spender, the delegation's contract and chain, the XRPL
// transaction's type (and those inside a Batch).
function signedSummary(s) {
  if (s.type === "typed_data") return { type: s.type, primaryType: s.primaryType, spender: s.message?.spender ?? null };
  if (s.type === "authorization") return { type: s.type, address: s.address, chainId: s.chainId };
  if (s.type === "xrpl") return { type: s.type, transactionType: s.tx.TransactionType, ...(s.tx.TransactionType === "Batch" && { inner: (s.tx.RawTransactions ?? []).map((r) => r?.RawTransaction?.TransactionType ?? null) }) };
  return { type: s.type };
}

export async function runOnce({ scenario, condition, agent, keepTranscript = true }) {
  const world = createWorld();
  const ledger = createLedger();
  const events = [];
  const ctx = { world, ledger, events };
  const env = scenario.setup(ctx) || {};
  const doctor = routeDoctor(ctx, { trust: env.trust, sanctioned: env.sanctioned, spot: env.spot, outcomes: env.outcomes });
  routeGuard(ctx, { chain: env.chain, sanctioned: env.sanctioned });
  // The data condition hands the agent Doctor's answers about the task's endpoints, asked before it starts.
  const given = condition === "data" ? await Promise.all(taskEndpoints(scenario.task).map((e) => doctor.ask(e.url, { method: e.method, maxUsd: scenario.budgetUsd }))) : null;
  // The wallet conditions put presign-guard-wallet in front of the key, with the task's budget as its spending limit.
  const wallet = GUARDED.has(condition) ? createGuardedWallet({ world, ledger, limitUsd: scenario.budgetUsd, direct: SAFETY_HOSTS }) : createWallet({ world, ledger });
  const tools = createTools({ world, wallet });

  const started = Date.now();
  let out = { answer: "", turns: 0 };
  let error = null;
  try {
    out = await agent.run({ scenario, system: agent.scripted ? null : systemPrompt(condition, { given }), task: scenario.task, tools, wallet });
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
    signed: ledger.signatures.map(signedSummary),
    preflights: events.filter((e) => e.type === "preflight").map(({ url, verdict, codes }) => ({ url, verdict, codes })),
    ...(given ? { given: given.map((g) => ({ url: g.url, method: g.method, trust: g.trust.status, verdict: g.preflight.verdict, codes: (g.preflight.reasons || []).map((x) => x.code) })) } : {}),
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
