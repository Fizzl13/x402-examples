// Against a stand-in Privy API: no network, no Privy account. The stand-in checks every write's
// authorization signature with the owner's public key, the way Privy does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import canonicalize from "canonicalize";
import { setValues, checkList, checksumAddress, privyClient, syncSet, run } from "../sync.mjs";

const APP_ID = "test-app";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const AUTH_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

const SOL = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi";
const SOL_USDC = "B1jUqZENAXMJxBu3pX9v1yq2QDtMeXz1CUiFMr9hsi4f";
const SOL_USDT = "DBbBgTWUw4ZBHSoJqxqMxbBVwjzjFeG5ABWKJW2Ah5ZL";
const TRON = "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81";
const BTC = "bc1qjzk63wwatq2f638psymq3qapn00aqgksyx56l3t8eg7zuuccwasq498khf";
const XRP = "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66";
const ETH = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";

// A list shaped like GET /v1/sanctions, padded with EVM addresses to `size`.
function sanctionsList({ size = 120, checkedAt = new Date().toISOString(), extraEvm = [] } = {}) {
  const evm = [ETH, ...extraEvm];
  // Letters in every address, so its checksum casing differs from the lowercase one.
  for (let i = evm.length; evm.length < size - 4; i++) evm.push("0x" + i.toString(16).padStart(6, "0") + "c".repeat(34));
  return {
    list: "OFAC SDN",
    published: "2026-10-13",
    checkedAt,
    count: size,
    addresses: [
      ...evm.map((address) => ({ address, entries: [{ currency: "ETH" }] })),
      { address: SOL, entries: [{ currency: "SOL" }], tokenAccounts: { USDC: SOL_USDC, USDT: SOL_USDT } },
      { address: TRON, entries: [{ currency: "TRX" }] },
      { address: BTC, entries: [{ currency: "XBT" }] },
      { address: XRP, entries: [{ currency: "XRP" }] },
    ],
  };
}

// The stand-in API: condition sets in memory, every request recorded in order.
function fakePrivy({ sets = {}, pageSize = 100 } = {}) {
  const calls = [];
  let nextId = 1;
  const store = Object.fromEntries(Object.entries(sets).map(([id, values]) => [id, values.map((value) => ({ id: `item${nextId++}`.padEnd(24, "0"), condition_set_id: id, value }))]));
  async function fetchImpl(url, { method = "GET", headers = {}, body } = {}) {
    const u = new URL(url);
    const parsed = body ? JSON.parse(body) : undefined;
    calls.push({ method, path: u.pathname, body: parsed });
    assert.equal(headers.authorization, "Basic " + Buffer.from(`${APP_ID}:secret`).toString("base64"));
    assert.equal(headers["privy-app-id"], APP_ID);
    if (method !== "GET") {
      const payload = canonicalize({ version: 1, method, url: `${u.origin}${u.pathname}`, body: parsed ?? "", headers: { "privy-app-id": APP_ID } });
      const ok = verify("sha256", Buffer.from(payload), { key: publicKey, dsaEncoding: "der" }, Buffer.from(headers["privy-authorization-signature"], "base64"));
      if (!ok) return new Response(JSON.stringify({ error: "invalid authorization signature" }), { status: 401 });
    }
    const m = u.pathname.match(/^\/v1\/condition_sets\/([^/]+)\/condition_set_items(?:\/([^/]+))?$/);
    if (!m || !store[m[1]]) return new Response("{}", { status: 404 });
    const items = store[m[1]];
    if (method === "GET") {
      const start = Number(u.searchParams.get("cursor") || 0);
      const page = items.slice(start, start + pageSize);
      return Response.json({ items: page, next_cursor: start + pageSize < items.length ? String(start + pageSize) : null });
    }
    if (method === "POST") {
      assert.ok(parsed.length >= 1 && parsed.length <= 100, "1 to 100 items per POST");
      const added = parsed.map(({ value }) => ({ id: `item${nextId++}`.padEnd(24, "0"), condition_set_id: m[1], value }));
      items.push(...added);
      return Response.json(added);
    }
    if (method === "DELETE") {
      const at = items.findIndex((i) => i.id === m[2]);
      if (at === -1) return new Response("{}", { status: 404 });
      items.splice(at, 1);
      return Response.json({ success: true });
    }
    return new Response("{}", { status: 405 });
  }
  return { fetchImpl, calls, values: (id) => store[id].map((i) => i.value).sort() };
}

const client = (fake) => privyClient({ appId: APP_ID, appSecret: "secret", authorizationKey: AUTH_KEY, baseUrl: "https://privy.test", fetchImpl: fake.fetchImpl });

test("EIP-55 checksums (the EIP's own test vectors)", () => {
  assert.equal(checksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  assert.equal(checksumAddress("0xFB6916095CA1DF60BB79CE92CE3EA74C37C5D359"), "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
});

test("values per set: EVM in both casings; Solana owners with their token accounts; Tron, Bitcoin and XRPL left out", () => {
  const list = sanctionsList({ size: 6 });
  const both = setValues(list);
  assert.deepEqual(both.solana, [SOL, SOL_USDC, SOL_USDT].sort());
  assert.ok(both.evm.includes(ETH) && both.evm.includes(checksumAddress(ETH)));
  assert.equal(both.evm.length, 2 * 2, "two EVM addresses, each twice");
  assert.ok(![TRON, BTC, XRP].some((a) => both.evm.includes(a) || both.solana.includes(a)));
  assert.deepEqual(setValues(list, { evmCasing: "lower" }).evm, [ETH, "0x000001" + "c".repeat(34)].sort());
  assert.deepEqual(setValues({ addresses: [{ address: "0x" + "1".repeat(40) }] }).evm, ["0x" + "1".repeat(40)], "no letters: one form");
});

test("a stale or short list is refused, so the sets keep their last good contents", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.throws(() => checkList(sanctionsList({ checkedAt: "2026-10-10T12:00:00Z" }), { now }), /more than 72 hours ago/);
  assert.throws(() => checkList(sanctionsList({ size: 20, checkedAt: "2026-10-14T11:00:00Z" }), { now }), /only 20 addresses/);
  assert.doesNotThrow(() => checkList(sanctionsList({ checkedAt: "2026-10-14T11:00:00Z" }), { now }));
});

test("first run: every value added in batches of at most 100, each write signed by the owner key", async () => {
  const fake = fakePrivy({ sets: { evmset: [] } });
  const wanted = setValues(sanctionsList({ size: 120 })).evm; // 116 EVM addresses x 2 casings
  const result = await syncSet(client(fake), "evmset", wanted);
  assert.deepEqual(result, { set: "evmset", before: 0, added: 232, removed: 0, after: 232 });
  assert.deepEqual(fake.values("evmset"), wanted);
  assert.deepEqual(fake.calls.filter((c) => c.method === "POST").map((c) => c.body.length), [100, 100, 32]);
});

test("an update adds the new addresses before it removes delisted ones (the set never lacks a listed address)", async () => {
  const fake = fakePrivy({ sets: { solset: [SOL, SOL_USDC, "So11111111111111111111111111111111111111112", SOL_USDC] }, pageSize: 2 });
  const result = await syncSet(client(fake), "solset", [SOL, SOL_USDC, SOL_USDT].sort(), { maxRemoveShare: 0.5 });
  assert.deepEqual(result, { set: "solset", before: 4, added: 1, removed: 2, after: 3 });
  assert.deepEqual(fake.values("solset"), [SOL, SOL_USDC, SOL_USDT].sort());
  const writes = fake.calls.filter((c) => c.method !== "GET").map((c) => c.method);
  assert.deepEqual(writes, ["POST", "DELETE", "DELETE"], "adds first, then removes the delisted value and the duplicate");
  assert.equal(fake.calls.filter((c) => c.method === "GET").length, 2, "read across pages");
});

test("an unusually large removal is refused unless FORCE; an empty target is always refused", async () => {
  const fake = fakePrivy({ sets: { evmset: ["0xa", "0xb", "0xc", "0xd"] } });
  await assert.rejects(syncSet(client(fake), "evmset", ["0xa"]), /would remove 3 of 4 items/);
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, 0, "nothing written");
  await syncSet(client(fake), "evmset", ["0xa"], { force: true });
  assert.deepEqual(fake.values("evmset"), ["0xa"]);
  await assert.rejects(syncSet(client(fake), "evmset", []), /refusing to empty/);
});

test("a wrong authorization key is refused by the API and stops the run", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const fake = fakePrivy({ sets: { evmset: [] } });
  const bad = privyClient({ appId: APP_ID, appSecret: "secret", authorizationKey: other, baseUrl: "https://privy.test", fetchImpl: fake.fetchImpl });
  await assert.rejects(syncSet(bad, "evmset", ["0xa"]), /HTTP 401/);
});

test("run: fetches the list, syncs both sets, prints one audit line; DRY_RUN writes nothing", async () => {
  const fake = fakePrivy({ sets: { evmset: [], solset: [] } });
  const list = sanctionsList({ size: 110 });
  const fetchImpl = (url, init) => (String(url).startsWith("https://lists.test") ? Promise.resolve(Response.json(list)) : fake.fetchImpl(url, init));
  const env = { SANCTIONS_URL: "https://lists.test/v1/sanctions", PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret", PRIVY_AUTHORIZATION_KEY: AUTH_KEY, PRIVY_API_URL: "https://privy.test", PRIVY_EVM_SET_ID: "evmset", PRIVY_SOLANA_SET_ID: "solset" };
  const lines = [];

  const dry = await run({ ...env, DRY_RUN: "1" }, { fetchImpl, log: (l) => lines.push(l) });
  assert.equal(dry.sets.evm.added, 212);
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, 0, "a dry run writes nothing");

  const record = await run(env, { fetchImpl, log: (l) => lines.push(l) });
  assert.deepEqual(record.sets.solana, { set: "solset", before: 0, added: 3, removed: 0, after: 3 });
  assert.equal(record.published, "2026-10-13");
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(lines.at(-1)), record);
  const again = await run(env, { fetchImpl, log: () => {} });
  assert.deepEqual([again.sets.evm.added, again.sets.evm.removed, again.sets.solana.added], [0, 0, 0], "a second run changes nothing");

  await assert.rejects(run({ ...env, PRIVY_AUTHORIZATION_KEY: "" }, { fetchImpl }), /PRIVY_AUTHORIZATION_KEY is not set/);
});

test("--print: the values per set without Privy credentials, and nothing sent to Privy", async () => {
  const list = sanctionsList({ size: 110 });
  const asked = [];
  const out = await run({ SANCTIONS_URL: "https://lists.test/v1/sanctions" }, {
    print: true, log: () => {}, fetchImpl: (url) => { asked.push(String(url)); return Promise.resolve(Response.json(list)); },
  });
  assert.deepEqual(asked, ["https://lists.test/v1/sanctions"]);
  assert.deepEqual(out.solana, [SOL, SOL_USDC, SOL_USDT].sort());
  assert.equal(out.evm.length, 212);
});
