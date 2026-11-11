// Offline: the command line's own wallet and its link to a Fizzl Agent Wallet, against a fake wallet server.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { pair, serverSigner, ensureWallet, readWallet, usdcBalance, buyUsdcUrl, WALLET_URL } from "../wallet.js";
import { main, stateStore } from "../cli.js";
import { SafePayError } from "../index.js";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "sf-wallet-"));
const noSleep = async () => {};

// A wallet server: pairing (approved after `waits` polls) and reserve answering `answers` in turn.
function server({ waits = 1, answers = [{ status: "ok", entries: ["e1"], purchaseId: "p1" }], approval = "approved" } = {}) {
  const log = { calls: [] };
  let polls = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    log.calls.push({ path: u.pathname, auth: init.headers?.authorization ?? null, body });
    if (u.hostname === "mainnet.base.org") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + (2_500_000).toString(16).padStart(64, "0") });
    if (u.pathname === "/v1/pair/start") return Response.json({ code: "ABCD-1234", token: "t".repeat(32), expiresIn: 600, interval: 3, url: `${WALLET_URL}/pair?code=ABCD-1234` });
    if (u.pathname === "/v1/pair/poll") return Response.json(++polls > waits ? { status: "linked", key: "awk_test", agent: "laptop" } : { status: "waiting" });
    if (u.pathname === "/v1/reserve") return Response.json(answers.shift() ?? { status: "ok", entries: [], purchaseId: null });
    if (u.pathname.startsWith("/v1/approvals/")) return Response.json(approval === "approved" ? { status: "approved", entries: ["e2"], purchaseId: "p2" } : { status: approval });
    if (u.pathname === "/v1/spent") return Response.json({ ok: true });
    return Response.json({ error: "nope" }, { status: 404 });
  };
  return { log, fetch };
}

const typedData = { domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, primaryType: "TransferWithAuthorization", message: { from: "0x0000000000000000000000000000000000000001", to: "0x6B0F4651eD42893ab58139938175E4a69f175F25", value: 20000n, validAfter: 0n, validBefore: 9999999999n, nonce: "0x" + "11".repeat(32) } };

test("ensureWallet: a new key once, kept readable by you only; the same wallet the next time", async () => {
  const home = tmpHome();
  const a = await ensureWallet(home);
  assert.equal(a.created, true);
  assert.match(a.wallet.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(privateKeyToAccount(a.wallet.privateKey).address, a.wallet.address);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, "wallet.json")).mode & 0o777, 0o600);
  const b = await ensureWallet(home);
  assert.equal(b.created, false);
  assert.equal(b.wallet.address, a.wallet.address);
});

test("pair: shows the code and link, polls until the owner approves, returns the agent key", async () => {
  const s = server({ waits: 2 });
  const shown = [];
  const linked = await pair({ address: "0x" + "ab".repeat(20), label: "laptop", fetch: s.fetch, sleep: noSleep, onCode: (c) => shown.push(c) });
  assert.deepEqual(linked, { url: WALLET_URL, key: "awk_test", agent: "laptop" });
  assert.deepEqual(shown, [{ code: "ABCD-1234", url: `${WALLET_URL}/pair?code=ABCD-1234`, expiresIn: 600 }]);
  assert.equal(s.log.calls.filter((c) => c.path === "/v1/pair/poll").length, 3);
  assert.deepEqual(s.log.calls[0].body, { address: "0x" + "ab".repeat(20), label: "laptop" });
});

test("pair: a code nobody approves in time ends with a clear error", async () => {
  const s = server({ waits: Infinity });
  let t = 0;
  await assert.rejects(pair({ address: "0x" + "ab".repeat(20), fetch: s.fetch, sleep: async (ms) => { t += ms; }, now: () => t }), /expired before it was approved/);
});

test("serverSigner: reserve first (with the typed data), then sign; finish reports it spent", async () => {
  const s = server();
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = serverSigner({ account, server: { url: WALLET_URL, key: "awk_test" }, fetch: s.fetch, purchase: { url: "https://api.example.com/x" } });
  const sig = await signer.signTypedData(typedData);
  assert.equal(sig, await account.signTypedData(typedData));
  const reserve = s.log.calls.find((c) => c.path === "/v1/reserve");
  assert.equal(reserve.auth, "Bearer awk_test");
  assert.equal(reserve.body.method, "signTypedData");
  assert.equal(reserve.body.request.type, "signature");
  assert.equal(reserve.body.request.chainId, 8453);
  assert.equal(reserve.body.request.typedData.message.value, "20000", "bigints sent as strings");
  await signer.finish("200");
  assert.deepEqual(s.log.calls.find((c) => c.path === "/v1/spent").body, { entries: ["e1"], result: "200", purchaseId: "p1" });
});

test("serverSigner: over a limit it waits for the owner; approved signs, denied or no answer does not", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const pending = { status: "pending", approvalId: "ap_1", summary: "over $1 a day", expiresAt: Date.now() + 60_000 };
  const ok = server({ answers: [pending] });
  const waited = [];
  const signer = serverSigner({ account, server: { url: WALLET_URL, key: "awk_test" }, fetch: ok.fetch, sleep: noSleep, onWait: (s) => waited.push(s) });
  assert.match(await signer.signTypedData(typedData), /^0x/);
  assert.deepEqual(waited, ["over $1 a day"]);

  for (const approval of ["denied", "expired"]) {
    const no = server({ answers: [{ ...pending }], approval });
    const s2 = serverSigner({ account, server: { url: WALLET_URL, key: "awk_test" }, fetch: no.fetch, sleep: noSleep });
    await assert.rejects(s2.signTypedData(typedData), (err) => err instanceof SafePayError && err.code === "wallet_denied");
    assert.match(s2.state.denied.summary, approval === "denied" ? /denied by the owner/ : /no answer in time/);
  }
  const paused = server({ answers: [{ status: "paused", summary: "all agents are paused" }] });
  const s3 = serverSigner({ account, server: { url: WALLET_URL, key: "awk_test" }, fetch: paused.fetch });
  await assert.rejects(s3.signTypedData(typedData), { code: "wallet_paused" });
});

test("usdcBalance: USDC on Base in dollars, null when the network can't be read", async () => {
  assert.equal(await usdcBalance("0x" + "ab".repeat(20), { fetch: server().fetch }), 2.5);
  assert.equal(await usdcBalance("0x" + "ab".repeat(20), { fetch: async () => { throw new Error("offline"); } }), null);
});

test("cli connect: makes the wallet, shows the code, links it; wallet shows it; pay without any wallet says to connect", async () => {
  const home = tmpHome();
  const store = stateStore({ home });
  const s = server();
  const out = [], err = [];
  const code = await main(["connect", "--name", "laptop"], { fetch: s.fetch, store, sleep: noSleep, env: {}, out: (x) => out.push(x), err: (x) => err.push(x) });
  assert.equal(code, 0);
  assert.match(err.join("\n"), /code ABCD-1234/);
  assert.match(err.join("\n"), /wallet\.fizzl\.eu\/pair\?code=ABCD-1234/);
  assert.match(out.join("\n"), /Linked to your Fizzl wallet as "laptop"/);
  assert.match(out.join("\n"), /USDC on Base: \$2\.5/);
  const w = readWallet(home);
  assert.deepEqual(w.server, { url: WALLET_URL, key: "awk_test", agent: "laptop" });
  assert.equal(s.log.calls.find((c) => c.path === "/v1/pair/start").body.label, "laptop");

  const info = [];
  assert.equal(await main(["wallet"], { fetch: s.fetch, store, out: (x) => info.push(x), err: () => {} }), 0);
  assert.match(info.join("\n"), new RegExp(`Address: ${w.address}`));
  assert.match(info.join("\n"), /Linked to https:\/\/wallet\.fizzl\.eu as "laptop"/);

  const none = [];
  assert.equal(await main(["pay", "https://api.example.com/x"], { fetch: s.fetch, store: stateStore({ home: tmpHome() }), env: {}, out: () => {}, err: (x) => none.push(x) }), 2);
  assert.match(none.join(), /run {2}npx x402-safe-fetch connect/);
});

test("cli init: a wallet without a link, and how to fund it", async () => {
  const home = tmpHome();
  const out = [];
  const empty = async (url) => (new URL(url).hostname === "mainnet.base.org" ? Response.json({ result: "0x0" }) : Response.json({}));
  assert.equal(await main(["init"], { fetch: empty, store: stateStore({ home }), out: (x) => out.push(x), err: () => {} }), 0);
  assert.match(out.join("\n"), /Made a wallet for this computer/);
  assert.match(out.join("\n"), /Not linked to a Fizzl wallet/);
  const w = readWallet(home);
  assert.match(out.join("\n"), /add a few dollars of USDC on Base/);
  assert.ok(out.join("\n").includes(`with a card (Coinbase, $5; open it in your browser): https://x402-doctor.fizzl.eu/api/onramp?address=${w.address}&amount=5`));
  assert.match(out.join("\n"), /choose the Base network/);
  assert.equal(w.server, undefined);

  const json = [];
  assert.equal(await main(["wallet", "--json"], { fetch: empty, store: stateStore({ home }), out: (x) => json.push(x), err: () => {} }), 0);
  assert.equal(JSON.parse(json.join("")).buy_usdc_url, buyUsdcUrl(w.address));
});

test("buyUsdcUrl: Doctor's Coinbase Onramp link for one address, $5 unless asked", () => {
  const u = new URL(buyUsdcUrl("0x6B0F4651eD42893ab58139938175E4a69f175F25", { amount: 20 }));
  assert.equal(u.origin + u.pathname, "https://x402-doctor.fizzl.eu/api/onramp");
  assert.deepEqual(Object.fromEntries(u.searchParams), { address: "0x6B0F4651eD42893ab58139938175E4a69f175F25", amount: "20" });
  assert.equal(new URL(buyUsdcUrl("0x6B0F4651eD42893ab58139938175E4a69f175F25")).searchParams.get("amount"), "5");
});
