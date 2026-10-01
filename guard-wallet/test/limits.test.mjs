// Offline: spending limits. presign-guard, the payment and the wallet are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet, PresignBlockedError } from "../index.js";
import { normalizeLimits, spendFor, parseWindow, createLimiter } from "../limits.js";
import { fileStore } from "../file-store.js";

const presignKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, input) {
  const route = "POST /v1/check";
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-10-01T10:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const OTHER = "0x4200000000000000000000000000000000000006";
const SHOP = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x3333333333333333333333333333333333333333";
const usdc = (n) => BigInt(Math.round(n * 1e6));
const transfer = (to, amount, token = USDC_BASE) => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });
const approve = (spender, amount, token = USDC_BASE) => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });

function world({ verdict = "green", subject, failSign = false, chainId = 8453 } = {}) {
  const log = { checks: 0, signed: [] };
  const sign = (name, result) => async (args) => {
    if (failSign) throw new Error("user rejected");
    log.signed.push([name, args]);
    return result;
  };
  const wallet = {
    chain: { id: chainId },
    account: { address: "0x2222222222222222222222222222222222222222" },
    sendTransaction: sign("sendTransaction", "0xtx"),
    writeContract: sign("writeContract", "0xtx2"),
    signTypedData: sign("signTypedData", "0xsig"),
  };
  const pay = async (_url, init) => {
    log.checks++;
    const input = JSON.parse(init.body);
    return Response.json(await signed({ version: "2", verdict, reasons: [], ...(subject ? { subject } : {}) }, input));
  };
  return { log, wallet, pay };
}
const make = (w, options = {}) => guardWallet(w.wallet, { pay: w.pay, signers: [presignKey.address], ...options });

test("config: known tokens, addresses with decimals, windows; mistakes are caught early", () => {
  const p = normalizeLimits({ tokens: { USDC: { perTx: "5", perDay: 20 }, ETH: { perDay: "0.01" }, [`8453:${OTHER}`]: { perTx: "1", decimals: 18 } } });
  assert.equal(p.index.get(`8453:${USDC_BASE.toLowerCase()}`).decimals, 6);
  assert.equal(p.index.get(`56:${USDC_BSC.toLowerCase()}`).decimals, 18);
  assert.equal(p.index.get("42161:native").budget, "ETH");
  assert.equal(p.index.get("56:native"), undefined); // BNB, not ETH
  assert.equal(p.windowMs, 86_400_000);
  assert.equal(parseWindow("1h"), 3_600_000);
  assert.throws(() => normalizeLimits({ tokens: { DOGE: { perTx: 1 } } }), /not a known token/);
  assert.throws(() => normalizeLimits({ tokens: { [OTHER]: { perTx: 1 } } }), /decimals is required/);
  assert.throws(() => normalizeLimits({ tokens: { USDC: {} } }), /perTx, perDay or both/);
  assert.throws(() => normalizeLimits({ tokens: { USDC: { perTx: "-1" } } }), /positive number/);
  assert.throws(() => normalizeLimits({ unknownTokens: "maybe" }), /unknownTokens/);
  assert.throws(() => normalizeLimits({ allow: ["shop.eth"] }), /allow/);
  assert.throws(() => normalizeLimits({ window: "1 week" }), /window/);
  assert.throws(() => guardWallet(world().wallet, { pay: async () => {}, onOverLimit: () => true }), /need limits/);
});

test("what counts: native value, transfer, transferFrom, approve, setApprovalForAll; other calls spend nothing", () => {
  const tx = (args) => ({ type: "transaction", chainId: 8453, value: "0", data: "0x", ...args });
  assert.deepEqual(spendFor(tx({ to: SHOP, value: "5" })).items, [{ chainId: 8453, token: "native", amount: 5n, to: SHOP.toLowerCase() }]);
  assert.equal(spendFor(tx(transfer(SHOP, 7n))).items[0].amount, 7n);
  const from = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [SHOP, ROUTER, 9n] });
  assert.equal(spendFor(tx({ to: USDC_BASE, data: from })).items[0].to, ROUTER.toLowerCase());
  assert.equal(spendFor(tx(approve(ROUTER, 3n))).items[0].amount, 3n);
  assert.deepEqual(spendFor(tx(approve(ROUTER, 0n))).items, []); // a revoke spends nothing
  const all = encodeFunctionData({ abi: parseAbi(["function setApprovalForAll(address,bool)"]), functionName: "setApprovalForAll", args: [ROUTER, true] });
  assert.equal(spendFor(tx({ to: OTHER, data: all })).items[0].amount, null);
  const swap = spendFor(tx({ to: ROUTER, data: "0x12345678" }));
  assert.deepEqual([swap.items, swap.counterparties], [[], [ROUTER.toLowerCase()]]);
});

test("signatures: spending is read from the signed subject; without it, it is unknown", () => {
  const req = { type: "signature", chainId: 8453, typedData: { domain: { verifyingContract: USDC_BASE } } };
  const verdict = { subject: { kind: "transfer_authorization", grants: [{ token: USDC_BASE.toLowerCase(), spender: SHOP, amount: "2500000", mode: "payment" }] } };
  assert.equal(spendFor(req, verdict).items[0].amount, 2_500_000n);
  assert.equal(spendFor(req, null).unknown, true);
  assert.equal(spendFor(req, { subject: { kind: "marketplace_order", grants: [] } }).unknown, true);
});

test("within the limits: signs, books it, and spending() shows what is left", async () => {
  const w = world();
  const spends = [];
  const wallet = make(w, { limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } }, onSpend: (e) => spends.push(e) });
  await wallet.sendTransaction(transfer(SHOP, usdc(4)));
  await wallet.sendTransaction(transfer(SHOP, usdc(4.5)));
  assert.equal(w.log.signed.length, 2);
  assert.deepEqual(spends.map((e) => [e.budget, e.amount, e.result, e.receiptId]), [["USDC", "4", "0xtx", "p1"], ["USDC", "4.5", "0xtx", "p1"]]);
  assert.deepEqual(await wallet.spending(), [{ token: "USDC", perTx: "5", perDay: "20", used: "8.5", left: "11.5" }]);
});

test("over the per-transaction limit: stops without onOverLimit, nothing signed", async () => {
  const w = world();
  const wallet = make(w, { limits: { tokens: { USDC: { perTx: "5" } } } });
  await assert.rejects(wallet.sendTransaction(transfer(SHOP, usdc(6))), (err) => {
    assert.ok(err instanceof PresignBlockedError);
    assert.equal(err.code, "over_limit");
    assert.equal(err.reasons[0].code, "per_tx");
    assert.match(err.message, /6 USDC is over the limit of 5 per transaction/);
    return true;
  });
  assert.equal(w.log.signed.length, 0);
  assert.equal(w.log.checks, 1); // checked first: a red verdict needs no human
});

test("over the daily limit: onOverLimit decides; an approved spend still counts", async () => {
  const w = world();
  const asked = [];
  let answer = false;
  const wallet = make(w, { limits: { tokens: { USDC: { perDay: "10" } } }, onOverLimit: async (info) => { asked.push(info); return answer; } });
  await wallet.sendTransaction(transfer(SHOP, usdc(8)));
  await assert.rejects(wallet.sendTransaction(transfer(SHOP, usdc(3))), { code: "over_limit" });
  assert.equal(asked.length, 1);
  assert.match(asked[0].summary, /3 USDC is over the limit of 10 per 24h \(8 used\)/);
  assert.equal(asked[0].spending[0].left, "2");
  answer = true;
  await wallet.sendTransaction(transfer(SHOP, usdc(3)));
  assert.equal((await wallet.spending())[0].used, "11");
  assert.equal(w.log.signed.length, 2);
});

test("the window rolls: yesterday's spending no longer counts", async () => {
  let t = 1_000_000;
  const limiter = createLimiter({ tokens: { USDC: { perDay: "10" } } }, { now: () => t });
  const request = { type: "transaction", chainId: 8453, value: "0", ...transfer(SHOP, usdc(9)) };
  assert.equal((await limiter.reserve({ method: "sendTransaction", request })).ok, true);
  assert.equal((await limiter.reserve({ method: "sendTransaction", request })).ok, false);
  t += 86_400_000;
  assert.equal((await limiter.reserve({ method: "sendTransaction", request })).ok, true);
});

test("an allowance counts as spending; an unlimited one is over any limit", async () => {
  const w = world();
  const wallet = make(w, { limits: { tokens: { USDC: { perTx: "50", perDay: "100" } } } });
  await assert.rejects(wallet.sendTransaction(approve(ROUTER, usdc(60))), { code: "over_limit" });
  await assert.rejects(wallet.sendTransaction(approve(ROUTER, 2n ** 256n - 1n)), (err) => err.reasons.some((r) => r.code === "per_tx" && r.amount === "unlimited"));
  await wallet.sendTransaction(approve(ROUTER, usdc(40)));
  assert.equal((await wallet.spending())[0].used, "40");
  await wallet.sendTransaction(approve(ROUTER, 0n)); // revoking is always fine
  assert.equal(w.log.signed.length, 2);
});

test("an approved unlimited allowance uses up the rest of the window", async () => {
  const wallet = make(world(), { limits: { tokens: { USDC: { perDay: "100" } } }, onOverLimit: () => true });
  await wallet.sendTransaction(approve(ROUTER, 2n ** 256n - 1n));
  assert.equal((await wallet.spending())[0].left, "0");
});

test("one budget across chains and decimals: USDC on BNB Chain (18 decimals) counts in whole USDC", async () => {
  const limiter = createLimiter({ tokens: { USDC: { perDay: "10" } } });
  const req = (chainId, token, raw) => ({ type: "transaction", chainId, value: "0", ...transfer(SHOP, raw, token) });
  assert.equal((await limiter.reserve({ method: "sendTransaction", request: req(8453, USDC_BASE, usdc(6)) })).ok, true);
  assert.equal((await limiter.reserve({ method: "sendTransaction", request: req(56, USDC_BSC, 3n * 10n ** 18n) })).ok, true);
  assert.equal((await limiter.spending())[0].used, "9");
  assert.equal((await limiter.reserve({ method: "sendTransaction", request: req(56, USDC_BSC, 2n * 10n ** 18n) })).ok, false);
});

test("tokens without a limit: ask by default, or stop, or allow", async () => {
  const send = (wallet) => wallet.sendTransaction(transfer(SHOP, 10n ** 18n, OTHER));
  const asked = [];
  await send(make(world(), { limits: { tokens: { USDC: { perDay: "1" } } }, onOverLimit: (info) => { asked.push(info.reasons[0].code); return true; } }));
  assert.deepEqual(asked, ["unknown_token"]);
  await assert.rejects(send(make(world(), { limits: { unknownTokens: "stop" }, onOverLimit: () => true })), { code: "over_limit" });
  await send(make(world(), { limits: { unknownTokens: "allow" } }));
  // The native coin without a limit is a token without a limit too.
  await assert.rejects(make(world(), { limits: { tokens: { USDC: { perDay: "1" } } } }).sendTransaction({ to: SHOP, value: 1n }), (err) => err.reasons[0].code === "unknown_token");
});

test("signatures: an EIP-3009 payment counts from the signed subject; an undecodable one is unknown", async () => {
  const typedData = { domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE }, types: { TransferWithAuthorization: [] }, primaryType: "TransferWithAuthorization", message: { to: SHOP, value: "7000000" } };
  const subject = { kind: "transfer_authorization", grants: [{ token: USDC_BASE.toLowerCase(), spender: SHOP.toLowerCase(), amount: "7000000", unlimited: false, mode: "payment" }] };
  const limits = { tokens: { USDC: { perTx: "5" } } };
  await assert.rejects(make(world({ subject }), { limits }).signTypedData(typedData), (err) => err.reasons[0].code === "per_tx");
  await assert.rejects(make(world({ subject: { kind: "unknown_signature", grants: [] } }), { limits }).signTypedData(typedData), (err) => err.reasons[0].code === "unknown_spend");
});

test("allow list: only listed recipients, spenders and contracts", async () => {
  const limits = { tokens: { USDC: { perDay: "100" } }, allow: [SHOP] };
  const w = world();
  await make(w, { limits }).sendTransaction(transfer(SHOP, usdc(1)));
  await assert.rejects(make(w, { limits }).sendTransaction(transfer(ROUTER, usdc(1))), (err) => err.reasons[0].code === "not_allowed");
  await assert.rejects(make(w, { limits }).sendTransaction({ to: ROUTER, data: "0x12345678" }), (err) => err.reasons[0].code === "not_allowed");
  assert.equal(w.log.signed.length, 1);
});

test("signing fails: the spending is given back", async () => {
  const w = world({ failSign: true });
  const wallet = make(w, { limits: { tokens: { USDC: { perDay: "10" } } } });
  await assert.rejects(wallet.sendTransaction(transfer(SHOP, usdc(9))), /user rejected/);
  assert.equal((await wallet.spending())[0].used, "0");
});

test("parallel transactions cannot both fit in the last of a budget", async () => {
  const w = world();
  const wallet = make(w, { limits: { tokens: { USDC: { perDay: "10" } } } });
  const results = await Promise.allSettled([wallet.sendTransaction(transfer(SHOP, usdc(6))), wallet.sendTransaction(transfer(SHOP, usdc(6)))]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(w.log.signed.length, 1);
});

test("red still wins, and a contract deployment's value still counts", async () => {
  await assert.rejects(make(world({ verdict: "red" }), { limits: { tokens: { USDC: { perDay: "10" } } }, onOverLimit: () => true }).sendTransaction(transfer(SHOP, usdc(1))), { code: "red" });
  const w = world();
  await assert.rejects(make(w, { limits: { tokens: { ETH: { perTx: "0.001" } } } }).sendTransaction({ data: "0x6000", value: 10n ** 16n }), { code: "over_limit" });
  assert.equal(w.log.checks, 0); // a deployment is not checked by presign-guard
});

test("pause stops everything that signs, until resume", async () => {
  const w = world();
  const wallet = make(w);
  wallet.pause();
  assert.equal(wallet.paused(), true);
  await assert.rejects(wallet.sendTransaction({ to: SHOP, value: 1n }), { code: "paused" });
  assert.equal(w.log.checks, 0); // nothing paid for while paused
  wallet.resume();
  await wallet.sendTransaction({ to: SHOP, value: 1n });
  assert.equal(w.log.signed.length, 1);
  assert.equal(await wallet.spending(), null);
});

test("a store that fails stops the wallet; a broken onOverLimit too", async () => {
  const broken = { add: async () => { throw new Error("disk full"); }, remove: async () => {}, list: async () => [] };
  await assert.rejects(make(world(), { limits: { tokens: { USDC: { perDay: "10" } } }, store: broken }).sendTransaction(transfer(SHOP, usdc(1))), { code: "limit_unavailable" });
  await assert.rejects(make(world(), { limits: { tokens: { USDC: { perDay: "1" } } }, onOverLimit: () => { throw new Error("no phone"); } }).sendTransaction(transfer(SHOP, usdc(2))), { code: "limit_unavailable" });
});

test("fileStore keeps spending across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgw-"));
  try {
    const path = join(dir, "spend.json");
    const limits = { tokens: { USDC: { perDay: "10" } } };
    await make(world(), { limits, store: fileStore(path) }).sendTransaction(transfer(SHOP, usdc(7)));
    const again = make(world(), { limits, store: fileStore(path) }); // a fresh process
    assert.equal((await again.spending())[0].used, "7");
    await assert.rejects(again.sendTransaction(transfer(SHOP, usdc(4))), { code: "over_limit" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
