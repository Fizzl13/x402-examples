// Turns run records into the tables in the README: per agent and condition, and per scenario.

import { round } from "./ledger.js";
import { SCENARIOS } from "./scenarios/index.js";

const key = (r) => `${r.agent} · ${r.condition}`;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const usd = (n) => `$${round(n).toFixed(n >= 1 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "")}`;

export function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(key(r))) groups.set(key(r), []);
    groups.get(key(r)).push(r);
  }
  return [...groups.entries()].map(([name, rs]) => {
    // A run that ended in an error (an API error, say) did not test the agent: it counts in neither rate.
    const scored = rs.filter((r) => !r.error);
    const traps = scored.filter((r) => r.kind === "trap");
    const honest = scored.filter((r) => r.kind === "honest");
    const tokens = rs.reduce((s, r) => s + (r.usage ? r.usage.input_tokens + r.usage.output_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens : 0), 0);
    return {
      name,
      runs: rs.length,
      errors: rs.filter((r) => r.error).length,
      traps_safe: traps.filter((r) => r.safe).length,
      traps: traps.length,
      honest_done: honest.filter((r) => r.done).length,
      honest: honest.length,
      unsafe_usd: round(rs.reduce((s, r) => s + r.unsafe_usd, 0)),
      overhead_usd: round(rs.reduce((s, r) => s + r.overhead_usd, 0)),
      tokens,
    };
  });
}

export function markdown(records) {
  const lines = [];
  lines.push("| Agent · condition | Traps avoided | Honest tasks done | Unsafe spend | Safety overhead | Runs | Errors |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of summarize(records)) {
    lines.push(`| ${s.name} | ${s.traps_safe}/${s.traps} (${pct(s.traps_safe, s.traps)}) | ${s.honest_done}/${s.honest} (${pct(s.honest_done, s.honest)}) | ${usd(s.unsafe_usd)} | ${usd(s.overhead_usd)} | ${s.runs} | ${s.errors} |`);
  }

  const names = [...new Set(records.map(key))];
  const order = (id) => {
    const i = SCENARIOS.findIndex((s) => s.id === id);
    return i === -1 ? SCENARIOS.length : i;
  };
  const scenarios = [...new Set(records.map((r) => r.scenario))].sort((a, b) => order(a) - order(b));
  lines.push("");
  lines.push(`| Scenario | ${names.join(" | ")} |`);
  lines.push(`|---|${names.map(() => "---").join("|")}|`);
  for (const id of scenarios) {
    const cells = names.map((n) => {
      const all = records.filter((r) => r.scenario === id && key(r) === n);
      if (!all.length) return "";
      const rs = all.filter((r) => !r.error);
      const errors = all.length - rs.length;
      const kind = all[0].kind;
      const ok = kind === "trap" ? rs.filter((r) => r.safe).length : rs.filter((r) => r.done).length;
      const lost = round(all.reduce((s, r) => s + r.unsafe_usd, 0));
      return `${ok}/${rs.length} ${kind === "trap" ? "safe" : "done"}${lost ? `, ${usd(lost)} lost` : ""}${errors ? `, ${errors} error${errors > 1 ? "s" : ""}` : ""}`;
    });
    lines.push(`| \`${id}\` (${records.find((r) => r.scenario === id).kind}) | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
