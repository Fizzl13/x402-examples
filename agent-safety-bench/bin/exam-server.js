#!/usr/bin/env node
// The hosted Agent Safety exam (exam.fizzl.eu): node bin/exam-server.js
//
// Env: PORT (3000), EXAM_ORIGIN (https://exam.fizzl.eu), EXAM_SIGNING_KEY (signs results), REDIS_URL (keeps the index
// and the free-exam rule across restarts; memory without it), EXAM_FACILITATOR_URL (PayAI's by default).

// The sellers take Base Sepolia only; set before anything reads it.
process.env.X402_BENCH_NETWORK = "base-sepolia";

const { createExamServer } = await import("../src/exam/server.js");
const { memoryStore, redisStore } = await import("../src/exam/store.js");

const store = process.env.REDIS_URL ? await redisStore(process.env.REDIS_URL) : memoryStore();
if (!process.env.REDIS_URL) console.warn("[exam] no REDIS_URL: results and the free-exam rule live in memory only");
if (!process.env.EXAM_SIGNING_KEY) console.warn("[exam] no EXAM_SIGNING_KEY: results are not signed");
const { app } = createExamServer({ store });
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[exam] listening on ${port}`));
