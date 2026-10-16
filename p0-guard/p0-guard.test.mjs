// Run: npm test (no network, nothing paid, nothing sent)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as k from "@solana/kit";
import { parseArgs, intentOf, stepsToCheck, decide, signTx, checkPrice, run, sendAndConfirm, seedBytes, solanaSigner, solanaKeyBytes, SOLANA } from "./p0-guard.mjs";

const SYSTEM = "11111111111111111111111111111111";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
// A transaction whose fee payer is the given wallet, like the ones P0 returns (v0, unsigned).
function unsignedTx(payer) {
  let m = k.createTransactionMessage({ version: 0 });
  m = k.setTransactionMessageFeePayer(k.address(payer), m);
  m = k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: SYSTEM, lastValidBlockHeight: 0n }, m);
  const data = new Uint8Array(12); new DataView(data.buffer).setUint32(0, 2, true); new DataView(data.buffer).setBigUint64(4, 1000n, true);
  m = k.appendTransactionMessageInstruction({ programAddress: k.address(SYSTEM), accounts: [{ address: k.address(payer), role: k.AccountRole.WRITABLE_SIGNER }, { address: k.address(OTHER), role: k.AccountRole.WRITABLE }], data }, m);
  return k.getBase64EncodedWireTransaction(k.compileTransaction(m));
}
const envelope = (payer, { submit = "sequential", n = 2 } = {}) => ({
  action: "deposit", account: "Acct111", symbol: "USDC", amount_ui: 1, submit, leverage: null,
  transactions: Array.from({ length: n }, (_, i) => ({ base64: unsignedTx(payer), type: i === 0 && n > 1 ? "CREATE_ACCOUNT" : "DEPOSIT", label: i === 0 && n > 1 ? "Create marginfi account" : "Deposit" })),
  simulation: { success: true },
});
const p0Stub = (body, calls = []) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return Response.json(body, { status: body.error ? 400 : 200 });
};
const green = { verdict: "green", reasons: [{ code: "SIMULATED", severity: "info" }], simulation: { ok: true, changes: [{ type: "token", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", change: -1 }] } };
const waiting = { verdict: "orange", reasons: [{ code: "SIMULATION_FAILS", severity: "orange", details: { error: "{\"InstructionError\":[2,{\"Custom\":3007}]}", missingAccounts: ["Acct111"] } }] };
const payStub = (verdicts, calls) => async (url, init) => { calls.push({ check: JSON.parse(init.body) }); return Response.json(verdicts.shift()); };

test("arguments: the action, P0's parameters typed, and the flags", () => {
  const a = parseArgs(["deposit", "bank=2s37", "amount=1.5", "create_new_account=true", "--authority", "Wallet1", "--dry-run"]);
  assert.equal(a.action, "deposit");
  assert.deepEqual(a.params, { bank: "2s37", amount: 1.5, create_new_account: true });
  assert.equal(a.flags.authority, "Wallet1");
  assert.equal(a.flags.dryRun, true);
  assert.equal(a.flags.send, false);
  assert.throws(() => parseArgs(["deposit", "1"]), /name=value/);
});

test("intent: what the agent says it is doing, for presign-guard to compare", () => {
  assert.equal(intentOf({ action: "deposit", amount_ui: 1, symbol: "USDC" }), "deposit 1 USDC on Project 0 (lending)");
  assert.equal(intentOf({ action: "loop", amount_ui: 0.5, symbol: "SOL", leverage: 2 }), "loop 0.5 SOL at 2x leverage on Project 0 (lending)");
  assert.equal(intentOf({ action: "create-account" }), "create-account on Project 0 (lending)");
});

test("which steps are checked: sequential one at a time (only the first without --send), a bundle all at once", () => {
  const seq = { submit: "sequential", transactions: [{}, {}] };
  assert.deepEqual(stepsToCheck(seq, false), [0]);
  assert.deepEqual(stepsToCheck(seq, true), [0, 1]);
  assert.deepEqual(stepsToCheck({ submit: "bundle", transactions: [{}, {}, {}] }, false), [0, 1, 2]);
});

test("decisions: green go, red stop, orange ask; a later step that needs the one before is wait, not a risk", () => {
  assert.equal(decide(green).action, "go");
  assert.equal(decide({ verdict: "red", reasons: [] }).action, "stop");
  assert.equal(decide({ verdict: "orange", reasons: [{ code: "SOLANA_UNLIMITED_DELEGATE", severity: "orange" }] }).action, "ask");
  assert.equal(decide(waiting, 1).action, "wait");
  assert.equal(decide(waiting, 0).action, "ask", "the first step has nothing before it");
  const alsoRisky = { verdict: "orange", reasons: [...waiting.reasons, { code: "SOLANA_DURABLE_NONCE", severity: "orange" }] };
  assert.equal(decide(alsoRisky, 1).action, "ask", "another orange reason is still a question for a person");
  assert.equal(decide(null).action, "stop", "no verdict is never a go");
});

test("signing: the wallet signs P0's transaction only when it is one of its signers", async () => {
  const signer = await k.generateKeyPairSigner();
  const { base64, signature } = await signTx(unsignedTx(signer.address), signer);
  const tx = k.getTransactionDecoder().decode(k.getBase64Encoder().encode(base64));
  assert.ok(tx.signatures[signer.address].some((b) => b !== 0), "the signature is filled in");
  assert.ok(await k.verifySignature(signer.keyPair.publicKey, tx.signatures[signer.address], tx.messageBytes));
  assert.equal(signature, k.getBase58Decoder().decode(tx.signatures[signer.address]));
  // The unsigned transactions P0's MCP returned for another wallet (fixtures/p0-first-deposit.json).
  const p0 = JSON.parse(readFileSync(new URL("./fixtures/p0-first-deposit.json", import.meta.url), "utf8"));
  await assert.rejects(signTx(p0.transactions[0].base64, signer), /not for/);
});

test("without --send: only the first sequential step is checked ($0.01), nothing is signed or sent", async () => {
  const signer = await k.generateKeyPairSigner();
  const calls = [], sent = [];
  const report = await run({ action: "deposit", params: { bank: "B", amount: 1 }, authority: signer.address, fetchImpl: p0Stub(envelope(signer.address), calls), pay: payStub([green], calls), signer, sender: async (s) => { sent.push(s); return s.signature; } });
  assert.deepEqual(calls[0].body, { bank: "B", amount: 1, authority: signer.address }, "P0 builds for the wallet itself");
  assert.equal(calls[1].check.type, "solana");
  assert.equal(calls[1].check.from, signer.address);
  assert.equal(calls[1].check.intent, "deposit 1 USDC on Project 0 (lending)");
  assert.equal(report.steps.length, 1);
  assert.equal(report.not_checked, 1);
  assert.match(report.next, /--send/);
  assert.equal(sent.length, 0);
  assert.equal(report.paid_usd, 0.01);
  assert.equal(report.ok, true);
});

test("with --send: check, sign and send each step in order; stop before signing anything that is not green", async () => {
  const signer = await k.generateKeyPairSigner();
  const order = [];
  const sender = async (s) => { order.push("send"); return s.signature; };
  const pay = async (_url, init) => { order.push("check"); return Response.json(green); };
  const report = await run({ action: "deposit", params: {}, authority: signer.address, send: true, fetchImpl: p0Stub(envelope(signer.address)), pay, signer, sender });
  assert.deepEqual(order, ["check", "send", "check", "send"], "each step is checked just before it is signed");
  assert.equal(report.steps.every((s) => s.sent), true);
  assert.equal(report.paid_usd, 0.02);

  const order2 = [];
  const red = { verdict: "red", reasons: [{ code: "SOLANA_TOKEN_ACCOUNT_TAKEOVER", severity: "red" }] };
  const verdicts = [green, red];
  const stopped = await run({ action: "deposit", params: {}, authority: signer.address, send: true, fetchImpl: p0Stub(envelope(signer.address)),
    pay: async () => { order2.push("check"); return Response.json(verdicts.shift()); }, signer, sender: async (s) => { order2.push("send"); return s.signature; } });
  assert.deepEqual(order2, ["check", "send", "check"], "the red step is never sent");
  assert.equal(stopped.stopped.at, 1);
  assert.equal(stopped.stopped.action, "stop");
  assert.deepEqual(stopped.steps[1].reasons, ["SOLANA_TOKEN_ACCOUNT_TAKEOVER"]);
  assert.equal(stopped.ok, false);
});

test("a bundle: every transaction is checked, none is sent by this script", async () => {
  const signer = await k.generateKeyPairSigner();
  const sent = [];
  const report = await run({ action: "loop", params: {}, authority: signer.address, send: true, fetchImpl: p0Stub(envelope(signer.address, { submit: "bundle", n: 3 })), pay: payStub([green, green, green], []), signer, sender: async (s) => { sent.push(s); } });
  assert.equal(report.steps.length, 3);
  assert.equal(sent.length, 0);
  assert.match(report.next, /Jito bundle/);
});

test("P0 builds nothing: its error and code come through", async () => {
  const signer = await k.generateKeyPairSigner();
  await assert.rejects(
    run({ action: "deposit", params: {}, authority: signer.address, fetchImpl: p0Stub({ error: "the transactions were NOT returned", code: "SIMULATION_FAILED" }), pay: async () => assert.fail("nothing to check"), signer }),
    /SIMULATION_FAILED: the transactions were NOT returned/,
  );
});

test("the price of a check, from the 402 (nothing paid)", async () => {
  const challenge = { x402Version: 2, accepts: [{ network: "eip155:8453", amount: "10000" }, { network: SOLANA, amount: "10000" }] };
  const fetchImpl = async () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
  assert.equal(await checkPrice("AQ==", { fetchImpl }), 0.01);
});

test("wallet: SOLANA_SEED always gives the same wallet; an address pasted as a key is refused", async () => {
  const seed = "correct horse battery staple, but much longer and random";
  assert.equal(seedBytes(seed).length, 32);
  assert.equal((await solanaSigner({ SOLANA_SEED: seed })).address, (await solanaSigner({ SOLANA_SEED: `${seed}\n` })).address);
  assert.throws(() => seedBytes("too short"), /at least 32 characters/);
  await assert.rejects(solanaKeyBytes(k.getBase58Decoder().decode(new Uint8Array(32).fill(7))), /looks like the wallet address/);
});

test("sending: wait until confirmed; a transaction that landed with an error counts as failed", async () => {
  const rpc = (statuses, calls = []) => async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    if (method === "sendTransaction") return Response.json({ result: "Sig1" });
    return Response.json({ result: { value: [statuses.shift() ?? null] } });
  };
  const calls = [];
  assert.equal(await sendAndConfirm({ base64: "AQ==", signature: "Sig1" }, { fetchImpl: rpc([null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }], calls), pollMs: 1 }), "Sig1");
  assert.deepEqual(calls, ["sendTransaction", "getSignatureStatuses", "getSignatureStatuses", "getSignatureStatuses"]);
  await assert.rejects(sendAndConfirm({ base64: "AQ==", signature: "Sig1" }, { fetchImpl: rpc([{ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 1 }] } }]), pollMs: 1 }), /landed with an error/);
  await assert.rejects(sendAndConfirm({ base64: "AQ==", signature: "Sig1" }, { fetchImpl: rpc([]), pollMs: 1, timeoutMs: 20 }), /not confirmed/);
});
