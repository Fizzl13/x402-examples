// Reference rows for the index: the bench's two scripted agents taking a real sitting over HTTP, with the official x402
// client. They aren't examinees (they know each task's scenario, which a real agent never does), so their results are
// marked reference: what an agent that pays only on x402 Doctor's "go" scores, and what one that pays everything does.

import { generatePrivateKey } from "viem/accounts";
import { createWallet } from "../wallet.js";
import { SCRIPTED } from "../agents/scripted.js";
import { DOCTOR_HOST } from "../fizzl.js";
import { DOCTOR, GUARD } from "../sources.js";

// The version names the pinned Doctor and presign-guard code the exam runs (src/sources.js) and the exam's own format
// (EXAM_FORMAT, raised when what a sitting holds changes): a new pin or format is a new version, so the server re-sits
// the reference rows (bin/exam-server.js) instead of keeping the old score until it expires.
// Format 2 (10 Nov 2026): every task can come as its twin, drawn per sitting (src/exam/twins.js, x402-examples#441).
// Format 3 (10 Nov 2026): 22 tasks, with page-drip, asset-swap and refund-request.
// Format 4 (10 Nov 2026): every sitting has the catalog's 17 traps and 5 honest tasks; twins swap which ones.
// Format 5 (13 Nov 2026): the look-alike payee's task names the address the user has always paid.
// Format 6 (14 Nov 2026): 23 tasks, with shared-budget (two sellers at once against one budget).
export const EXAM_FORMAT = 6;
const PINNED = `bench-${DOCTOR.commit.slice(0, 7)}-${GUARD.commit.slice(0, 7)}-f${EXAM_FORMAT}`;
export const REFERENCES = {
  "follow-preflight": { name: "Reference: pays only on x402 Doctor's go", version: PINNED },
  "always-pay": { name: "Reference: pays every 402", version: PINNED },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One task taken by a scripted agent. Its scenario plan's URLs are the scenario's own, so they are mapped to the exam's;
// its calls to x402 Doctor go where the live Doctor forwards them for an exam address. `pace` (ms) waits before each
// request, so a demo can be followed live.
export async function takeTask(agentName, task, { pace = 0 } = {}) {
  const mapUrl = (raw) => {
    const u = new URL(raw);
    if (u.hostname === DOCTOR_HOST) {
      const q = new URLSearchParams();
      for (const [k, v] of u.searchParams) q.append(k, task.toExam(v));
      return `${task.prefix}/${DOCTOR_HOST}${u.pathname}?${q}`;
    }
    return task.toExam(raw);
  };
  const net = {
    fetch: async (input, init) => {
      if (pace) await sleep(pace);
      return fetch(mapUrl(String(input)), init);
    },
  };
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
export async function sitAsReference(agentName, { origin, exams, startSitting, pace = 0 }) {
  const sheet = await startSitting(REFERENCES[agentName]);
  const exam = exams.get(sheet.exam);
  for (const t of sheet.tasks) {
    const answer = await takeTask(agentName, exam.task(t.id), { pace });
    if (pace) await sleep(pace);
    await fetch(`${origin}/v1/exams/${sheet.exam}/answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: t.id, answer }) });
  }
  const res = await fetch(`${origin}/v1/exams/${sheet.exam}/finish`, { method: "POST" });
  return res.json();
}
