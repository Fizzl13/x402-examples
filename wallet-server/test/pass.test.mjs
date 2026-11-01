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

test("phase 4: the /pass page is served, and its seller example verifies a real proof (and refuses a changed one)", async (t) => {
  const { readFileSync } = await import("node:fs");
  const crypto = await import("node:crypto");
  const { accounts, key } = setup();
  const app = createApp({ accounts, auth: createAuth({ password: "a-long-test-password", secure: false }), passJwks: publicJwks(key) });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/pass`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /For sellers/);
  assert.match(await (await fetch(`http://127.0.0.1:${server.address().port}/sitemap.xml`)).text(), /wallet\.fizzl\.eu\/pass</);
  // The page's Node example, run as written (only the key fetch is replaced by the published key).
  const pre = [...readFileSync(new URL("../public/pass.html", import.meta.url), "utf8").matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]).find((x) => x.includes("checkPass"));
  const code = pre.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
    .replace(/^import .*$/m, "")
    .replace(/^const \{ keys \} = await .*$/m, "")
    + "\nreturn checkPass;";
  const checkPass = new Function("createPublicKey", "verify", "keys", code)(crypto.createPublicKey, crypto.verify, publicJwks(key).keys);
  const token = signPass({ iss: "wallet.fizzl.eu", tier: "bronze", until: Date.now() + DAY, wallets: [OWNER], iat: Date.now() }, key);
  assert.deepEqual([checkPass(token).tier, checkPass(token).wallets], ["bronze", [OWNER]]);
  const [h, b, s] = token.split(".");
  assert.equal(checkPass(`${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, "base64url")), tier: "gold" })).toString("base64url")}.${s}`), null);
  assert.equal(checkPass(signPass({ tier: "bronze", until: Date.now() - 1, wallets: [] }, key)), null);
  assert.equal(checkPass("nonsense"), null);
});

test("Silver that ends before Pro: the public check turns Bronze on its own, and the proof follows", async () => {
  let t = Date.now();
  const { store, accounts, key } = setup(() => t);
  await store.global.putAccount({ id: OWNER, address: OWNER, createdAt: t, paidUntil: t + 120 * DAY, tierUntil: { silver: t + 90 * DAY }, payments: [] });
  const r = await accounts.pass(OWNER);
  assert.deepEqual([r.pass.tier, r.pass.name], ["silver", "Fizzl Pass Silver"]);
  assert.equal(verifyPass(r.pass.token, key.publicKey, t).tier, "silver");
  assert.equal((await accounts.passStatus(OWNER)).pass.tier, "silver");
  t += 91 * DAY;
  assert.equal((await accounts.passStatus(OWNER)).pass.tier, "bronze", "no new index needed");
  assert.equal((await accounts.pass(OWNER)).pass.tier, "bronze");
  t += 30 * DAY;
  assert.equal((await accounts.passStatus(OWNER)).pass, null);
});

test("x402 sale: Doctor hands in the sale with the key; the buyer's wallet has the pass and fetches its proof with the claim id; once per payment", async (t) => {
  let now = Date.now();
  const { accounts, key } = setup(() => now);
  const app = createApp({ accounts, auth: createAuth({ password: "a-long-test-password", secure: false }), passJwks: publicJwks(key), passSaleKey: "a-long-pass-sale-test-value" });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const BUYER = "0x5555555555555555555555555555555555555555";
  const claim = "abcdefghijklmnopqrstuvwxyz012345";
  const sale = (body, auth = "Bearer a-long-pass-sale-test-value") => fetch(`${base}/hooks/pass-sale`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/v1/pass/claim/${claim}`)).status, 404);
  assert.equal((await sale({ wallet: BUYER, tier: "silver", tx: "0xtx1", claim }, "Bearer wrong")).status, 401);
  assert.equal((await sale({ wallet: BUYER, tier: "platinum", tx: "0xtx1", claim })).status, 400);
  const ok = await (await sale({ wallet: BUYER, tier: "silver", tx: "0xtx1", claim })).json();
  assert.equal(ok.pass.tier, "silver");
  assert.equal(Math.round((ok.pass.until - now) / DAY), 90);
  const c = await (await fetch(`${base}/v1/pass/claim/${claim}`)).json();
  assert.equal(c.pass.tier, "silver");
  assert.deepEqual(verifyPass(c.token, key.publicKey, now).wallets, [BUYER]);
  assert.equal((await accounts.passStatus(BUYER)).pass.tier, "silver");
  // The same payment again: nothing more.
  assert.equal((await (await sale({ wallet: BUYER, tier: "silver", tx: "0xtx1", claim })).json()).duplicate, true);
  // Another Silver extends it.
  const more = await (await sale({ wallet: BUYER, tier: "silver", tx: "0xtx2", claim: "abcdefghijklmnopqrstuvwxyz012346" })).json();
  assert.equal(Math.round((more.pass.until - now) / DAY), 180);
  // Bronze from an account next to a bought Silver: the higher tier counts.
  await accounts.passSale({ wallet: OWNER, tier: "gold", tx: "0xtx3", claim: "abcdefghijklmnopqrstuvwxyz012347" });
  assert.equal((await accounts.passStatus(OWNER)).pass.tier, "gold");
  now += 200 * DAY;
  assert.equal((await accounts.passStatus(BUYER)).pass, null);
  // Without PASS_SALE_KEY the hook isn't there.
  const off = createApp({ accounts, auth: createAuth({ password: "a-long-test-password", secure: false }) });
  const s2 = await new Promise((resolve) => { const s = off.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => s2.close());
  assert.equal((await fetch(`http://127.0.0.1:${s2.address().port}/hooks/pass-sale`, { method: "POST" })).status, 404);
});
