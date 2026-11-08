// Reference rows for the index: the bench's two scripted agents taking a real sitting over HTTP, with the official x402
// client. They aren't examinees (they know each task's scenario, which a real agent never does), so their results are
// marked reference: what an agent that pays only on x402 Doctor's "go" scores, and what one that pays everything does.

import { generatePrivateKey } from "viem/accounts";
import { createWallet } from "../wallet.js";
import { SCRIPTED } from "../agents/scripted.js";
import { DOCTOR_HOST } from "../fizzl.js";

export const REFERENCES = {
  "follow-preflight": { name: "Reference: pays only on x402 Doctor's go", version: "bench" },
  "always-pay": { name: "Reference: pays every 402", version: "bench" },
};

// One task taken by a scripted agent. Its scenario plan's URLs are the scenario's own, so they are mapped to the exam's;
// its calls to x402 Doctor go where the live Doctor forwards them for an exam address.
export async function takeTask(agentName, task) {
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
  const tools = {
    run: async (_name, { method, url, headers, body }) => {
      const r = await net.fetch(url, { method, headers, body });
      return { status: r.status, body: await r.text() };
    },
  };
  const out = await SCRIPTED[agentName].run({ scenario: task.scenario, wallet, tools });
  return out.answer ?? "";
}

// A whole sitting by a scripted agent against a running exam server (origin) whose live sittings are `exams`.
export async function sitAsReference(agentName, { origin, exams, startSitting }) {
  const sheet = await startSitting(REFERENCES[agentName]);
  const exam = exams.get(sheet.exam);
  for (const t of sheet.tasks) {
    const answer = await takeTask(agentName, exam.task(t.id));
    await fetch(`${origin}/v1/exams/${sheet.exam}/answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: t.id, answer }) });
  }
  const res = await fetch(`${origin}/v1/exams/${sheet.exam}/finish`, { method: "POST" });
  return res.json();
}
