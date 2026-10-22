// Linking with a code: no keys in the app's config. Offline: a fake wallet server on 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configFromEnv, linkedEnv, linkingWallet } from "../lib.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1, no funds

// The two calls of /v1/pair: a code for the agent's address, then "waiting" until the owner enters it.
function fakeServer({ interval = 3 } = {}) {
  const s = { starts: [], polls: 0, linked: false };
  s.handle = async (path, body) => {
    if (path === "/v1/pair/start") { s.starts.push(body); return { status: 200, body: { code: `K7QF-29X${s.starts.length}`, token: "secret-token-of-the-agent", expiresIn: 600, interval, url: `https://wallet.test/pair?code=K7QF-29X${s.starts.length}` } }; }
    if (path === "/v1/pair/poll") { s.polls++; assert.equal(body.token, "secret-token-of-the-agent"); return { status: 200, body: s.linked ? { status: "linked", key: "awk_from_the_server", agent: "claude-desktop" } : { status: "waiting" } }; }
    return { status: 404, body: { message: "no" } };
  };
  s.fetchImpl = async (url, init) => { const r = await s.handle(new URL(url).pathname, JSON.parse(init.body)); return Response.json(r.body, { status: r.status }); };
  return s;
}

test("linking: the wallet makes its own key, every tool gives the code, and the server's key is saved once the owner enters it", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "fizzl-")), "fizzl");
  const env = { FIZZL_DIR: dir, WALLET_SERVER_URL: "https://wallet.test/", AGENT_LABEL: "claude-desktop" };
  const server = fakeServer();
  let tick = 0;
  const linked = [];
  const w = linkingWallet(env, { fetchImpl: server.fetchImpl, sleep: async () => { if (++tick === 2) server.linked = true; }, onLinked: (j) => linked.push(j), log: () => {} });
  assert.equal(linkedEnv(env), null, "not linked yet");

  await assert.rejects(w.payX402({ url: "https://api.test" }), (err) => {
    assert.match(err.message, /isn't linked to a Fizzl account yet/);
    assert.match(err.message, /https:\/\/wallet\.test\/pair\?code=K7QF-29X1/);
    assert.match(err.message, /enter the code K7QF-29X1/);
    return true;
  });
  const key = readFileSync(join(dir, "agent-key"), "utf8").trim();
  assert.match(key, /^0x[0-9a-f]{64}$/, "the agent wallet's key, made here");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "agent-key")).mode & 0o777, 0o600, "readable only by you");
  const address = privateKeyToAccount(key).address;
  assert.deepEqual(server.starts, [{ address, label: "claude-desktop" }], "only the address goes to the server");

  await w.waiting();
  assert.equal(linked.length, 1);
  assert.equal(server.starts.length, 1, "one code for both calls");
  const saved = JSON.parse(readFileSync(join(dir, "wallet-server.json"), "utf8"));
  assert.equal(saved.url, "https://wallet.test");
  assert.equal(saved.key, "awk_from_the_server");
  assert.equal(saved.agent, "claude-desktop");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "wallet-server.json")).mode & 0o777, 0o600);

  // From these files the wallet is an ordinary wallet-server wallet, with the same key.
  const config = configFromEnv(linkedEnv(env));
  assert.equal(config.key, key);
  assert.deepEqual(config.server, { url: "https://wallet.test", key: "awk_from_the_server" });
});

test("linking: wallet_status shows the code instead of failing; an existing key file is used; a damaged link file says what to do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fizzl-"));
  writeFileSync(join(dir, "agent-key"), `${KEY.slice(2)}\n`, { mode: 0o600 }); // as MetaMask shows it
  const server = fakeServer();
  const w = linkingWallet({ FIZZL_DIR: dir }, { fetchImpl: server.fetchImpl, sleep: () => new Promise(() => {}), log: () => {} });
  const s = await w.status();
  assert.equal(s.linked, false);
  assert.equal(s.link.code, "K7QF-29X1");
  assert.equal(s.link.minutesLeft, 10);
  assert.equal(s.agentWallet, privateKeyToAccount(KEY).address);
  assert.equal(server.starts[0].label, "agent");

  writeFileSync(join(dir, "wallet-server.json"), "{ not json");
  assert.throws(() => linkedEnv({ FIZZL_DIR: dir }), /delete it to link this agent again/);
  writeFileSync(join(dir, "wallet-server.json"), JSON.stringify({ url: "https://wallet.test" }));
  assert.throws(() => linkedEnv({ FIZZL_DIR: dir }), /damaged: delete it/);
});

test("linking end to end: the MCP server without any keys gives a code, switches over once linked, and starts linked next time", async () => {
  const fake = fakeServer({ interval: 0.05 });
  const http = httpServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => { const r = await fake.handle(req.url, JSON.parse(body || "{}")); res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body)); });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const dir = join(mkdtempSync(join(tmpdir(), "fizzl-")), "fizzl");
  const env = { PATH: process.env.PATH, FIZZL_DIR: dir, WALLET_SERVER_URL: base, AGENT_LABEL: "claude-desktop" };
  const serverJs = fileURLToPath(new URL("../server.js", import.meta.url));
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], env, stderr: "pipe" });
    let log = "";
    transport.stderr.on("data", (d) => { log += d; });
    const client = new Client({ name: "claude-like", version: "1" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["wallet_status", "find_services", "pay_x402", "send_usdc", "send_native", "pause_spending"]);
      assert.equal(existsSync(dir), false, "listing the tools makes nothing (directories such as Glama only look)");
      const status = await client.callTool({ name: "wallet_status", arguments: {} });
      assert.notEqual(status.isError, true);
      const s = JSON.parse(status.content[0].text);
      assert.equal(s.link.code, "K7QF-29X1");
      assert.equal(s.link.url, `https://wallet.test/pair?code=K7QF-29X1`);
      fake.linked = true;
      // The switch-over logs "linked as …", then makes the real wallet and logs it: wait for that last line.
      for (let i = 0; i < 200 && !/limits on/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(log, /linked as "claude-desktop"/);
      assert.match(log, new RegExp(`wallet ${s.agentWallet} on base, limits on ${base}`), "switched to the real wallet without a restart");
    } finally { await client.close(); }

    // Next start: linked from the files, no code.
    const again = new StdioClientTransport({ command: process.execPath, args: [serverJs], env, stderr: "pipe" });
    let log2 = "";
    again.stderr.on("data", (d) => { log2 += d; });
    const client2 = new Client({ name: "claude-like", version: "1" });
    await client2.connect(again);
    try {
      for (let i = 0; i < 100 && !/limits on/.test(log2); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(log2, new RegExp(`limits on ${base}`));
      assert.equal(fake.starts.length, 1, "no new code");
    } finally { await client2.close(); }
  } finally { http.close(); }
});

test("LINKING=off keeps the setup mode: the tools only say how to add a key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fizzl-"));
  mkdirSync(join(dir, "x"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server.js", import.meta.url))], env: { PATH: process.env.PATH, LINKING: "off", FIZZL_DIR: join(dir, "x") }, stderr: "ignore" });
  const client = new Client({ name: "glama-like", version: "1" });
  await client.connect(transport);
  try {
    const out = await client.callTool({ name: "wallet_status", arguments: {} });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /No wallet yet: set AGENT_KEY/);
    assert.equal(existsSync(join(dir, "x", "agent-key")), false);
  } finally { await client.close(); }
});
