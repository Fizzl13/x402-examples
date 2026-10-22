// The wallet server's side (../wallet-server/src/allowance.js) against the contract on the in-process EVM:
// the state it shows, the transactions it builds for the owner, and top-ups paid by the charger wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi } from "viem";
import { chain, addr, artifact } from "./evm.mjs";
import { createAllowance } from "../../wallet-server/src/allowance.js";

const DEPLOYER = addr(0xd), OWNER = addr(0xa11ce), AGENT = addr(0xa9e47), CHARGER = addr(0xc4a), SHOP = addr(0x5409);
const usd = (n) => BigInt(Math.round(n * 1e6));

async function setup({ approve = usd(30), funds = usd(100), charger = true } = {}) {
  const c = await chain();
  const usdc = await c.deploy("MockUSDC", DEPLOYER);
  const al = await c.deploy("FizzlAgentAllowance", DEPLOYER, [usdc.address]);
  await usdc.send(DEPLOYER, "mint", [OWNER, funds]);
  const sent = [];
  let clock = 1_000_000;
  const allowance = createAllowance({
    contract: al.address, token: usdc.address, rpc: c.rpc, sleep: async () => {}, now: () => (clock += 61_000),
    charger: charger ? { address: CHARGER, send: async (to, data) => { sent.push(data); return c.send(CHARGER, to, data); } } : null,
  });
  // The owner signs what the dashboard hands them, from their own wallet.
  const sign = async (t) => { const h = await c.send(OWNER, t.to, t.data); assert.equal((await c.rpc("eth_getTransactionReceipt", [h])).status, "0x1"); };
  const turnOn = async (o = {}) => { const t = allowance.turnOnTxs(AGENT, { perDayUsdc: 20, floatUsdc: 5, approveUsdc: Number(approve) / 1e6, ...o }); await sign(t.approve); await sign(t.setLimit); };
  const bal = (who) => usdc.read("balanceOf", [who]);
  return { c, usdc, al, allowance, sign, turnOn, bal, sent };
}

test("turning it on: the owner signs an approval and the limit (a day), built by the server; the state shows it", async () => {
  const { allowance, turnOn } = await setup();
  const off = await allowance.status(OWNER, AGENT);
  assert.equal(off.on, false);
  const t = allowance.turnOnTxs(AGENT, { perDayUsdc: 20, floatUsdc: 5, approveUsdc: 30 });
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: t.approve.data }).args.map((x) => String(x).toLowerCase()), [allowance.contract.toLowerCase(), String(usd(30))]);
  const { args } = decodeFunctionData({ abi: artifact("FizzlAgentAllowance").abi, data: t.setLimit.data });
  assert.deepEqual(args.map((x) => String(x).toLowerCase()), [AGENT, String(usd(20)), "86400", String(usd(5))]);
  await turnOn();
  const s = await allowance.status(OWNER, AGENT);
  assert.deepEqual([s.on, s.perPeriodUsdc, s.floatUsdc, s.periodSeconds, s.topUpNowUsdc, s.leftThisPeriodUsdc, s.approvalUsdc, s.ownerBalanceUsdc, s.agentBalanceUsdc], [true, 20, 5, 86400, 5, 20, 30, 100, 0]);
});

test("turnOnTxs refuses what makes no sense", async () => {
  const { allowance } = await setup();
  assert.throws(() => allowance.turnOnTxs(AGENT, { perDayUsdc: 0, floatUsdc: 5, approveUsdc: 30 }), /above 0/);
  assert.throws(() => allowance.turnOnTxs(AGENT, { perDayUsdc: 5, floatUsdc: 10, approveUsdc: 30 }), /can't be more than the limit per day/);
  assert.throws(() => allowance.turnOnTxs(AGENT, { perDayUsdc: 20, floatUsdc: 5, approveUsdc: 10 }), /at least the limit per day/);
  assert.throws(() => allowance.turnOnTxs(null, { perDayUsdc: 20, floatUsdc: 5, approveUsdc: 30 }), /no wallet address/);
});

test("top-up: the charger pays the gas and the agent's wallet is filled to its float; not again while it has enough", async () => {
  const { allowance, turnOn, bal, usdc, sent } = await setup();
  await turnOn();
  const r = await allowance.topUp(OWNER, AGENT);
  assert.equal(r.toppedUp, 5);
  assert.match(r.tx, /^0x[0-9a-f]{64}$/);
  assert.equal(await bal(AGENT), usd(5));
  assert.equal(r.status.sentThisPeriodUsdc, 5);
  assert.equal((await allowance.topUp(OWNER, AGENT)).reason, "the agent's wallet has enough");
  await usdc.send(AGENT, "transfer", [SHOP, usd(2)]); // 3 left: more than half the float
  assert.equal((await allowance.topUp(OWNER, AGENT)).reason, "the agent's wallet has enough");
  assert.equal((await allowance.topUp(OWNER, AGENT, { needUsdc: 4 })).toppedUp, 2); // but short for a $4 payment
  assert.equal(sent.length, 2);
});

test("top-up refusals say why, and send nothing", async () => {
  const { c, allowance, turnOn, usdc, sign, sent } = await setup({ approve: usd(20) });
  assert.match((await allowance.topUp(OWNER, AGENT)).reason, /no on-chain limit/);
  await turnOn({ perDayUsdc: 10, approveUsdc: 20 });
  for (let i = 0; i < 2; i++) { await allowance.topUp(OWNER, AGENT); await usdc.send(AGENT, "transfer", [SHOP, usd(5)]); }
  assert.match((await allowance.topUp(OWNER, AGENT)).reason, /limit for today is used up/);
  c.wait(86_400);
  await sign({ to: usdc.address, data: allowance.turnOnTxs(AGENT, { perDayUsdc: 10, floatUsdc: 5, approveUsdc: 10 }).approve.data.replace(/[0-9a-f]{64}$/, "0".repeat(64)) }); // approval to 0
  assert.match((await allowance.topUp(OWNER, AGENT)).reason, /approval for the contract is used up/);
  await sign(allowance.stopTx(AGENT));
  assert.match((await allowance.topUp(OWNER, AGENT)).reason, /no on-chain limit for this agent, or it was stopped/);
  assert.equal(sent.length, 2);
});

test("no stream of tiny top-ups: at least $0.10 (unless that is all that is left today), and one a minute per agent", async () => {
  const c = await chain();
  const usdc = await c.deploy("MockUSDC", DEPLOYER);
  const al = await c.deploy("FizzlAgentAllowance", DEPLOYER, [usdc.address]);
  await usdc.send(DEPLOYER, "mint", [OWNER, usd(100)]);
  let t = 0;
  const allowance = createAllowance({ contract: al.address, token: usdc.address, rpc: c.rpc, sleep: async () => {}, now: () => t, charger: { address: CHARGER, send: (to, data) => c.send(CHARGER, to, data) } });
  const t1 = allowance.turnOnTxs(AGENT, { perDayUsdc: 20, floatUsdc: 5, approveUsdc: 30 });
  await c.send(OWNER, t1.approve.to, t1.approve.data); await c.send(OWNER, t1.setLimit.to, t1.setLimit.data);
  t = 100_000;
  assert.equal((await allowance.topUp(OWNER, AGENT)).toppedUp, 5);
  await usdc.send(AGENT, "transfer", [SHOP, usd(4)]);
  t += 30_000;
  assert.match((await allowance.topUp(OWNER, AGENT)).reason, /less than a minute ago/);
  t += 31_000;
  assert.equal((await allowance.topUp(OWNER, AGENT)).toppedUp, 4);
  await usdc.send(AGENT, "transfer", [SHOP, usd(0.05)]);
  t += 61_000;
  assert.match((await allowance.topUp(OWNER, AGENT, { needUsdc: 5 })).reason, /less than \$0.10/);
});

test("an owner without the USDC: refused before any gas is spent", async () => {
  const { allowance, turnOn, sent } = await setup({ funds: usd(1) });
  await turnOn();
  assert.match((await allowance.topUp(OWNER, AGENT)).reason, /doesn't have enough USDC/);
  assert.equal(sent.length, 0);
});

test("without a charger or a contract, it says what to set", async () => {
  const { allowance, turnOn } = await setup({ charger: false });
  await turnOn();
  await assert.rejects(allowance.topUp(OWNER, AGENT), /CHARGER_KEY/);
  const off = createAllowance({ contract: null, rpc: async () => { throw new Error("no rpc"); } });
  assert.equal(off.enabled, false);
  await assert.rejects(off.status(OWNER, AGENT), /ALLOWANCE_CONTRACT/);
  const s = await off.setup();
  assert.equal(s.contract, null);
  assert.match(s.deployData, /^0x60/);
});
