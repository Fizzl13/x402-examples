// Offline: presign-guard, the payment and the wallet are fakes; nothing is paid or signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseAbi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet, PresignBlockedError, checkRequestFor } from "../index.js";

const presignKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, input, key = presignKey) {
  const route = "POST /v1/check";
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-09-30T10:00:00.000Z", signer: key.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await key.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const SPENDER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// A wallet that records what it signs, and a presign-guard answering `verdict`.
function world({ verdict = "green", reasons = [], status = 200, key = presignKey, tamper = null } = {}) {
  const log = { checks: [], signed: [] };
  const wallet = {
    chain: { id: 8453 },
    account: { address: "0x2222222222222222222222222222222222222222" },
    sendTransaction: async (args) => { log.signed.push(["sendTransaction", args]); return "0xtx"; },
    writeContract: async (args) => { log.signed.push(["writeContract", args]); return "0xtx2"; },
    signTypedData: async (args) => { log.signed.push(["signTypedData", args]); return "0xsig"; },
    getAddresses: async () => ["0x2222222222222222222222222222222222222222"],
  };
  const pay = async (url, init) => {
    const input = JSON.parse(init.body);
    log.checks.push({ url, input, ua: init.headers["user-agent"] });
    if (status !== 200) return Response.json({ verdict: null, error: "upstream down" }, { status });
    const body = await signed({ version: "2", verdict, reasons, checkedAt: "2026-09-30T10:00:00.000Z" }, input, key);
    return Response.json(tamper ? tamper(body) : body);
  };
  return { log, wallet, pay };
}

const make = (w, options = {}) => guardWallet(w.wallet, { pay: w.pay, signers: [presignKey.address], ...options });

test("green: the transaction is checked (signed verdict for exactly this request), then signed", async () => {
  const w = world();
  const seen = [];
  const hash = await make(w, { onVerdict: (v, info) => seen.push([v.verdict, info.method]) }).sendTransaction({ to: SPENDER, data: "0x", value: 5n });
  assert.equal(hash, "0xtx");
  assert.deepEqual(w.log.checks[0].input, { type: "transaction", chainId: 8453, to: SPENDER, data: "0x", value: "5" });
  assert.match(w.log.checks[0].url, /presign-guard\.fizzl\.eu\/v1\/check$/);
  assert.match(w.log.checks[0].ua, /^presign-guard-wallet\//);
  assert.equal(w.log.signed.length, 1);
  assert.deepEqual(seen, [["green", "sendTransaction"]]);
});

test("red: throws PresignBlockedError with the reasons; nothing is signed", async () => {
  const w = world({ verdict: "red", reasons: [{ code: "UNLIMITED_APPROVAL_TO_EOA", severity: "red" }, { code: "OFFCHAIN_SIGNATURE", severity: "info" }] });
  await assert.rejects(make(w).sendTransaction({ to: SPENDER, data: "0x" }), (err) => {
    assert.ok(err instanceof PresignBlockedError);
    assert.equal(err.code, "red");
    assert.match(err.message, /UNLIMITED_APPROVAL_TO_EOA/);
    assert.doesNotMatch(err.message, /OFFCHAIN_SIGNATURE/);
    return true;
  });
  assert.equal(w.log.signed.length, 0);
});

test("orange: stops by default; signs with 'allow'; asks a function otherwise", async () => {
  const stop = world({ verdict: "orange", reasons: [{ code: "UNLIMITED_APPROVAL", severity: "orange" }] });
  await assert.rejects(make(stop).sendTransaction({ to: SPENDER }), { code: "orange" });
  assert.equal(stop.log.signed.length, 0);

  const allow = world({ verdict: "orange" });
  await make(allow, { onOrange: "allow" }).sendTransaction({ to: SPENDER });
  assert.equal(allow.log.signed.length, 1);

  const asked = [];
  const no = world({ verdict: "orange" });
  await assert.rejects(make(no, { onOrange: async (v) => { asked.push(v.verdict); return false; } }).sendTransaction({ to: SPENDER }), { code: "orange" });
  assert.deepEqual(asked, ["orange"]);
});

test("writeContract is encoded and checked as the transaction it becomes", async () => {
  const w = world();
  const abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
  await make(w).writeContract({ address: TOKEN, abi, functionName: "approve", args: [SPENDER, 2n ** 256n - 1n] });
  const input = w.log.checks[0].input;
  assert.equal(input.type, "transaction");
  assert.equal(input.to, TOKEN);
  assert.match(input.data, /^0x095ea7b3/); // approve(address,uint256)
  assert.equal(w.log.signed[0][0], "writeContract");
});

test("signTypedData is checked as a signature, bigints sent as strings", async () => {
  const w = world();
  const typed = {
    domain: { name: "Permit2", chainId: 8453n, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
    types: { PermitSingle: [{ name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] },
    primaryType: "PermitSingle",
    message: { spender: SPENDER, sigDeadline: 1790000000n },
  };
  await make(w).signTypedData(typed);
  const input = w.log.checks[0].input;
  assert.equal(input.type, "signature");
  assert.equal(input.typedData.message.sigDeadline, "1790000000");
  assert.equal(input.typedData.domain.chainId, "8453");
});

test("a verdict not signed by presign-guard, or changed on the way, is never a signature", async () => {
  const forged = world({ key: privateKeyToAccount(generatePrivateKey()) });
  await assert.rejects(make(forged).sendTransaction({ to: SPENDER }), { code: "bad_receipt" });
  const flipped = world({ verdict: "red", tamper: (b) => ({ ...b, verdict: "green" }) });
  await assert.rejects(make(flipped).sendTransaction({ to: SPENDER }), { code: "bad_receipt" });
  // even with onError "allow": a bad receipt is not an outage
  await assert.rejects(make(forged, { onError: "allow" }).sendTransaction({ to: SPENDER }), { code: "bad_receipt" });
  assert.equal(forged.log.signed.length + flipped.log.signed.length, 0);
});

test("the check failing: stops by default, signs with onError 'allow'", async () => {
  const down = world({ status: 503 });
  await assert.rejects(make(down).sendTransaction({ to: SPENDER }), { code: "check_failed" });
  assert.equal(down.log.signed.length, 0);
  const open = world({ status: 503 });
  await make(open, { onError: "allow" }).sendTransaction({ to: SPENDER });
  assert.equal(open.log.signed.length, 1);
});

test("unsupported chain: stops by default; other wallet methods pass through unchecked", async () => {
  const w = world();
  const g = make(w);
  await assert.rejects(g.sendTransaction({ to: SPENDER, chain: { id: 11155111 } }), { code: "unsupported_chain" });
  assert.deepEqual(await g.getAddresses(), ["0x2222222222222222222222222222222222222222"]);
  assert.equal(g.account.address, "0x2222222222222222222222222222222222222222");
  assert.equal(w.log.checks.length, 0);
});

test("origin is passed along; a deployment (no to) is not screened", async () => {
  const w = world();
  await make(w, { origin: "https://app.example.com" }).sendTransaction({ to: SPENDER });
  assert.equal(w.log.checks[0].input.origin, "https://app.example.com");
  await make(w).sendTransaction({ data: "0x6080" });
  assert.equal(w.log.checks.length, 1);
  assert.equal(checkRequestFor("signMessage", {}), null);
});

test("options are validated", () => {
  const w = world();
  assert.throws(() => guardWallet(w.wallet, {}), /pay is required/);
  assert.throws(() => guardWallet(w.wallet, { pay: w.pay, onOrange: "maybe" }), /onOrange/);
  assert.throws(() => guardWallet(null, { pay: w.pay }), /WalletClient/);
});
