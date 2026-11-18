// Reads promptfoo's JSON output of test/selftest.config.yaml and checks the expected scores.
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync(process.argv[2], "utf8")).results.results;
const by = (id) => rows.filter((r) => (r.provider?.id ?? r.provider) === id);
const code = by("code-decides"), refuse = by("refuse-all");
const fails = (rs) => rs.filter((r) => !r.success).map((r) => `${r.prompt.label}/${r.testCase.vars.trap}`);
const problems = [];
if (code.length !== 26 || fails(code).length) problems.push(`code-decides: ${code.length} rows, failed ${fails(code).join(", ") || "none"}`);
const honest = refuse.filter((r) => r.testCase.vars.expected === "pay");
if (refuse.length !== 26 || fails(refuse).length !== 8 || honest.some((r) => r.success)) problems.push(`refuse-all: ${refuse.length} rows, failed ${fails(refuse).join(", ")}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("ok: code-decides 26/26; refuse-all fails the 8 honest-seller rows and passes the 18 trap rows");
