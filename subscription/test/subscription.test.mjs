// The subscription contract on an in-process EVM with a mock USDC and a clock we move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chain, addr } from "./evm.mjs";

const DAY = 86_400;
const PRICE = 5_000_000n; // 5 USDC
const PAYEE = addr(0xfee), DEPLOYER = addr(0xd), ALICE = addr(0xa11ce), BOB = addr(0xb0b), STRANGER = addr(0x5);

async function setup({ funds = 100_000_000n, approve = 60_000_000n } = {}) {
  const c = await chain();
  const usdc = await c.deploy("MockUSDC", DEPLOYER);
  const sub = await c.deploy("FizzlSubscription", DEPLOYER, [usdc.address, PAYEE, PRICE, BigInt(30 * DAY)]);
  for (const who of [ALICE, BOB]) {
    await usdc.send(DEPLOYER, "mint", [who, funds]);
    await usdc.send(who, "approve", [sub.address, approve]);
  }
  const bal = async (who) => usdc.read("balanceOf", [who]);
  return { c, usdc, sub, bal };
}
const rejects = (p, reason) => assert.rejects(p, (e) => e.reason === reason);

test("deployed with fixed token, payee, price and period; nothing can be changed", async () => {
  const { usdc, sub } = await setup();
  assert.equal((await sub.read("token")).toLowerCase(), usdc.address.toLowerCase());
  assert.equal((await sub.read("payee")).toLowerCase(), PAYEE);
  assert.equal(await sub.read("price"), PRICE);
  assert.equal(await sub.read("period"), BigInt(30 * DAY));
  const c = await chain();
  await assert.rejects(c.deploy("FizzlSubscription", DEPLOYER, [usdc.address, addr(0), PRICE, BigInt(30 * DAY)]));
  await assert.rejects(c.deploy("FizzlSubscription", DEPLOYER, [usdc.address, PAYEE, 0n, BigInt(30 * DAY)]));
});

test("subscribe now: the first period is paid at once, straight to the payee", async () => {
  const { c, sub, bal } = await setup();
  const { events } = await sub.send(ALICE, "subscribe", [0n]);
  assert.deepEqual(events.map((e) => e.eventName), ["Subscribed", "Charged"]);
  assert.equal(await bal(PAYEE), PRICE);
  assert.equal(await bal(ALICE), 95_000_000n);
  assert.equal(await sub.read("paidThrough", [ALICE]), c.now + BigInt(30 * DAY));
  assert.equal(await sub.read("dueAt", [ALICE]), c.now + BigInt(30 * DAY));
  assert.equal(await sub.read("isDue", [ALICE]), false);
});

test("charges: anyone can trigger one when due, never early, never twice per period", async () => {
  const { c, sub, bal } = await setup();
  await sub.send(ALICE, "subscribe", [0n]);
  const start = c.now;
  await rejects(sub.send(STRANGER, "charge", [ALICE]), "NotDue");
  c.wait(29 * DAY);
  await rejects(sub.send(STRANGER, "charge", [ALICE]), "NotDue");
  c.wait(DAY);
  assert.equal(await sub.read("isDue", [ALICE]), true);
  await sub.send(STRANGER, "charge", [ALICE]);
  await rejects(sub.send(STRANGER, "charge", [ALICE]), "NotDue");
  assert.equal(await bal(PAYEE), 2n * PRICE);
  // On time: the next period follows the last one, no gap and no overlap.
  assert.equal(await sub.read("paidThrough", [ALICE]), start + BigInt(60 * DAY));
  // A stranger can't charge someone who never subscribed.
  await rejects(sub.send(STRANGER, "charge", [BOB]), "NotSubscribed");
  assert.equal(await bal(BOB), 100_000_000n);
});

test("a late charge (after the grace) starts a new period from now: no paying for lost time", async () => {
  const { c, sub } = await setup();
  await sub.send(ALICE, "subscribe", [0n]);
  const due = await sub.read("dueAt", [ALICE]);
  c.wait(32 * DAY); // 2 days late: within the 3-day grace
  await sub.send(STRANGER, "charge", [ALICE]);
  assert.equal(await sub.read("paidThrough", [ALICE]), due + BigInt(30 * DAY));
  c.wait(40 * DAY); // way past due + grace
  await sub.send(STRANGER, "charge", [ALICE]);
  assert.equal(await sub.read("paidThrough", [ALICE]), c.now + BigInt(30 * DAY));
});

test("subscribe later: nothing is charged until time already paid for ends", async () => {
  const { c, sub, bal } = await setup();
  const later = c.now + BigInt(10 * DAY);
  const { events } = await sub.send(ALICE, "subscribe", [later]);
  assert.deepEqual(events.map((e) => e.eventName), ["Subscribed"]);
  assert.equal(await bal(PAYEE), 0n);
  assert.equal(await sub.read("paidThrough", [ALICE]), 0n); // a promise is not a payment
  await rejects(sub.send(STRANGER, "charge", [ALICE]), "NotDue");
  c.wait(10 * DAY);
  await sub.send(STRANGER, "charge", [ALICE]);
  assert.equal(await bal(PAYEE), PRICE);
  await rejects(sub.send(ALICE, "subscribe", [c.now + BigInt(401 * DAY)]), "StartTooLate");
});

test("cancel: no more charges, paid time kept; subscribing again doesn't charge twice for it", async () => {
  const { c, sub, bal } = await setup();
  await sub.send(ALICE, "subscribe", [0n]);
  const through = await sub.read("paidThrough", [ALICE]);
  const { events } = await sub.send(ALICE, "cancel");
  assert.equal(events[0].eventName, "Cancelled");
  assert.equal(await sub.read("dueAt", [ALICE]), 0n);
  c.wait(31 * DAY);
  await rejects(sub.send(STRANGER, "charge", [ALICE]), "NotSubscribed");
  await rejects(sub.send(ALICE, "cancel"), "NotSubscribed");
  assert.equal(await sub.read("paidThrough", [ALICE]), through);
  // Back within the paid time: the next charge waits until it ends.
  const c2 = await setup();
  await c2.sub.send(ALICE, "subscribe", [0n]);
  await c2.sub.send(ALICE, "cancel");
  c2.c.wait(5 * DAY);
  await c2.sub.send(ALICE, "subscribe", [0n]);
  assert.equal(await c2.bal(PAYEE), PRICE);
  assert.equal(await c2.sub.read("dueAt", [ALICE]), await c2.sub.read("paidThrough", [ALICE]));
  assert.equal(await bal(PAYEE), PRICE);
});

test("the approval caps what can ever be taken; no approval or no funds means no charge", async () => {
  const { c, sub, bal } = await setup({ approve: 10_000_000n }); // two months
  await sub.send(ALICE, "subscribe", [0n]);
  c.wait(30 * DAY);
  await sub.send(STRANGER, "charge", [ALICE]);
  c.wait(30 * DAY);
  await rejects(sub.send(STRANGER, "charge", [ALICE]), "allowance");
  assert.equal(await bal(PAYEE), 10_000_000n);
  assert.equal(await sub.read("isDue", [ALICE]), true); // still due: it failed as a whole

  const poor = await setup({ funds: 1_000_000n });
  await rejects(poor.sub.send(ALICE, "subscribe", [0n]), "balance");
  assert.equal(await poor.sub.read("dueAt", [ALICE]), 0n); // the whole subscribe was undone
});

test("a token that says no is a failed payment, not a free month", async () => {
  const { usdc, sub } = await setup();
  await usdc.send(DEPLOYER, "setReturnFalse", [true]);
  await rejects(sub.send(ALICE, "subscribe", [0n]), "PaymentFailed");
  assert.equal(await sub.read("paidThrough", [ALICE]), 0n);
});

test("customers are separate: one's charge never touches another", async () => {
  const { c, sub, bal } = await setup();
  await sub.send(ALICE, "subscribe", [0n]);
  c.wait(15 * DAY);
  await sub.send(BOB, "subscribe", [0n]);
  c.wait(15 * DAY);
  await sub.send(STRANGER, "charge", [ALICE]);
  await rejects(sub.send(STRANGER, "charge", [BOB]), "NotDue");
  assert.equal(await bal(ALICE), 90_000_000n);
  assert.equal(await bal(BOB), 95_000_000n);
});
