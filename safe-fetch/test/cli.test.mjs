// Offline: the command line with fake sellers, a fake Doctor and a fake payment; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { canonicalJson, inputHash } from "../index.js";
import { main, parseArgs, stateStore, BUY_URL } from "../cli.js";

const doctorKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, url) {
  const receipt = { request_id: "r1", route: "GET /api/v1/preflight", input_sha256: inputHash("GET /api/v1/preflight", Object.fromEntries(new URL(url).searchParams)), signed_at: "2026-11-11T10:00:00.000Z", signer: doctorKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await doctorKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const PAID = "https://api.example.com/v1/translate";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const offer = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: "0x6B0F4651eD42893ab58139938175E4a69f175F25", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };

// A seller answering `answers` in turn after each payment (default 200), Doctor saying `verdict`.
function world({ verdict = "go", answers = [], answerText = '{"nl":"De vergadering is verplaatst"}' } = {}) {
  const log = { paid: [], preflights: 0, out: [], err: [] };
  const fetch = async (url, init = {}) => {
    if (url.startsWith(`${BUY_URL}/v1/pick`)) {
      return Response.json({ need: "x", pick: { url: PAID, method: "GET", description: "Translate a text", price_usd: 0.02, record: { days: 30, payableDays: 29, ratio: 0.97 } }, alternatives: [] });
    }
    if (url.endsWith("/api/diagnose")) return Response.json({ overall: "warn", checks: [{ id: "bazaar-listed", status: "warn", message: "Not in the CDP Bazaar." }, { id: "https", status: "pass", message: "ok" }], share_url: "https://x402-doctor.fizzl.eu/r/abc" });
    if (url.includes("/v1/injection/quick")) return Response.json({ verdict: "green" });
    if (url.startsWith("https://api.example.com/free")) return Response.json({ free: true });
    return Response.json(offer, { status: 402 });
  };
  const createPayingFetch = () => async (url, init = {}) => {
    if (url.includes("/api/v1/preflight")) {
      log.preflights++;
      return Response.json(await signed({ verdict, summary: verdict === "go" ? "OK to pay: $0.02 on Base." : "Do not pay: payout address changed.", recommended_option: 0, options: [{ index: 0, network: "eip155:8453", usd: 0.02, payable: true }], reasons: verdict === "go" ? [] : [{ level: "no_go", code: "payto_changed", message: "payout address changed" }] }, url));
    }
    log.paid.push(url);
    const status = answers.shift() ?? 200;
    return status === 200
      ? new Response(answerText, { status: 200, headers: { "content-type": "application/json" } })
      : Response.json(status === 402 ? offer : { error: "x" }, { status });
  };
  return { log, fetch, createPayingFetch };
}

function tmpStore(now = () => Date.parse("2026-11-11T12:00:00Z")) {
  return stateStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), "sf-cli-")), now });
}

async function run(w, argv, store = tmpStore()) {
  const out = [], err = [];
  const code = await main(argv, { fetch: w.fetch, createPayingFetch: w.createPayingFetch, store, safeFetchOptions: { doctorSigners: [doctorKey.address] }, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: argv.includes("--json") ? JSON.parse(out[0]) : null, store };
}

test("parseArgs: flags with and without =, booleans, positional words", () => {
  const a = parseArgs(["pay", "https://x", "--max=0.1", "--daily", "2", "--json", "--no-answer-check"]);
  assert.deepEqual(a._, ["pay", "https://x"]);
  assert.deepEqual(a.flags, { max: "0.1", daily: "2", json: true, "no-answer-check": true });
});

test("find: Fizzl Buy's free pick, with price and delivery record, and how to pay it", async () => {
  const r = await run(world(), ["find", "translate", "to", "dutch"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /GET https:\/\/api\.example\.com\/v1\/translate/);
  assert.match(r.out, /\$0\.02 per call · delivered 29 of 30 days/);
  assert.match(r.out, /npx x402-safe-fetch pay "https:\/\/api\.example\.com\/v1\/translate"/);
});

test("check and pay --dry-run: the price per network and Doctor's free check; nothing paid, no preflight bought", async () => {
  for (const argv of [["check", PAID], ["pay", PAID, "--dry-run"]]) {
    const w = world();
    const r = await run(w, argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /eip155:8453: \$0\.02 to 0x6B0F/);
    assert.match(r.out, /x402 Doctor's free check: WARN/);
    assert.match(r.out, /Not in the CDP Bazaar/);
    assert.match(r.out, /Nothing was paid/);
    assert.equal(w.log.paid.length, 0);
    assert.equal(w.log.preflights, 0);
  }
});

test("pay on go: paid, the answer checked and shown, the day's spend kept (preflight included)", async () => {
  const w = world();
  const r = await run(w, ["pay", PAID, "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.preflight.verdict, "go");
  assert.equal(r.json.answer_check, "green");
  assert.deepEqual(r.json.body, { nl: "De vergadering is verplaatst" });
  assert.equal(r.json.paid_usd, 0.021);
  assert.equal(r.store.read().spentUsd, 0.021);
  assert.equal(w.log.paid.length, 1);
});

test("pay on no_go: not paid, exit 1, the reasons shown; only the preflight is counted", async () => {
  const w = world({ verdict: "no_go" });
  const r = await run(w, ["pay", PAID]);
  assert.equal(r.code, 1);
  assert.match(r.out, /x402 Doctor: NO_GO: Do not pay: payout address changed/);
  assert.match(r.out, /no_go: payout address changed/);
  assert.equal(w.log.paid.length, 0);
  assert.equal(r.store.read().spentUsd, 0.001);
});

test("a seller that takes the money and answers 402 again: blocked for the next command too, whatever is added to the URL", async () => {
  const w = world({ answers: [402] });
  const store = tmpStore();
  const first = await run(w, ["pay", PAID, "--json"], store);
  assert.equal(first.code, 1);
  assert.equal(first.json.code, "not_delivered");
  assert.equal(first.json.paid_usd, 0.021, "counted as paid: the price from the preflight, plus the preflight");
  for (const again of [PAID, `${PAID}?nonce=1`, `${PAID}?to=nl&text=again`]) {
    const r = await run(w, ["pay", again, "--json"], store);
    assert.equal(r.code, 1);
    assert.equal(r.json.code, "paid_no_delivery");
  }
  assert.equal(w.log.paid.length, 1, "one payment lost, not four");
  assert.equal(w.log.preflights, 1, "no preflight bought for a blocked endpoint");
  const s = await run(w, ["spent"], store);
  assert.match(s.out, /Not paid again for now/);
  assert.match(s.out, /api\.example\.com\/v1\/translate/);
});

test("the day's limit holds across commands, and resets the next UTC day", async () => {
  let t = Date.parse("2026-11-11T12:00:00Z");
  const store = tmpStore(() => t);
  const w = world();
  assert.equal((await run(w, ["pay", PAID, "--daily", "0.05"], store)).code, 0);
  assert.equal((await run(w, ["pay", PAID, "--daily", "0.05"], store)).code, 0);
  const third = await run(w, ["pay", PAID, "--daily", "0.05", "--json"], store);
  assert.equal(third.code, 1);
  assert.equal(third.json.code, "over_total_budget");
  assert.equal(w.log.paid.length, 2);
  assert.equal(store.read().spentUsd, 0.042, "the third was refused before its preflight: nothing spent on it");
  const spent = await run(w, ["spent", "--daily", "0.05", "--json"], store);
  assert.equal(spent.json.left_usd, 0.008);
  t = Date.parse("2026-11-12T00:00:01Z");
  assert.equal(store.read().spentUsd, 0);
  assert.equal((await run(w, ["pay", PAID, "--daily", "0.05"], store)).code, 0);
});

test("usage errors exit 2: no command, bad URL, bad amount, missing key", async () => {
  const w = world();
  assert.equal((await run(w, [])).code, 2);
  assert.equal((await run(w, ["pay", "not-a-url"])).code, 2);
  assert.equal((await run(w, ["pay", PAID, "--max", "-1"])).code, 2);
  const out = [], err = [];
  const code = await main(["pay", PAID], { fetch: w.fetch, env: {}, store: tmpStore(), out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(), /EVM_PRIVATE_KEY/);
});

test("the bin runs as a command: --help prints the commands", () => {
  const help = execFileSync(process.execPath, [new URL("../cli.js", import.meta.url).pathname, "--help"], { encoding: "utf8" });
  assert.match(help, /find <need>/);
  assert.match(help, /pay <url>/);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.bin["x402-safe-fetch"], "cli.js");
  assert.ok(pkg.files.includes("cli.js"));
});
