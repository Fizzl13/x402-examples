// Fizzl Pass phase 1 (src/pass.js): Pro is the Bronze pass, checkable by wallet, with a signed Ed25519 proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { passKeyFrom, publicJwks, signPass, verifyPass, walletKey } from "../src/pass.js";
import { createAccounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { memoryStore } from "../src/store.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const DAY = 86_400_000;

test("the proof: signed with Ed25519, checked offline with the published key, refused when changed or expired", () => {
  const key = passKeyFrom(randomBytes(32).toString("base64"));
  const until = Date.now() + 10 * DAY;
  const token = signPass({ iss: "wallet.fizzl.eu", tier: "bronze", until, wallets: [OWNER] }, key);
  assert.match(token, /^fzp1\.[\w-]+\.[\w-]+$/);
  const jwk = publicJwks(key).keys[0];
  assert.deepEqual([jwk.kty, jwk.crv, jwk.kid], ["OKP", "Ed25519", key.kid]);
  const claims = verifyPass(token, jwk);
  assert.deepEqual([claims.tier, claims.wallets, claims.kid], ["bronze", [OWNER], key.kid]);
  const [h, body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), tier: "gold" })).toString("base64url");
  assert.equal(verifyPass(`${h}.${forged}.${sig}`, jwk), null, "a changed claim breaks the signature");
  assert.equal(verifyPass(token, passKeyFrom(randomBytes(32).toString("hex")).publicKey), null, "another key");
  assert.equal(verifyPass(token, jwk, until + 1), null, "expired");
  assert.equal(passKeyFrom(""), null);
  assert.throws(() => passKeyFrom("too short"), /at least 32 characters/);
  const generated = "test-value-that-is-at-least-32-characters-long"; // stands for a random value of 32+ characters
  assert.equal(passKeyFrom(generated).kid, passKeyFrom(generated).kid, "the same value gives the same key");
});

function setup(now = () => Date.now()) {
  const store = memoryStore();
  const key = passKeyFrom(randomBytes(32).toString("base64"));
  const accounts = createAccounts({ store, publicUrl: "https://wallet.test", now, passKey: key, billing: { payTo: OWNER, priceUsdc: 5, rpcUrl: "https://rpc.test", fetch: async () => Response.json({ result: null }) }, walletOptions: { authority: null } });
  return { store, accounts, key };
}

test("Pro is the Bronze pass: it covers the owner's and the agents' wallets; a free account has none", async () => {
  const { store, accounts, key } = setup();
  await store.global.putAccount({ id: OWNER, address: OWNER, createdAt: Date.now(), paidUntil: Date.now() + 20 * DAY, payments: [] });
  await store.scope(OWNER).putAgent({ id: "ag1", keyHash: "h1", name: "bot", createdAt: Date.now(), address: AGENT });
  const r = await accounts.pass(OWNER);
  assert.equal(r.pass.tier, "bronze");
  assert.equal(r.pass.name, "Fizzl Pass Bronze");
  assert.deepEqual(r.pass.wallets.sort(), [OWNER, AGENT].map(walletKey).sort());
  assert.deepEqual(verifyPass(r.pass.token, key.publicKey).wallets.sort(), r.pass.wallets.sort());
  const s = await accounts.passStatus(AGENT.toUpperCase().replace("0X", "0x"));
  assert.equal(s.pass.tier, "bronze");
  assert.ok(s.pass.until > Date.now());
  assert.equal(Object.keys(s.pass).includes("account"), false, "never whose it is");
  assert.equal((await accounts.passStatus("0x3333333333333333333333333333333333333333")).pass, null);
  await assert.rejects(accounts.passStatus("not-a-wallet"), /wallet must be/);

  const FREE = "0x4444444444444444444444444444444444444444";
  await store.global.putAccount({ id: FREE, address: FREE, createdAt: Date.now(), paidUntil: 0, payments: [] });
  assert.equal((await accounts.pass(FREE)).pass, null);
  assert.equal((await accounts.passStatus(FREE)).pass, null);
});

test("the pass ends with Pro", async () => {
  let t = Date.now();
  const { store, accounts } = setup(() => t);
  await store.global.putAccount({ id: OWNER, address: OWNER, createdAt: t, paidUntil: t + DAY, payments: [] });
  assert.ok((await accounts.pass(OWNER)).pass);
  t += 2 * DAY;
  assert.equal((await accounts.pass(OWNER)).pass, null);
  assert.equal((await accounts.passStatus(OWNER)).pass, null);
});

test("HTTP: the public check (CORS) and the published key", async (t) => {
  const { store, accounts, key } = setup();
  await store.global.putAccount({ id: OWNER, address: OWNER, createdAt: Date.now(), paidUntil: Date.now() + 5 * DAY, payments: [] });
  await accounts.pass(OWNER);
  const app = createApp({ accounts, auth: createAuth({ password: "a-long-test-password", secure: false }), passJwks: publicJwks(key) });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/v1/pass/status?wallet=${OWNER}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal((await res.json()).pass.tier, "bronze");
  assert.equal((await fetch(`${base}/v1/pass/status?wallet=nope`)).status, 400);
  const jwks = await (await fetch(`${base}/.well-known/fizzl-pass.json`)).json();
  assert.equal(jwks.keys[0].kid, key.kid);
  assert.equal((await fetch(`${base}/api/pass`)).status, 401, "the proof needs the owner's session");
});

test("phase 2b: an agent gets its owner's pass proof (GET /v1/pass) to send as X-Fizzl-Pass; none without a pass", async (t) => {
  const { store, accounts, key } = setup();
  await store.global.putAccount({ id: OWNER, address: OWNER, createdAt: Date.now(), paidUntil: Date.now() + 5 * DAY, payments: [] });
  const { key: agentKey } = await accounts.walletFor(OWNER).addAgent("bot");
  const FREE = "0x4444444444444444444444444444444444444444";
  await store.global.putAccount({ id: FREE, address: FREE, createdAt: Date.now(), paidUntil: 0, payments: [] });
  const { key: freeKey } = await accounts.walletFor(FREE).addAgent("bot");
  const app = createApp({ accounts, auth: createAuth({ password: "a-long-test-password", secure: false }), passJwks: publicJwks(key) });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (k) => fetch(`${base}/v1/pass`, { headers: { authorization: `Bearer ${k}` } }).then((r) => r.json());
  const { token } = await get(agentKey);
  assert.equal(verifyPass(token, key.publicKey).tier, "bronze");
  assert.equal((await get(freeKey)).token, null);
  assert.equal((await fetch(`${base}/v1/pass`)).status, 401);
  assert.equal(await accounts.passToken(OWNER), token, "kept, not signed again on every call");
});

test("phase 3: the dashboard shows what the pass's vault holds, asked from x402 Doctor with the proof", async (t) => {
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { store, accounts, key } = setup();
  const owner = privateKeyToAccount(generatePrivateKey());
  const asked = [];
  const vaultFetch = async (url, init) => { asked.push({ url, pass: init.headers["x-fizzl-pass"] }); return Response.json({ balance_usd: 0.042 }); };
  const app = createApp({ accounts, auth: createAuth({ password: "a-long-test-password", secure: false }), passJwks: publicJwks(key), vaultFetch, vaultUrl: "https://doctor.test/api/v1/vault" });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, cookie) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const m = await (await post("/api/signin/message", { address: owner.address })).json();
  const cookie = (await post("/api/signin", { nonce: m.nonce, signature: await owner.signMessage({ message: m.message }) })).headers.get("set-cookie").split(";")[0];
  const a = await store.global.getAccount(owner.address.toLowerCase()) ?? await store.global.getAccount(owner.address);
  await store.global.putAccount({ ...a, paidUntil: Date.now() + 5 * DAY });
  const r = await (await fetch(`${base}/api/pass`, { headers: { cookie } })).json();
  assert.equal(r.pass.vault_usd, 0.042);
  assert.deepEqual(asked, [{ url: "https://doctor.test/api/v1/vault", pass: r.pass.token }]);
});
