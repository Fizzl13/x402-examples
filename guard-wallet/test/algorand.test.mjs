// Algorand: algorandSigner signs only a USDC transfer from its own account, read from the real unsigned
// transaction bytes (built here with algokit, as x402's AVM client builds them), within the USDC limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Transaction, TransactionType, encodeTransactionRaw, groupTransactions } from "@algorandfoundation/algokit-utils/transact";
import { Address } from "@algorandfoundation/algokit-utils";
import { toClientAvmSigner } from "@x402/avm";
import { guardWallet, PresignBlockedError } from "../index.js";
import { readAlgorandTxn, algorandAddress, msgpackDecode } from "../algorand.js";

const MAIN = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TEST = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { b64: Buffer.concat([seed, pub]).toString("base64"), address: algorandAddress(pub) };
};
const agent = key(), shop = key(), feePayer = key();
const A = (s) => Address.fromString(s);
const common = { firstValid: 1000n, lastValid: 2000n, genesisHash: new Uint8Array(32), genesisId: "mainnet-v1.0" };
const axfer = ({ from = agent.address, to = shop.address, asset = 31566704n, amount = 10_000n, close = null, rekey = null, clawback = null, fee = 0n } = {}) => new Transaction({
  type: TransactionType.AssetTransfer, sender: A(from), fee, ...common, ...(rekey ? { rekeyTo: A(rekey) } : {}),
  assetTransfer: { assetId: asset, amount, receiver: A(to), ...(close ? { closeRemainderTo: A(close) } : {}), ...(clawback ? { assetSender: A(clawback) } : {}) },
});
const pay = ({ from = feePayer.address, to = feePayer.address, amount = 0n, fee = 2000n } = {}) => new Transaction({ type: TransactionType.Payment, sender: A(from), fee, ...common, payment: { receiver: A(to), amount } });
// The group x402's AVM client builds with a fee payer: [fee payer's 0-ALGO payment, the agent's USDC transfer].
const group = (t) => groupTransactions([pay(), t]).map((x) => encodeTransactionRaw(x));

function make(options = {}) {
  const fetchNever = async () => { throw new Error("no presign check expected on Algorand"); };
  const w = { chain: { id: 8453 }, account: privateKeyToAccount(generatePrivateKey()), signTypedData: async () => "0x" };
  return guardWallet(w, { pay: fetchNever, fetch: fetchNever, ...options });
}

test("reading the transaction: the fields algokit encodes come back", () => {
  const t = readAlgorandTxn(encodeTransactionRaw(axfer({ amount: 123_456n })));
  assert.deepEqual([t.type, t.sender, t.receiver, t.amount, t.assetId, t.closeTo, t.rekeyTo], ["axfer", agent.address, shop.address, 123456n, 31566704n, null, null]);
  const p = readAlgorandTxn(encodeTransactionRaw(pay({ amount: 5n })));
  assert.deepEqual([p.type, p.sender, p.amount], ["pay", feePayer.address, 5n]);
  assert.throws(() => msgpackDecode(new Uint8Array([0x91])), /end/);
});

test("algorandSigner: a USDC transfer is signed (only its own transaction) and counts toward the USDC limit", async () => {
  const guard = make({ limits: { tokens: { USDC: { perTx: "1", perDay: "0.025" } } } });
  const signer = guard.algorandSigner(toClientAvmSigner(agent.b64));
  assert.equal(signer.address, agent.address);
  const txns = group(axfer({ amount: 10_000n }));
  const signed = await signer.signTransactions(txns, [1]);
  assert.equal(signed[0], null, "the fee payer's transaction is left for the facilitator");
  assert.ok(signed[1] instanceof Uint8Array && signed[1].length > txns[1].length);
  const [row] = await guard.spending();
  assert.deepEqual([row.token, row.used], ["USDC", "0.01"]);
  // 0.02 more would pass the 0.025 day limit.
  await assert.rejects(signer.signTransactions(group(axfer({ amount: 20_000n })), [1]), (err) => err instanceof PresignBlockedError && err.code === "over_limit");
});

test("algorandSigner: anything but one USDC transfer from this account is refused, and pause covers it", async () => {
  const guard = make({ limits: { tokens: { USDC: { perTx: "100" } } } });
  const signer = guard.algorandSigner(toClientAvmSigner(agent.b64));
  const cases = [
    [group(axfer({ asset: 1n })), [1], /not USDC/],
    [group(axfer({ close: shop.address })), [1], /closes/],
    [group(axfer({ rekey: shop.address })), [1], /rekeys/],
    [group(axfer({ clawback: shop.address })), [1], /clawback/],
    [group(axfer({ from: shop.address })), [1], /not sent from this account/],
    [[encodeTransactionRaw(pay({ from: agent.address, to: shop.address, amount: 1_000_000n }))], [0], /"pay" transaction/],
    [group(axfer()), [0, 1], /one USDC transfer/],
    [group(axfer()), undefined, /one USDC transfer/],
    [[new Uint8Array([1, 2, 3])], [0], /could not read/],
  ];
  for (const [txns, idx, re] of cases) await assert.rejects(signer.signTransactions(txns, idx), (err) => err instanceof PresignBlockedError && err.code === "unsupported_chain" && re.test(err.message), String(re));
  guard.pause();
  await assert.rejects(signer.signTransactions(group(axfer()), [1]), (err) => err.code === "paused");
  assert.throws(() => guard.algorandSigner({ address: "x" }), /signTransactions/);
  assert.throws(() => guard.algorandSigner(toClientAvmSigner(agent.b64), { network: "algorand:other" }), /network/);
});

test("algorandSigner on testnet: testnet USDC (10458941) is the stablecoin there", async () => {
  const guard = make({ limits: { tokens: { USDC: { perTx: "1" } } } });
  const signer = guard.algorandSigner(toClientAvmSigner(agent.b64), { network: TEST });
  await signer.signTransactions(group(axfer({ asset: 10458941n })), [1]);
  await assert.rejects(signer.signTransactions(group(axfer()), [1]), /not USDC/);
});

// algorandSigner with any: other transactions and groups go to presign-guard (type algorand) first. A fake
// presign-guard answers with a signed verdict; the signer is the real AVM client signer.
import { privateKeyToAccount as presignAccount } from "viem/accounts";
import { canonicalJson, inputHash } from "x402-safe-fetch";

const presignKey = presignAccount(generatePrivateKey());
async function signedVerdict(body, input) {
  const route = "POST /v1/check";
  const receipt = { request_id: "a1", route, input_sha256: inputHash(route, input), signed_at: "2026-10-11T18:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}
function anyGuard({ verdict = "green", reasons = [], limits, network = MAIN, subjectNetwork = network } = {}) {
  const checks = [];
  const pay = async (_url, init) => {
    const input = JSON.parse(init.body);
    checks.push(input);
    return Response.json(await signedVerdict({ version: "2", verdict, reasons, subject: { kind: "algorand_transaction", network: subjectNetwork, wallet: agent.address }, checkedAt: "2026-10-11T18:00:00.000Z" }, input));
  };
  const w = { chain: { id: 8453 }, account: privateKeyToAccount(generatePrivateKey()), signTypedData: async () => "0x" };
  const guard = guardWallet(w, { pay, signers: [presignKey.address], ...(limits && { limits }) });
  return { guard, checks, signer: guard.algorandSigner(toClientAvmSigner(agent.b64), { network, any: true }) };
}
const algoPay = (amount, o = {}) => encodeTransactionRaw(pay({ from: agent.address, to: shop.address, amount, fee: 1000n, ...o }));

test("algorandSigner any: an ALGO payment is checked by presign-guard (the whole group, from this account) and counts toward ALGO", async () => {
  const { guard, checks, signer } = anyGuard({ limits: { tokens: { ALGO: { perTx: "5", perDay: "6" } } } });
  const signed = await signer.signTransactions([algoPay(4_000_000n)]);
  assert.ok(signed[0] instanceof Uint8Array);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].type, "algorand");
  assert.equal(checks[0].from, agent.address);
  assert.equal(checks[0].transactions.length, 1);
  const [row] = await guard.spending();
  assert.deepEqual([row.token, row.used], ["ALGO", "4"]);
  await assert.rejects(signer.signTransactions([algoPay(3_000_000n)]), { code: "over_limit" }, "4 + 3 is over the 6 ALGO day limit");
});

test("algorandSigner any: a group signs only this account's transactions; USDC sent counts toward USDC, other assets are asked about", async () => {
  const { guard, checks, signer } = anyGuard({ limits: { tokens: { USDC: { perTx: "1" } } } });
  const txns = groupTransactions([pay(), axfer({ amount: 300_000n }), pay({ from: shop.address, to: agent.address, amount: 5n })]).map((x) => encodeTransactionRaw(x));
  const signed = await signer.signTransactions(txns);
  assert.equal(signed[0], null);
  assert.ok(signed[1] instanceof Uint8Array);
  assert.equal(signed[2], null, "the other accounts' transactions are theirs to sign");
  assert.equal(checks[0].transactions.length, 3, "presign-guard sees the whole group");
  assert.equal((await guard.spending())[0].used, "0.3");
  await assert.rejects(signer.signTransactions([encodeTransactionRaw(axfer({ asset: 777n, amount: 5n }))]), { code: "over_limit" }, "an asset without a limit");
});

test("algorandSigner any: red and an unapproved orange are never signed; a rekey or close counts as unknown; other networks and other senders are refused", async () => {
  const red = anyGuard({ verdict: "red", reasons: [{ code: "ALGORAND_REKEY", severity: "red" }] });
  await assert.rejects(red.signer.signTransactions([algoPay(1n)]), { code: "red" });
  const orange = anyGuard({ verdict: "orange", reasons: [{ code: "ALGORAND_APP_CLEAR_STATE", severity: "orange" }] });
  await assert.rejects(orange.signer.signTransactions([algoPay(1n)]), { code: "orange" });
  // If a human lets an orange through, a close-out still can't be counted: unknown spending, asked about.
  const close = anyGuard({ limits: { tokens: { USDC: { perTx: "1" } } } });
  await assert.rejects(close.signer.signTransactions([encodeTransactionRaw(axfer({ amount: 0n, to: agent.address, close: shop.address }))]), { code: "over_limit" });
  const wrongNet = anyGuard({ subjectNetwork: TEST });
  await assert.rejects(wrongNet.signer.signTransactions([algoPay(1n)]), (err) => err.code === "unsupported_chain" && /not algorand:wGHE/.test(err.message));
  const other = anyGuard();
  await assert.rejects(other.signer.signTransactions([encodeTransactionRaw(pay({ from: shop.address, to: agent.address, amount: 1n }))]), { code: "unsupported_chain" });
  assert.equal(other.checks.length, 0, "nothing of ours to sign: no check is paid");
  // A plain x402 USDC payment still takes the local path: no presign-guard call.
  const x = anyGuard({ limits: { tokens: { USDC: { perTx: "1" } } } });
  await x.signer.signTransactions(group(axfer({ amount: 10_000n })), [1]);
  assert.equal(x.checks.length, 0);
});

test("allow list with Algorand addresses: a USDC payment to a listed seller is signed, to anyone else it is over the limit", async () => {
  const other = key();
  const guard = make({ limits: { tokens: { USDC: { perDay: "5" } }, allow: [shop.address] } });
  const signer = guard.algorandSigner(toClientAvmSigner(agent.b64));
  assert.ok((await signer.signTransactions(group(axfer({ to: shop.address })), [1]))[1] instanceof Uint8Array);
  await assert.rejects(signer.signTransactions(group(axfer({ to: other.address })), [1]), (err) => err.code === "over_limit" && err.reasons.some((r) => r.code === "not_allowed"));
});

test("allow list with Algorand addresses: in a group (any) every receiver of this account's transactions must be listed", async () => {
  const other = key();
  const { signer } = anyGuard({ limits: { tokens: { ALGO: { perDay: "10" } }, allow: [shop.address] } });
  assert.ok((await signer.signTransactions([algoPay(1_000_000n)]))[0] instanceof Uint8Array, "ALGO to the listed shop");
  await assert.rejects(signer.signTransactions([algoPay(1_000_000n, { to: other.address })]), (err) => err.code === "over_limit" && err.reasons.some((r) => r.code === "not_allowed"));
});
