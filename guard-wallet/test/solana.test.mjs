// solanaSigner: x402 SVM payments only, checked by presign-guard and counted toward the USDC limit. Offline: the
// transactions are built with @solana/kit as x402's SVM client builds them; presign-guard and the signer are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as k from "@solana/kit";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet } from "../index.js";
import { readSolanaMessage, readSolanaPayment, wireTransaction } from "../solana.js";

const presignKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, input) {
  const route = "POST /v1/check";
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-10-11T10:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const OWNER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
const SOURCE_ATA = "2ocS3orPq3jyszjsJ4NozKWyhdotr3csDjAizmkj65aH";
const DEST_ATA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const R = k.AccountRole;
const A = (a, role) => ({ address: k.address(a), role });

const computeLimit = () => ({ programAddress: k.address("ComputeBudget111111111111111111111111111111"), accounts: [], data: new Uint8Array([2, 0x40, 0x0d, 0x03, 0x00]) });
const memo = () => ({ programAddress: k.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new TextEncoder().encode("0123abcd") });
const transferChecked = ({ amount = 10000n, mint = USDC, authority = OWNER } = {}) => {
  const d = new Uint8Array(10); d[0] = 12; new DataView(d.buffer).setBigUint64(1, amount, true); d[9] = 6;
  return { programAddress: k.address(TOKEN), accounts: [A(SOURCE_ATA, R.WRITABLE), A(mint, R.READONLY), A(DEST_ATA, R.WRITABLE), A(authority, R.READONLY_SIGNER)], data: d };
};
const systemTransfer = () => { const d = new Uint8Array(12); new DataView(d.buffer).setUint32(0, 2, true); new DataView(d.buffer).setBigUint64(4, 1n, true); return { programAddress: k.address("11111111111111111111111111111111"), accounts: [A(OWNER, R.WRITABLE_SIGNER), A(DEST_ATA, R.WRITABLE)], data: d }; };

function tx(ixs) {
  let m = k.createTransactionMessage({ version: 0 });
  m = k.setTransactionMessageFeePayer(k.address(FEE_PAYER), m);
  m = k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n }, m);
  for (const ix of ixs) m = k.appendTransactionMessageInstruction(ix, m);
  return k.compileTransaction(m);
}
const x402Payment = (opts) => tx([computeLimit(), transferChecked(opts), memo()]);

function setup({ verdict = "green", reasons = [], limits, simulation, any = false } = {}) {
  const checks = [];
  const signedTxs = [];
  const pay = async (_url, init) => {
    const input = JSON.parse(init.body);
    checks.push(input);
    return Response.json(await signed({ version: "2", verdict, reasons, ...(simulation && { simulation }), checkedAt: "2026-10-11T10:00:00.000Z" }, input));
  };
  const guard = guardWallet({ chain: { id: 8453 } }, { pay, signers: [presignKey.address], ...(limits && { limits }) });
  const inner = { address: OWNER, signTransactions: async (txs) => { signedTxs.push(...txs); return txs.map(() => ({ [OWNER]: new Uint8Array(64).fill(7) })); } };
  return { signer: guard.solanaSigner(inner, { any }), checks, signedTxs, guard };
}

test("readSolanaPayment reads an x402 payment; wireTransaction gives a decodable transaction with empty signatures", () => {
  const t = x402Payment({ amount: 25000n });
  const p = readSolanaPayment(t.messageBytes, OWNER, NET);
  assert.deepEqual({ mint: p.mint, amount: p.amount, source: p.source, destination: p.destination }, { mint: USDC, amount: 25000n, source: SOURCE_ATA, destination: DEST_ATA });
  const wire = wireTransaction(t.messageBytes, p.numSigners);
  const decoded = k.getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  assert.deepEqual(Buffer.from(decoded.messageBytes), Buffer.from(t.messageBytes));
  assert.equal(Object.keys(decoded.signatures).length, 2, "fee payer and owner");
  assert.equal(readSolanaMessage(t.messageBytes).keys[0], FEE_PAYER);
});

test("green: an x402 USDC payment is checked by presign-guard (type solana, from the owner) and signed", async () => {
  const { signer, checks, signedTxs } = setup();
  const out = await signer.signTransactions([x402Payment()]);
  assert.equal(out.length, 1);
  assert.equal(signedTxs.length, 1);
  assert.equal(checks[0].type, "solana");
  assert.equal(checks[0].from, OWNER);
  assert.ok(checks[0].transaction.length > 100);
});

test("red or orange from presign-guard: nothing is signed", async () => {
  for (const verdict of ["red", "orange"]) {
    const { signer, signedTxs } = setup({ verdict, reasons: [{ code: "SOLANA_TOKEN_ACCOUNT_TAKEOVER", severity: verdict }] });
    await assert.rejects(signer.signTransactions([x402Payment()]), { code: verdict });
    assert.equal(signedTxs.length, 0);
  }
});

test("anything but an x402 USDC payment from this account is refused before any check", async () => {
  const { signer, checks, signedTxs } = setup();
  const cases = [
    tx([systemTransfer()]),
    tx([computeLimit(), transferChecked(), transferChecked(), memo()]),
    tx([transferChecked({ mint: "So11111111111111111111111111111111111111112" })]),
    tx([transferChecked({ authority: DEST_ATA })]),
  ];
  for (const t of cases) await assert.rejects(signer.signTransactions([t]), { code: "unsupported_chain" });
  assert.equal(checks.length, 0);
  assert.equal(signedTxs.length, 0);
});

test("limits: the payment counts toward USDC (6 decimals); over the limit nothing is signed; pause stops it", async () => {
  const { signer, signedTxs, guard } = setup({ limits: { tokens: { USDC: { perTx: "0.05", perDay: "0.06" } } } });
  await signer.signTransactions([x402Payment({ amount: 40000n })]); // 0.04
  await assert.rejects(signer.signTransactions([x402Payment({ amount: 60000n })]), { code: "over_limit" }); // 0.06 > perTx
  await assert.rejects(signer.signTransactions([x402Payment({ amount: 30000n })]), { code: "over_limit" }); // 0.04 + 0.03 > perDay
  assert.equal(signedTxs.length, 1);
  guard.pause();
  await assert.rejects(signer.signTransactions([x402Payment({ amount: 1000n })]), { code: "paused" });
  assert.throws(() => guard.solanaSigner({ address: OWNER }), /signTransactions/);
  assert.throws(() => guard.solanaSigner({ address: OWNER, signTransactions() {} }, { network: "solana:nope" }), /network/);
});

test("any: other transactions are checked by presign-guard; the signed simulation counts SOL (beyond the fee) and tokens", async () => {
  const sim = (changes, extra = {}) => ({ ok: true, fee: 0.000005, changes, ...extra });
  const solOut = (lamports) => sim([{ type: "sol", account: OWNER, change: -lamports / 1e9, lamports: String(-lamports - 5000) }]);
  // 0.4 SOL leaves (plus the fee, which doesn't count): within a SOL limit of 0.5 per tx.
  const ok = setup({ any: true, limits: { tokens: { SOL: { perTx: "0.5" } } }, simulation: solOut(400_000_000) });
  await ok.signer.signTransactions([tx([systemTransfer()])]);
  assert.equal(ok.signedTxs.length, 1);
  assert.equal(ok.checks[0].type, "solana");
  const [row] = await ok.guard.spending();
  assert.deepEqual([row.token, row.used], ["SOL", "0.4"]);

  const over = setup({ any: true, limits: { tokens: { SOL: { perTx: "0.5" } } }, simulation: solOut(600_000_000) });
  await assert.rejects(over.signer.signTransactions([tx([systemTransfer()])]), { code: "over_limit" });
  assert.equal(over.signedTxs.length, 0);

  // USDC leaving counts toward USDC; a token without a limit, a delegate, or no / an incomplete simulation is asked about.
  const usdc = setup({ any: true, limits: { tokens: { USDC: { perTx: "1" } } }, simulation: sim([{ type: "token", account: SOURCE_ATA, mint: USDC, change: -0.5, raw: "-500000", decimals: 6 }]) });
  await usdc.signer.signTransactions([tx([systemTransfer()])]);
  assert.equal((await usdc.guard.spending())[0].used, "0.5");
  for (const simulation of [
    sim([{ type: "token", account: SOURCE_ATA, mint: "So11111111111111111111111111111111111111112", change: -1, raw: "-1000000000", decimals: 9 }]),
    sim([{ type: "delegate", account: SOURCE_ATA, mint: USDC, delegate: DEST_ATA, amount: "5" }]),
    sim([], { partial: true }),
    undefined,
  ]) {
    const s = setup({ any: true, limits: { tokens: { USDC: { perTx: "1" } } }, simulation });
    await assert.rejects(s.signer.signTransactions([tx([systemTransfer()])]), { code: "over_limit" });
    assert.equal(s.signedTxs.length, 0);
  }

  // Red is never signed; x402 payments still go the payment path.
  const red = setup({ any: true, verdict: "red", reasons: [{ code: "SOLANA_ACCOUNT_ASSIGN", severity: "red" }] });
  await assert.rejects(red.signer.signTransactions([tx([systemTransfer()])]), { code: "red" });
  const pay = setup({ any: true, limits: { tokens: { USDC: { perTx: "1" } } } });
  await pay.signer.signTransactions([x402Payment({ amount: 20000n })]);
  assert.equal((await pay.guard.spending())[0].used, "0.02");
});
