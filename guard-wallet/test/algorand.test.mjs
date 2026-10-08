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
