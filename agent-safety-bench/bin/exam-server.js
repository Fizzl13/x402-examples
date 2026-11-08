#!/usr/bin/env node
// The hosted Agent Safety exam (exam.fizzl.eu): node bin/exam-server.js
//
// Env: PORT (3000), EXAM_ORIGIN (https://exam.fizzl.eu), EXAM_SIGNING_KEY (signs results), USAGE_LOG_TOKEN (+ optional
// USAGE_LOG_REPO, USAGE_LOG_SALT, USAGE_OWN_WALLETS: anonymous usage in Fizzl13/usage-log), REDIS_URL (keeps the index
// and the free-exam rule across restarts; memory without it), EXAM_FACILITATOR_URL (PayAI's by default).

// The sellers take Base Sepolia only; set before anything reads it.
process.env.X402_BENCH_NETWORK = "base-sepolia";

const { createExamServer } = await import("../src/exam/server.js");
const { memoryStore, redisStore } = await import("../src/exam/store.js");

const store = process.env.REDIS_URL ? await redisStore(process.env.REDIS_URL) : memoryStore();
if (!process.env.REDIS_URL) console.warn("[exam] no REDIS_URL: results and the free-exam rule live in memory only");
if (!process.env.EXAM_SIGNING_KEY) console.warn("[exam] no EXAM_SIGNING_KEY: results are not signed");
const { usageFromEnv } = await import("../src/exam/usage.js");
const usage = usageFromEnv();
if (!usage.enabled) console.warn("[exam] no USAGE_LOG_TOKEN: usage is not logged");
const { app, exams, startReference } = createExamServer({ store, usage });
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[exam] listening on ${port}`));

// Reference rows (src/exam/reference.js): the bench's scripted agents sit a real exam once their row is missing or
// about to expire (checked a minute after start, then daily). EXAM_REFERENCES=off turns it off.
if (process.env.EXAM_REFERENCES !== "off") {
  const { sitAsReference, REFERENCES } = await import("../src/exam/reference.js");
  const origin = process.env.EXAM_ORIGIN || "https://exam.fizzl.eu";
  const seed = async () => {
    try {
      const index = await (await fetch(`http://127.0.0.1:${port}/v1/index`)).json();
      for (const [id, agent] of Object.entries(REFERENCES)) {
        const row = index.agents.find((a) => a.reference && a.agent.name === agent.name);
        if (row && Date.parse(row.valid_until) > Date.now() + 86400000) continue;
        const r = await sitAsReference(id, { origin, exams, startSitting: startReference });
        console.log(`[exam] reference ${id}: score ${r.score}, ${r.admitted ? "admitted" : "not admitted"}`);
      }
    } catch (err) {
      console.error(`[exam] reference run failed: ${err.message}`);
    }
  };
  setTimeout(seed, 60_000).unref();
  setInterval(seed, 86400_000).unref();
}
