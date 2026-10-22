// The allowance contract on an in-process EVM with a mock USDC and a clock we move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chain, addr } from "./evm.mjs";

const HOUR = 3_600, DAY = 86_400;
const usd = (n) => BigInt(Math.round(n * 1e6));
const DEPLOYER = addr(0xd), ALICE = addr(0xa11ce), BOB = addr(0xb0b), AGENT = addr(0xa9e47), OTHER_AGENT = addr(0xa9e48), STRANGER = addr(0x5), SHOP = addr(0x5409);

async function setup({ funds = usd(100), approve = usd(60) } = {}) {
  const c = await chain();
  const usdc = await c.deploy("MockUSDC", DEPLOYER);
  const al = await c.deploy("FizzlAgentAllowance", DEPLOYER, [usdc.address]);
  for (const who of [ALICE, BOB]) {
    await usdc.send(DEPLOYER, "mint", [who, funds]);
    await usdc.send(who, "approve", [al.address, approve]);
  }
  const bal = async (who) => usdc.read("balanceOf", [who]);
  const spend = (amount) => usdc.send(AGENT, "transfer", [SHOP, amount]); // the agent pays someone
  return { c, usdc, al, bal, spend };
}
const rejects = (p, reason) => assert.rejects(p, (e) => e.reason === reason);

test("deployed for one token; nothing can be changed and there is no owner", async () => {
  const { usdc, al } = await setup();
  assert.equal((await al.read("token")).toLowerCase(), usdc.address.toLowerCase());
  const c = await chain();
  await assert.rejects(c.deploy("FizzlAgentAllowance", DEPLOYER, [addr(0)]));
});

test("setLimit: checked; only the owner's own limits, never for themselves or the zero address", async () => {
  const { al } = await setup();
  for (const [agent, per, period, float] of [
    [addr(0), usd(20), DAY, usd(5)], [ALICE, usd(20), DAY, usd(5)], [AGENT, 0n, DAY, usd(5)], [AGENT, usd(20), DAY, 0n],
    [AGENT, usd(20), DAY, usd(21)], [AGENT, usd(20), HOUR - 1, usd(5)], [AGENT, usd(20), 365 * DAY + 1, usd(5)],
  ]) await rejects(al.send(ALICE, "setLimit", [agent, per, period, float]), "BadLimit");
  const { events } = await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  assert.deepEqual(events.map((e) => [e.eventName, e.args.perPeriod, e.args.period, e.args.float]), [["LimitSet", usd(20), BigInt(DAY), usd(5)]]);
  const [perPeriod, float, period] = await al.read("limits", [ALICE, AGENT]);
  assert.deepEqual([perPeriod, float, period], [usd(20), usd(5), DAY]);
});

test("topUp: anyone can call it; it fills the agent's wallet to its float from the owner's wallet, and no further", async () => {
  const { al, bal, spend } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  const { events } = await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  assert.deepEqual(events.map((e) => [e.eventName, e.args.amount, e.args.spentThisPeriod]), [["ToppedUp", usd(5), usd(5)]]);
  assert.equal(await bal(AGENT), usd(5));
  assert.equal(await bal(ALICE), usd(95));
  await rejects(al.send(STRANGER, "topUp", [ALICE, AGENT]), "Full");
  await spend(usd(2)); // the agent paid for something
  await al.send(AGENT, "topUp", [ALICE, AGENT]);
  assert.equal(await bal(AGENT), usd(5));
  assert.equal(await bal(ALICE), usd(93));
  assert.deepEqual(await al.read("available", [ALICE, AGENT]), [0n, usd(13), BigInt((await al.read("limits", [ALICE, AGENT]))[3]) + BigInt(DAY)]);
});

test("a leaked agent key: the thief gets at most the period's limit from the owner, then nothing until the next period", async () => {
  const { c, al, bal, spend } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  let taken = 0n;
  for (;;) {
    try { await al.send(AGENT, "topUp", [ALICE, AGENT]); } catch (e) { assert.equal(e.reason, "LimitReached"); break; }
    const b = await bal(AGENT); await spend(b); taken += b; // emptied straight away
  }
  assert.equal(taken, usd(20));
  assert.equal(await bal(ALICE), usd(80)); // the rest stays with the owner
  c.wait(DAY - 1);
  await rejects(al.send(AGENT, "topUp", [ALICE, AGENT]), "LimitReached");
  c.wait(1); // a new period
  await al.send(AGENT, "topUp", [ALICE, AGENT]);
  assert.equal(await bal(AGENT), usd(5));
});

test("the last top-up of a period is cut to what is left of the limit", async () => {
  const { al, bal, spend } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(12), DAY, usd(5)]);
  for (let i = 0; i < 2; i++) { await al.send(STRANGER, "topUp", [ALICE, AGENT]); await spend(usd(5)); }
  const { events } = await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  assert.equal(events[0].args.amount, usd(2));
  assert.equal(await bal(AGENT), usd(2));
});

test("stop: no more top-ups, what the agent holds stays; turning it back on in the same period doesn't reset what was sent", async () => {
  const { al, bal, spend } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(10), DAY, usd(5)]);
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  await spend(usd(5));
  const { events } = await al.send(ALICE, "stop", [AGENT]);
  assert.equal(events[0].eventName, "Stopped");
  await rejects(al.send(STRANGER, "topUp", [ALICE, AGENT]), "NoLimit");
  await rejects(al.send(ALICE, "stop", [AGENT]), "NoLimit");
  assert.deepEqual(await al.read("available", [ALICE, AGENT]), [0n, 0n, 0n]);
  await al.send(ALICE, "setLimit", [AGENT, usd(10), DAY, usd(5)]); // back on, same period: 5 of 10 already sent
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  await spend(usd(5));
  await rejects(al.send(STRANGER, "topUp", [ALICE, AGENT]), "LimitReached");
  assert.equal(await bal(ALICE), usd(90));
});

test("raising the limit mid-period keeps what was sent; a bigger float tops up the difference", async () => {
  const { al, bal } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(10), DAY, usd(5)]);
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(8)]);
  const { events } = await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  assert.deepEqual([events[0].args.amount, events[0].args.spentThisPeriod], [usd(3), usd(8)]);
  assert.equal(await bal(AGENT), usd(8));
});

test("the owner's approval is a hard cap on top of the limits; a token that returns false is a failed payment", async () => {
  const { usdc, al } = await setup({ approve: usd(7) });
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  await usdc.send(AGENT, "transfer", [SHOP, usd(5)]);
  await rejects(al.send(STRANGER, "topUp", [ALICE, AGENT]), "allowance"); // 2 left of the approval, 5 wanted
  await usdc.send(ALICE, "approve", [al.address, 0n]); // the owner pulls the approval: everything stops
  await rejects(al.send(STRANGER, "topUp", [ALICE, AGENT]), "allowance");
  const t = await setup();
  await t.al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  await t.usdc.send(DEPLOYER, "setReturnFalse", [true]);
  await rejects(t.al.send(STRANGER, "topUp", [ALICE, AGENT]), "PaymentFailed");
});

test("owners and agents are kept apart: a top-up only moves money from that owner to that agent", async () => {
  const { al, bal } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  await al.send(BOB, "setLimit", [OTHER_AGENT, usd(20), DAY, usd(3)]);
  await rejects(al.send(STRANGER, "topUp", [BOB, AGENT]), "NoLimit"); // Bob never set a limit for Alice's agent
  await rejects(al.send(STRANGER, "topUp", [ALICE, OTHER_AGENT]), "NoLimit");
  await al.send(STRANGER, "topUp", [BOB, OTHER_AGENT]);
  assert.deepEqual([await bal(ALICE), await bal(BOB), await bal(OTHER_AGENT), await bal(AGENT)], [usd(100), usd(97), usd(3), 0n]);
});

test("an agent wallet that already holds money gets only the difference, and none when it has its float", async () => {
  const { usdc, al, bal } = await setup();
  await usdc.send(DEPLOYER, "mint", [AGENT, usd(3)]);
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  assert.equal((await al.read("available", [ALICE, AGENT]))[0], usd(2));
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  assert.equal(await bal(AGENT), usd(5));
  await usdc.send(DEPLOYER, "mint", [AGENT, usd(10)]);
  await rejects(al.send(STRANGER, "topUp", [ALICE, AGENT]), "Full");
});

test("available() after a period ends: the full limit again, and a period end counted from now", async () => {
  const { c, al, spend } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(10), DAY, usd(5)]);
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  await spend(usd(5));
  c.wait(2 * DAY);
  assert.deepEqual(await al.read("available", [ALICE, AGENT]), [usd(5), usd(10), c.now + BigInt(DAY)]);
});

test("a top-up costs little gas", async () => {
  const { al, spend } = await setup();
  await al.send(ALICE, "setLimit", [AGENT, usd(20), DAY, usd(5)]);
  await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  await spend(usd(5));
  const { gas } = await al.send(STRANGER, "topUp", [ALICE, AGENT]);
  assert.ok(gas < 60_000n, `${gas}`);
});
