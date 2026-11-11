// The wallet from start to finish, on this machine, with no real money: a new owner signs in, an agent (the real
// wallet MCP, keyless) asks for a code, the owner links it on the dashboard, the agent searches the catalog, pays a
// seller under the limit, pays one over the limit after the owner approves it, and the receipts show up.
// The wallet server is the real server.js; the seller, the x402 catalog, presign-guard and the Base RPC are local
// stand-ins, and guard.mjs keeps every request on 127.0.0.1.
//
//   node e2e/flow.mjs [screenshot-dir]
import "./guard.mjs";
import { createServer as httpServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { canonicalJson, inputHash } from "x402-safe-fetch";

const here = fileURLToPath(new URL(".", import.meta.url));
const shots = process.argv[2] || mkdtempSync(join(tmpdir(), "wallet-e2e-shots-"));
mkdirSync(shots, { recursive: true });
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const sdk = join(here, "../../wallet-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm");
const { Client } = await import(join(sdk, "client/index.js"));
const { InMemoryTransport } = await import(join(sdk, "inMemory.js"));

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x1111111111111111111111111111111111111111";
const SELLER_URL = "https://weather.e2e-fizzl.test";
const presignKey = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const log = (...a) => console.log("[e2e]", ...a);
const findings = [];
const note = (f) => { findings.push(f); log("FINDING:", f); };

// ---------- local stand-ins ----------
const listen = (handler) => new Promise((ok) => { const s = httpServer(handler).listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => ok(b)); });
const json = (res, o, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(o)); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const offers = {
  "/forecast": { usd: 0.01, description: "Weather forecast for a city, 3 days (temperature, rain, wind)", input: { method: "GET", queryParams: { city: "Amsterdam" } } },
  "/report": { usd: 0.75, description: "Full weather report with hourly data for 14 days", input: { method: "GET", queryParams: { city: "Amsterdam" } } },
};
const accept = (path) => ({ scheme: "exact", network: "eip155:8453", amount: String(Math.round(offers[path].usd * 1e6)), asset: USDC, payTo: SELLER, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } });
const paid = [];
const seller = await listen(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (!offers[u.pathname]) return json(res, { error: "not found" }, 404);
  const sig = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (!sig) return json(res, {}, 402, { "payment-required": b64({ x402Version: 2, error: "Payment required", resource: { url: `${SELLER_URL}${u.pathname}`, description: offers[u.pathname].description, mimeType: "application/json" }, accepts: [accept(u.pathname)] }) });
  let payload = null;
  try { payload = JSON.parse(Buffer.from(String(sig), "base64").toString()); } catch {}
  paid.push({ path: u.pathname, payload });
  const tx = `0x${"ab".repeat(32)}`;
  json(res, { city: u.searchParams.get("city") ?? "Amsterdam", days: [{ day: "Thu", high_c: 11, rain_mm: 2 }, { day: "Fri", high_c: 9, rain_mm: 7 }, { day: "Sat", high_c: 12, rain_mm: 0 }] }, 200,
    { "payment-response": b64({ success: true, transaction: tx, network: "eip155:8453", payer: payload?.payload?.authorization?.from ?? null }) });
});

const presign = await listen(async (req, res) => {
  const input = JSON.parse(await body(req) || "{}");
  const route = "POST /v1/check";
  // Like presign-guard: an EIP-3009 payment is decoded into what it lets go (the wallet server counts that).
  const td = input.typedData;
  const subject = input.type === "signature" && td?.primaryType === "TransferWithAuthorization"
    ? { kind: "transfer_authorization", grants: [{ token: String(td.domain?.verifyingContract).toLowerCase(), spender: String(td.message?.to).toLowerCase(), amount: String(td.message?.value), unlimited: false, mode: "payment" }] }
    : { kind: "unknown_signature", grants: [] };
  const out = { version: "2", verdict: "green", reasons: [], subject };
  const receipt = { request_id: `e2e-${Date.now()}`, route, input_sha256: inputHash(route, input), signed_at: new Date().toISOString(), signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  json(res, { ...out, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...out, receipt }) }) } });
});

const rpcCalls = new Map();
let usdcHeld = 0n; // the agent's USDC (6 decimals): none at first, like a new agent wallet
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const rpc = await listen(async (req, res) => {
  const msg = JSON.parse(await body(req) || "{}");
  const one = ({ id, method, params }) => {
    rpcCalls.set(method, (rpcCalls.get(method) ?? 0) + 1);
    let result = null;
    if (method === "eth_chainId") result = "0x2105";
    else if (method === "eth_blockNumber") result = "0x1000";
    else if (method === "eth_getBalance") result = "0x0";
    else if (method === "eth_getCode") result = "0x";
    else if (method === "eth_call") {
      const data = String(params?.[0]?.data ?? params?.[0]?.input ?? "");
      if (data.startsWith("0x70a08231")) result = word(usdcHeld); // balanceOf
      else if (data.startsWith("0xe94a0102")) result = word(0); // authorizationState: not used yet
      else if (data.startsWith("0x313ce567")) result = word(6); // decimals
      else result = "0x";
    }
    return { jsonrpc: "2.0", id, result };
  };
  json(res, Array.isArray(msg) ? msg.map(one) : one(msg));
});

const catalog = await listen(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/discovery/resources") {
    const items = Number(u.searchParams.get("offset") ?? 0) > 0 ? [] : Object.entries(offers).map(([path, o]) => ({
      resource: `${SELLER_URL}${path}`, type: "http", x402Version: 2, description: o.description, accepts: [accept(path)],
      extensions: { bazaar: { info: { input: o.input } } }, lastUpdated: new Date().toISOString(),
    }));
    return json(res, { items, pagination: { limit: 500, offset: 0, total: 2 } });
  }
  json(res, { error: "not found" }, 404);
});

// ---------- the wallet server: the real server.js ----------
const port = 40000 + Math.floor(Math.random() * 10000);
const W = `http://127.0.0.1:${port}`;
const serverLog = [];
const srv = spawn(process.execPath, ["--import", join(here, "guard.mjs"), join(here, "../server.js")], {
  cwd: join(here, ".."),
  env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "wallet-e2e-server-")), NODE_ENV: "development", PORT: String(port), ADMIN_PASSWORD: "e2e correct horse battery", PUBLIC_URL: W,
    EXTRA_SIGNERS: presignKey.address, BASE_RPC_URL: rpc.url, X402_DISCOVERY_URL: `${catalog.url}/discovery/resources`, X402_TRUST_INDEX_URL: `${catalog.url}/trust.json`, DOCTOR_URL: catalog.url, PG1_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => serverLog.push(String(d)));
srv.stderr.on("data", (d) => serverLog.push(String(d)));
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${W}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

let exit = 0;
const browser = await chromium.launch();
try {
  // ---------- 1. a new owner signs in with an Ethereum wallet ----------
  const m = await (await fetch(`${W}/api/signin/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: owner.address, chain: "ethereum" }) })).json();
  const si = await fetch(`${W}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: m.nonce, signature: await owner.signMessage({ message: m.message }) }) });
  const cookie = si.headers.get("set-cookie").split(";")[0];
  const [cname, cvalue] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];
  const api = async (method, path, b) => { const r = await fetch(`${W}${path}`, { method, headers: { cookie, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const me = (await api("GET", "/api/me")).body;
  log("signed in:", me.plan, "plan, limits", JSON.stringify(me.limits));
  log("default rules:", JSON.stringify((await api("GET", "/api/state")).body.policy));

  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.addCookies([{ name: cname, value: cvalue, url: W }]);
  const pg = await ctx.newPage();
  const pageErrors = [];
  pg.on("pageerror", (e) => pageErrors.push(e.message));
  pg.on("console", (c) => { if (c.type() === "error") pageErrors.push(c.text()); });
  let n = 0;
  const shot = async (name) => { await pg.waitForTimeout(400); await pg.screenshot({ path: join(shots, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true }); };
  await pg.goto(`${W}/`, { waitUntil: "domcontentloaded" });
  await pg.waitForSelector("#startCard:not([hidden])", { timeout: 8000 });
  await shot("home-new-owner");

  // ---------- 2. the agent: the real wallet MCP, keyless, as Claude Desktop runs it ----------
  const agentHome = mkdtempSync(join(tmpdir(), "wallet-e2e-agent-"));
  const lib = await import(join(here, "../../wallet-mcp/lib.js"));
  const env = { FIZZL_DIR: join(agentHome, ".fizzl"), WALLET_SERVER_URL: W, RPC_URL: rpc.url, AGENT_LABEL: "Claude Desktop" };
  // The agent's public services go to their stand-ins (guard.mjs then keeps everything else out).
  const redirect = { [SELLER_URL]: seller.url, "https://presign-guard.fizzl.eu": presign.url, "https://rpc.tempo.xyz": rpc.url };
  const guarded = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [from, to] of Object.entries(redirect)) if (url.startsWith(from)) {
      const local = to + url.slice(from.length);
      return typeof input === "string" || input instanceof URL ? guarded(local, init) : guarded(new Request(local, input), init);
    }
    return guarded(input, init);
  };
  if (process.env.E2E_TRACE) { const inner = globalThis.fetch; globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; const t = Date.now(); try { const r = await inner(input, init); log(`agent fetch ${init?.method ?? input?.method ?? "GET"} ${url.slice(0, 120)} -> ${r.status} ${Date.now() - t}ms`); return r; } catch (e) { log(`agent fetch ${url.slice(0, 120)} -> ERR ${e.message} ${Date.now() - t}ms`); throw e; } }; }
  let linked = false;
  let wallet = lib.linkingWallet(env, { onLinked: () => { linked = true; }, log: (t) => log("agent:", t) });
  const mcp = lib.createServer(new Proxy({}, { get: (_t, k) => wallet[k] }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(ct);
  const tool = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.map((c) => c.text).join("\n") ?? "";
    let data = null; try { data = JSON.parse(text); } catch {}
    return { error: !!r.isError, text, data };
  };

  const s1 = await tool("wallet_status");
  const code = s1.data?.link?.code;
  log("agent wallet_status (not linked):", s1.text.slice(0, 300));
  if (!code) throw new Error("no code from the agent");

  // ---------- 3. the owner enters the code on Home and links the agent ----------
  await pg.fill("#startCode", code);
  await pg.click("#startPair button[type=submit]");
  await pg.waitForSelector("#pairLink", { timeout: 8000 });
  await shot("agents-code-looked-up");
  await pg.fill("#pairName", "claude");
  await pg.click("#pairLink button[type=submit]");
  await pg.waitForSelector("#pairOut .msg.good", { timeout: 8000 });
  await shot("agents-linked");
  for (let i = 0; i < 40 && !linked; i++) await new Promise((r) => setTimeout(r, 250));
  if (!linked) throw new Error("the agent never heard it was linked");
  wallet = lib.createWallet(lib.configFromEnv(lib.linkedEnv(env)), { guard: { presignUrl: presign.url, signers: [presignKey.address] } });

  const s2 = await tool("wallet_status");
  log("agent wallet_status (linked):", s2.text.slice(0, 600));
  await pg.goto(`${W}/#/overview`); await pg.waitForTimeout(1500);
  await shot("home-after-link");

  // ---------- 4. the agent searches the catalog; the owner searches it too ----------
  const found = await tool("find_services", { query: "weather forecast amsterdam", max_price_usd: 1 });
  log("agent find_services:", found.text.slice(0, 900));
  if (!found.text.includes(SELLER_URL)) note("find_services did not return the seller from the catalog");
  await pg.goto(`${W}/#/find`); await pg.waitForTimeout(500);
  await pg.fill("#searchQ", "weather forecast");
  await pg.click("#searchForm button[type=submit]");
  await pg.waitForTimeout(1500);
  await shot("find-weather");

  // ---------- 5a. a new agent wallet holds no USDC yet: the agent says so (and how to get some), nothing is tried ----------
  const empty = await tool("pay_x402", { url: `${SELLER_URL}/forecast?city=Amsterdam`, max_price_usd: 0.05, reason: "3-day forecast" });
  log("agent pay_x402 with 0 USDC:", empty.error ? "refused" : "WENT AHEAD", empty.text.slice(0, 400));
  if (!empty.error || !/buy_usdc/.test(empty.text)) note("an agent wallet with no USDC did not get a clear 'add USDC' answer");
  if (paid.length) note("the seller was paid by a wallet with no USDC");
  usdcHeld = 5_000_000n; // the owner added $5

  // ---------- 5. a purchase under the limit: paid at once ----------
  const p1call = tool("pay_x402", { url: `${SELLER_URL}/forecast?city=Amsterdam`, max_price_usd: 0.05, reason: "3-day forecast for Frits's trip" });
  await new Promise((r) => setTimeout(r, 3000));
  const asked = (await api("GET", "/api/state")).body.approvals.filter((a) => a.status === "pending");
  if (asked.length) {
    note(`a $0.01 purchase under the limit was held for approval: ${asked.map((a) => a.summary).join("; ")}`);
    await pg.goto(`${W}/#/overview`); await pg.waitForTimeout(1200); await shot("home-small-purchase-asked");
    await api("POST", `/api/approvals/${asked[0].id}`, { decision: "approve" });
  }
  const p1 = await p1call;
  log("agent pay_x402 $0.01:", p1.error ? "ERROR" : "ok", p1.text.slice(0, 700));
  await pg.goto(`${W}/#/purchases`); await pg.waitForTimeout(1500);
  await shot("purchases-one");
  const firstRow = await pg.$("#buys .buy");
  if (firstRow) { await firstRow.click(); await pg.waitForTimeout(800); await shot("receipt-one"); await pg.keyboard.press("Escape"); }
  else note("no receipt row after the first purchase");

  // ---------- 6. a purchase over the owner's per-purchase limit: asked first ----------
  const pol = (await api("GET", "/api/state")).body.policy;
  pol.tokens = pol.tokens ?? {}; pol.tokens.USDC = { ...(pol.tokens.USDC ?? {}), perTx: "0.5" };
  log("set per-purchase limit to $0.50:", (await api("PUT", "/api/policy", { policy: pol })).status);
  const over = tool("pay_x402", { url: `${SELLER_URL}/report?city=Amsterdam`, max_price_usd: 1, reason: "14-day report" });
  await pg.goto(`${W}/#/overview`);
  try {
    await pg.waitForSelector("#approvals [data-decision=approve]", { timeout: 15000 });
    await shot("home-approval-waiting");
    await pg.click("#approvals [data-decision=approve]");
  } catch { note("no approval request showed up on Home for a purchase over the limit"); }
  const p2 = await Promise.race([over, new Promise((r) => setTimeout(() => r({ error: true, text: "TIMEOUT: the agent's call did not finish 60 s after the approval" }), 60000))]);
  log("agent pay_x402 $0.75 (approved):", p2.error ? "ERROR" : "ok", p2.text.slice(0, 700));
  await pg.goto(`${W}/#/purchases`); await pg.waitForTimeout(1500);
  await shot("purchases-two");

  // ---------- 7. the archive ----------
  const csv = await fetch(`${W}/api/purchases/export`, { headers: { cookie } });
  log("export CSV:", csv.status, (await csv.text()).replace(/^﻿/, "").split("\r\n").filter(Boolean).length - 1, "receipts");
  log("seller saw", paid.length, "paid calls:", paid.map((p) => p.path).join(", "));
  log("Base RPC calls by the wallet and the agent:", JSON.stringify(Object.fromEntries(rpcCalls)));
  if (pageErrors.length) note(`page errors: ${pageErrors.join(" | ").slice(0, 500)}`);
} catch (err) {
  exit = 1;
  log("STOPPED:", err.message);
} finally {
  await browser.close();
  srv.kill();
  for (const x of [seller, presign, rpc, catalog]) x.s.close();
  const blocked = serverLog.join("").split("\n").filter((l) => l.includes("[e2e-blocked]"));
  if (blocked.length) log("the server tried to reach (kept out):", [...new Set(blocked)].join(" "));
  if (exit || process.env.E2E_TRACE) log("server log tail:\n" + serverLog.join("").split("\n").slice(-40).join("\n"));
  const errs = serverLog.join("").split("\n").filter((l) => /error|warn/i.test(l) && !l.includes("[e2e-blocked]"));
  if (errs.length) log("server warnings:", [...new Set(errs)].slice(0, 15).join("\n  "));
  log("screenshots in", shots);
  log(findings.length ? `${findings.length} finding(s)` : "no findings");
  writeFileSync(join(shots, "findings.json"), JSON.stringify(findings, null, 2));
  process.exit(exit);
}
