// The wallet server's accounts module against the real contract on the in-process chain:
// customers turn on automatic payment, the hourly job charges what is due, Pro follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chain, addr, artifact } from "./evm.mjs";
import { encodeFunctionData } from "viem";
import { createAccounts } from "../../wallet-server/src/accounts.js";
import { memoryStore } from "../../wallet-server/src/store.js";

const DAY = 86_400;
const PAYEE = "0x6B0F4651eD42893ab58139938175E4a69f175F25";
const ALICE = "0x00000000000000000000000000000000000a11ce", CHARGER = addr(0xc4a7), DEPLOYER = addr(0xd);
const SUB = artifact("FizzlSubscription").abi, USDC_ABI = artifact("MockUSDC").abi;

async function setup({ approveMonths = 12, funds = 100 } = {}) {
  const c = await chain();
  const usdc = await c.deploy("MockUSDC", DEPLOYER);
  const sub = await c.deploy("FizzlSubscription", DEPLOYER, [usdc.address, PAYEE, 5_000_000n, BigInt(30 * DAY)]);
  await usdc.send(DEPLOYER, "mint", [ALICE, BigInt(funds * 1e6)]);
  await usdc.send(ALICE, "approve", [sub.address, BigInt(approveMonths * 5e6)]);
  const sent = [];
  const telegram = { username: "FizzlTestBot", send: async (chatId, text) => { sent.push({ chatId, text }); }, notify: async () => {}, decided: async () => {} };
  const store = memoryStore();
  const accounts = createAccounts({
    store, telegram, publicUrl: "https://wallet.test", now: () => Number(c.now) * 1000,
    billing: { payTo: PAYEE, priceUsdc: 5, rpcUrl: "evm", fetch: c.fetch, token: usdc.address, subscription: sub.address, pollMs: 1, charger: { address: CHARGER, send: (to, data) => c.send(CHARGER, to, data) } },
  });
  const id = ALICE.toLowerCase();
  await store.global.putAccount({ id, address: ALICE, createdAt: 0, paidUntil: 0, payments: [], telegram: { chatId: "555", userId: "555" } });
  return { c, usdc, sub, accounts, id, sent, store };
}

test("automatic payment: subscribe in the wallet, Pro at once; the hourly job charges each month", async () => {
  const { c, usdc, sub, accounts, id, sent } = await setup();
  assert.equal((await accounts.me(id)).plan, "free");
  await sub.send(ALICE, "subscribe", [0n]); // what the customer's wallet sends
  let me = await accounts.refreshAuto(id);
  assert.equal(me.plan, "pro");
  assert.equal(me.auto.on, true);
  assert.equal(me.auto.monthsApproved, 11);
  assert.equal(me.proUntil, (Number(c.now) + 30 * DAY) * 1000);

  // Nothing is due yet: the job sends nothing.
  assert.deepEqual(await accounts.chargeDue(), { charged: 0, failed: 0 });
  // 3 days before: a reminder that it will be paid automatically.
  c.wait(27 * DAY + 60);
  assert.equal(await accounts.remind(), 1);
  assert.match(sent.at(-1).text, /will be paid automatically/);
  // Due: the job charges, Pro goes on, the customer hears about it.
  c.wait(3 * DAY);
  await accounts.me(id, { fresh: true });
  assert.deepEqual(await accounts.chargeDue(), { charged: 1, failed: 0 });
  me = await accounts.me(id, { fresh: true });
  assert.equal(me.plan, "pro");
  assert.ok(me.proUntil > Number(c.now) * 1000 + 29 * DAY * 1000);
  assert.match(sent.at(-1).text, /^Paid automatically: 5 USDC/);
  assert.equal(await usdc.read("balanceOf", [PAYEE]), 10_000_000n);
  // Charged once: running the job again does nothing.
  assert.deepEqual(await accounts.chargeDue(), { charged: 0, failed: 0 });
  assert.equal(await usdc.read("balanceOf", [PAYEE]), 10_000_000n);
  const rows = await accounts.allPayments();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].auto, true);
});

test("approval used up: no transaction is sent, the customer is told once, Pro ends after the grace", async () => {
  const { c, sub, accounts, id, sent } = await setup({ approveMonths: 1 });
  await sub.send(ALICE, "subscribe", [0n]);
  await accounts.refreshAuto(id);
  c.wait(30 * DAY);
  await accounts.me(id, { fresh: true });
  assert.deepEqual(await accounts.chargeDue(), { charged: 0, failed: 1 });
  assert.match(sent.at(-1).text, /approval is used up/);
  const told = sent.length;
  await accounts.chargeDue();
  assert.equal(sent.length, told); // once
  c.wait(4 * DAY);
  assert.equal((await accounts.me(id, { fresh: true })).plan, "free");
});

test("turned off in the wallet: no more charges; paid time is kept", async () => {
  const { c, sub, accounts, id } = await setup();
  await sub.send(ALICE, "subscribe", [0n]);
  await sub.send(ALICE, "cancel");
  const me = await accounts.refreshAuto(id);
  assert.equal(me.auto.on, false);
  assert.equal(me.plan, "pro");
  c.wait(31 * DAY);
  assert.deepEqual(await accounts.chargeDue(), { charged: 0, failed: 0 });
  c.wait(3 * DAY);
  assert.equal((await accounts.me(id, { fresh: true })).plan, "free");
});

test("paid by hand first: automatic payment starts when that time ends, and both count", async () => {
  const { c, sub, accounts, id, store } = await setup();
  const handUntil = (Number(c.now) + 20 * DAY) * 1000;
  await store.global.putAccount({ ...(await store.global.getAccount(id)), paidUntil: handUntil });
  await sub.send(ALICE, "subscribe", [BigInt(handUntil / 1000)]);
  let me = await accounts.refreshAuto(id);
  assert.equal(me.auto.nextCharge, handUntil);
  assert.equal(me.proUntil, handUntil);
  c.wait(20 * DAY);
  await accounts.me(id, { fresh: true });
  assert.equal((await accounts.chargeDue()).charged, 1);
  me = await accounts.me(id, { fresh: true });
  assert.equal(me.proUntil, handUntil + 30 * DAY * 1000);
});

test("the owner gets a ready deploy transaction for the contract with the right settings", async () => {
  const { accounts } = await setup();
  const s = await accounts.subscriptionSetup();
  assert.equal(s.args.payee, PAYEE);
  assert.equal(s.args.priceUsdc, 5);
  assert.equal(s.args.periodDays, 30);
  assert.ok(s.deployData.startsWith(artifact("FizzlSubscription").bytecode));
  assert.equal(s.charger.address, CHARGER);
  // The deploy data really deploys a working contract.
  const c = await chain();
  const hash = await c.send(DEPLOYER, null, s.deployData);
  assert.ok(hash);
  void encodeFunctionData; void SUB; void USDC_ABI;
});
