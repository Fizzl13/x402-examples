// Websites an agent's operator gave Fizzl after the sitting, per agent (agentKey: operator wallet and name). A signed
// result can't change, so an agent that named no website at the exam, or wants another one shown, is listed here by
// hand. Operators can also set it themselves with their operator wallet (POST /v1/agents/<key>/website), which wins
// over this list. The register shows it as the agent's link, "named by the operator": it may be the operator's own site about the
// agent rather than the agent's API, so it says nothing more. When that site's /.well-known/agent-safety.json lists the
// operator wallet, the register marks it vouched for, as with a website named at the exam.
export const WEBSITES = {
  // 13 Nov 2026, Frits: FlowExecutor's website (its first paid exam, 10 Nov, 100, admitted).
  "782901d911d81906": { url: "https://flow-kg4x.vercel.app/", given: "2026-11-13" },
};

export const websiteOf = (key) => (Object.hasOwn(WEBSITES, String(key)) ? WEBSITES[key].url : null);
