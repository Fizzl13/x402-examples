// guardWdkAccount: a Tether WDK EVM account (@tetherto/wdk-wallet-evm WalletAccountEvm) behind presign-guard.
// Offline: presign-guard, the payment and the WDK account are fakes that record what they are asked; nothing is
// paid, signed for real or sent. The fake account has WalletAccountEvm's method shapes (async getAddress, transfer
// { token, recipient, amount }, approve { token, spender, amount }, sendTransaction(tx | raw), signTypedData
// { domain, types, message } with the primary type left to ethers, signAuthorization, delegate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodeFunctionData, erc20Abi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet, guardWdkAccount, PresignBlockedError } from "../index.js";

const presignKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, input) {
  const route = "POST /v1/check";
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-11-16T10:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const USDT0_XLAYER = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const DRAINER = "0x9999999999999999999999999999999999999999";
const usdc = (n) => BigInt(Math.round(n * 1e6));

function fakeWdk() {
  const inner = privateKeyToAccount(generatePrivateKey());
  const calls = [];
  const record = (name, result) => async (arg) => { calls.push([name, arg]); return typeof result === "function" ? result(arg) : result; };
  return {
    inner, calls,
    async getAddress() { return inner.address; },
    getBalance: async () => 123n,
    transfer: record("transfer", { hash: "0xt", fee: 1n }),
    approve: record("approve", { hash: "0xa", fee: 1n }),
    sendTransaction: record("sendTransaction", { hash: "0xs", fee: 1n }),
    signTransaction: record("signTransaction", "0xsigned"),
    sign: record("sign", "0xmsg"),
    signTypedData: record("signTypedData", "0xtyped"),
    signAuthorization: record("signAuthorization", (a) => ({ ...a, signature: { r: "0x01", s: "0x02", yParity: 0 } })),
    delegate: record("delegate", { hash: "0xd", fee: 1n }),
  };
}

// presign-guard answering `verdict` (or a function of the request).
function guard({ verdict = "green", reasons = [] } = {}) {
  const checks = [];
  const pay = async (_url, init) => {
    const input = JSON.parse(init.body);
    checks.push(input);
    const v = typeof verdict === "function" ? verdict(input) : verdict;
    return Response.json(await signed({ version: "2", verdict: v, reasons: v === "green" ? [] : reasons, checkedAt: "2026-11-16T10:00:00.000Z" }, input));
  };
  return { checks, pay };
}

const make = (wdk, g, options = {}) => guardWdkAccount(wdk, { chainId: 8453, pay: g.pay, signers: [presignKey.address], ...options });

test("transfer: checked as the ERC-20 transfer it sends, from the WDK account; green, then WDK sends it", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const out = await make(wdk, g).transfer({ token: USDC_BASE, recipient: SHOP, amount: 20000 });
  assert.deepEqual(out, { hash: "0xt", fee: 1n });
  assert.equal(g.checks.length, 1);
  const c = g.checks[0];
  assert.equal(c.type, "transaction");
  assert.equal(c.chainId, 8453);
  assert.equal(c.from, wdk.inner.address);
  assert.equal(c.to, USDC_BASE);
  assert.equal(c.value, "0");
  const call = decodeFunctionData({ abi: erc20Abi, data: c.data });
  assert.equal(call.functionName, "transfer");
  assert.deepEqual(call.args, [SHOP, 20000n]);
  assert.deepEqual(wdk.calls, [["transfer", { token: USDC_BASE, recipient: SHOP, amount: 20000 }]]);
});

test("red: an unlimited approve to a drainer is never signed; the error carries presign-guard's reasons", async () => {
  const wdk = fakeWdk();
  const g = guard({ verdict: "red", reasons: [{ code: "UNLIMITED_APPROVAL_TO_EOA", severity: "red" }] });
  await assert.rejects(make(wdk, g).approve({ token: USDC_BASE, spender: DRAINER, amount: 2n ** 256n - 1n }), (err) => {
    assert.ok(err instanceof PresignBlockedError);
    assert.equal(err.code, "red");
    assert.match(err.message, /UNLIMITED_APPROVAL_TO_EOA/);
    return true;
  });
  const call = decodeFunctionData({ abi: erc20Abi, data: g.checks[0].data });
  assert.equal(call.functionName, "approve");
  assert.deepEqual(call.args, [DRAINER, 2n ** 256n - 1n]);
  assert.equal(wdk.calls.length, 0);
});

test("sendTransaction and signTransaction: checked as the transaction (value as a decimal string); a raw signed transaction is refused", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const a = make(wdk, g);
  await a.sendTransaction({ to: SHOP, value: 1000, data: "0x" });
  await a.signTransaction({ to: SHOP, value: "0x10" });
  assert.deepEqual(g.checks.map((c) => [c.to, c.value, c.data]), [[SHOP, "1000", "0x"], [SHOP, "16", "0x"]]);
  assert.deepEqual(wdk.calls.map(([n]) => n), ["sendTransaction", "signTransaction"]);
  await assert.rejects(a.sendTransaction("0x02f8..."), (err) => err instanceof PresignBlockedError && err.code === "check_failed");
  assert.equal(wdk.calls.length, 2);
  assert.equal(g.checks.length, 2);
});

test("orange stops by default, and is signed only when onOrange says yes", async () => {
  const wdk = fakeWdk();
  const g = guard({ verdict: "orange", reasons: [{ code: "NEW_CONTRACT", severity: "orange" }] });
  await assert.rejects(make(wdk, g).sendTransaction({ to: SHOP, data: "0x1234" }), (err) => err.code === "orange");
  assert.equal(wdk.calls.length, 0);
  await make(wdk, g, { onOrange: async () => true }).sendTransaction({ to: SHOP, data: "0x1234" });
  assert.equal(wdk.calls.length, 1);
});

test("signTypedData: checked with the primary type WDK will sign; EIP712Domain dropped; two top-level types refused", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const a = make(wdk, g);
  const types = {
    EIP712Domain: [{ name: "name", type: "string" }],
    TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
  };
  const message = { from: wdk.inner.address, to: SHOP, value: "20000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"ab".repeat(32)}` };
  const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE };
  assert.equal(await a.signTypedData({ domain, types, message }), "0xtyped");
  assert.equal(g.checks[0].type, "signature");
  assert.equal(g.checks[0].typedData.primaryType, "TransferWithAuthorization");
  assert.ok(!("EIP712Domain" in wdk.calls[0][1].types), "WDK (ethers) refuses EIP712Domain in types");
  await assert.rejects(a.signTypedData({ domain, types: { A: [{ name: "a", type: "uint256" }], B: [{ name: "b", type: "uint256" }] }, message: {} }), /several top-level types/);
  assert.equal(wdk.calls.length, 1);
});

test("sign: a message is checked (a sign-in for another site is red); checkMessages false leaves it unchecked", async () => {
  const wdk = fakeWdk();
  const g = guard({ verdict: "red", reasons: [{ code: "SIWE_DOMAIN_MISMATCH", severity: "red" }] });
  await assert.rejects(make(wdk, g, { origin: "https://shop.example" }).sign("evil.example wants you to sign in"), (err) => err.code === "red");
  assert.deepEqual([g.checks[0].type, g.checks[0].method, g.checks[0].origin], ["message", "personal_sign", "https://shop.example"]);
  assert.equal(wdk.calls.length, 0);
  assert.equal(await make(wdk, g, { checkMessages: false }).sign("hello"), "0xmsg");
  assert.equal(g.checks.length, 1);
});

test("signAuthorization and delegate (EIP-7702): checked as an authorization, signed for exactly the contract and chain checked", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const a = make(wdk, g);
  const signedAuth = await a.signAuthorization({ address: SHOP, nonce: 3 });
  assert.equal(signedAuth.chainId, 8453);
  assert.deepEqual([g.checks[0].type, g.checks[0].address, g.checks[0].authorizationChainId, g.checks[0].nonce], ["authorization", SHOP, 8453, "3"]);
  await a.delegate(SHOP);
  assert.equal(g.checks[1].type, "authorization");
  assert.deepEqual(wdk.calls.map(([n]) => n), ["signAuthorization", "delegate"]);
  // orange "allow" never covers an authorization
  const o = guard({ verdict: "orange", reasons: [{ code: "UNKNOWN_DELEGATE", severity: "orange" }] });
  await assert.rejects(make(wdk, o, { onOrange: "allow" }).delegate(DRAINER), (err) => err.code === "orange");
  assert.equal(wdk.calls.length, 2);
});

test("an authorization carried in a transaction's authorizationList is checked too", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const auth = { address: DRAINER, chainId: 8453n, nonce: 0n, signature: { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 0 } };
  await make(wdk, g).sendTransaction({ to: wdk.inner.address, value: 0, authorizationList: [auth] });
  assert.deepEqual(g.checks.map((c) => c.type), ["authorization", "transaction"]);
  assert.equal(g.checks[0].address, DRAINER);
});

test("spending limits: a USDC transfer over perTx is refused before WDK signs; within it, it counts", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const a = make(wdk, g, { limits: { tokens: { USDC: { perTx: "1", perDay: "5" } } } });
  await a.transfer({ token: USDC_BASE, recipient: SHOP, amount: usdc(0.5) });
  await assert.rejects(a.transfer({ token: USDC_BASE, recipient: SHOP, amount: usdc(2) }), (err) => err.code === "over_limit");
  assert.equal(wdk.calls.length, 1);
  const spent = await a.spending();
  assert.ok(JSON.stringify(spent).includes("0.5"), JSON.stringify(spent));
});

test("pause stops every checked method; reads go straight to the account", async () => {
  const wdk = fakeWdk();
  const g = guard();
  const a = make(wdk, g);
  assert.equal(await a.getBalance(), 123n);
  assert.equal(await a.getAddress(), wdk.inner.address);
  a.pause();
  assert.equal(a.paused(), true);
  await assert.rejects(a.transfer({ token: USDC_BASE, recipient: SHOP, amount: 1 }), (err) => err.code === "paused");
  a.resume();
  await a.transfer({ token: USDC_BASE, recipient: SHOP, amount: 1 });
  assert.equal(wdk.calls.length, 1);
  assert.equal(g.checks.length, 1);
});

test("a chain presign-guard doesn't cover is refused (no unchecked signing); one guard can hold a viem wallet and a WDK account", async () => {
  const wdk = fakeWdk();
  const g = guard();
  await assert.rejects(guardWdkAccount(wdk, { chainId: 999999, pay: g.pay, signers: [presignKey.address] }).transfer({ token: USDT0_XLAYER, recipient: SHOP, amount: 1 }), (err) => err.code === "unsupported_chain");
  assert.equal(wdk.calls.length, 0);
  const viemWallet = { chain: { id: 8453 }, account: { address: "0x2222222222222222222222222222222222222222" }, sendTransaction: async () => "0xv" };
  const both = guardWallet(viemWallet, { pay: g.pay, signers: [presignKey.address], limits: { tokens: { USDC: { perDay: "1" } } } });
  const w = both.wdkAccount(wdk, { chainId: 8453 });
  await w.transfer({ token: USDC_BASE, recipient: SHOP, amount: usdc(0.8) });
  await assert.rejects(w.transfer({ token: USDC_BASE, recipient: SHOP, amount: usdc(0.5) }), (err) => err.code === "over_limit", "one budget for both");
});

test("bad input: not a WDK account, no chainId, a non-number amount", async () => {
  const g = guard();
  assert.throws(() => guardWdkAccount({}, { chainId: 8453, pay: g.pay }), /Tether WDK EVM account/);
  assert.throws(() => guardWdkAccount(fakeWdk(), { pay: g.pay }), /chainId/);
  await assert.rejects(make(fakeWdk(), g).transfer({ token: USDC_BASE, recipient: SHOP, amount: "lots" }), /whole number/);
});
