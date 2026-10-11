// The guarded Solana Agent Kit wallet against a stand-in presign-guard and a local RPC: no network, no money.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KeypairWallet, SolanaAgentKit, signOrSendTX } from "solana-agent-kit";
import { guardSolanaWallet, GuardPlugin, PresignBlockedError } from "../index.js";

const OTHER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const BLOCKHASH = "11111111111111111111111111111111";

function presign({ verdict = "green", simulation } = {}) {
  const calls = [];
  const pay = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ verdict, reasons: verdict === "green" ? [] : [{ code: "SOLANA_TOKEN_ACCOUNT_TAKEOVER", severity: verdict }], ...(simulation && { simulation }) });
  };
  return { pay, calls };
}
const versioned = (from, lamports = 1000n) => new VersionedTransaction(new TransactionMessage({
  payerKey: from, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: OTHER, lamports })],
}).compileToV0Message());
const legacy = (from, extraSigner) => {
  const tx = new Transaction({ feePayer: from, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: OTHER, lamports: 1000 }));
  if (extraSigner) tx.add(SystemProgram.transfer({ fromPubkey: extraSigner.publicKey, toPubkey: OTHER, lamports: 1 }));
  return tx;
};
async function verify(sig, pubkey, message) {
  const key = await crypto.subtle.importKey("raw", pubkey.toBytes(), "Ed25519", false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, sig, message);
}
function setup({ presignOpts, guard = {}, rpcUrl = "http://127.0.0.1:9" } = {}) {
  const keypair = Keypair.generate();
  const p = presign(presignOpts);
  const wallet = guardSolanaWallet(new KeypairWallet(keypair, rpcUrl), { pay: p.pay, verifyReceipts: "off", ...guard });
  return { keypair, wallet, calls: p.calls };
}

test("versioned and legacy transactions are checked (type solana, from the wallet), then signed by the real wallet", async () => {
  const { keypair, wallet, calls } = setup();
  const v = await wallet.signTransaction(versioned(keypair.publicKey));
  assert.ok(await verify(v.signatures[0], keypair.publicKey, v.message.serialize()));
  assert.deepEqual([calls[0].type, calls[0].from], ["solana", keypair.publicKey.toBase58()]);

  // A legacy transaction that another key signed first (a new mint, say): that signature stays.
  const extra = Keypair.generate();
  const tx = legacy(keypair.publicKey, extra);
  tx.partialSign(extra);
  const l = await wallet.signTransaction(tx);
  const sig = (pk) => l.signatures.find((s) => s.publicKey.equals(pk)).signature;
  assert.ok(await verify(sig(keypair.publicKey), keypair.publicKey, l.serializeMessage()));
  assert.ok(await verify(sig(extra.publicKey), extra.publicKey, l.serializeMessage()));
  assert.equal(calls.length, 2);

  // signAllTransactions: each one checked.
  await wallet.signAllTransactions([versioned(keypair.publicKey), versioned(keypair.publicKey, 2000n)]);
  assert.equal(calls.length, 4);
});

test("red or orange: nothing is signed, and the agent gets the reason", async () => {
  for (const verdict of ["red", "orange"]) {
    const { keypair, wallet } = setup({ presignOpts: { verdict } });
    const tx = versioned(keypair.publicKey);
    await assert.rejects(wallet.signTransaction(tx), (e) => e instanceof PresignBlockedError && e.code === verdict && /SOLANA_TOKEN_ACCOUNT_TAKEOVER/.test(e.message));
    assert.ok(tx.signatures[0].every((b) => b === 0));
  }
});

test("limits: what the simulation shows leaving counts toward SOL; over the limit nothing is signed", async () => {
  const keypair = Keypair.generate();
  const from = keypair.publicKey.toBase58();
  const sim = (lamports) => ({ ok: true, fee: 0.000005, changes: [{ type: "sol", account: from, change: -lamports / 1e9, lamports: String(-lamports - 5000) }] });
  const at = (lamports) => guardSolanaWallet(new KeypairWallet(keypair, "http://127.0.0.1:9"), { pay: presign({ simulation: sim(lamports) }).pay, verifyReceipts: "off", limits: { tokens: { SOL: { perTx: "0.5" } } } });
  const ok = at(200_000_000);
  await ok.signTransaction(versioned(keypair.publicKey));
  assert.equal((await ok.guard.spending())[0].used, "0.2");
  const over = at(800_000_000);
  const tx = versioned(keypair.publicKey);
  await assert.rejects(over.signTransaction(tx), { code: "over_limit" });
  assert.ok(tx.signatures[0].every((b) => b === 0));
});

test("signAndSendTransaction sends the checked, signed bytes (not KeypairWallet's own re-signing send)", async () => {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    if (method === "sendTransaction") sent.push(params[0]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: method === "sendTransaction" ? "5igSIG" : null }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { keypair, wallet, calls } = setup({ rpcUrl: `http://127.0.0.1:${server.address().port}` });
    const tx = versioned(keypair.publicKey);
    assert.deepEqual(await wallet.signAndSendTransaction(tx), { signature: "5igSIG" });
    assert.equal(calls.length, 1);
    const wire = Buffer.from(sent[0], "base64");
    const decoded = VersionedTransaction.deserialize(wire);
    assert.ok(await verify(decoded.signatures[0], keypair.publicKey, decoded.message.serialize()));
    assert.equal(await wallet.sendTransaction(versioned(keypair.publicKey, 5n)), "5igSIG");
    assert.equal(calls.length, 2, "sendTransaction is checked too");
  } finally { server.close(); }
});

test("signMessage and the raw keypair are refused unless allowRawSign; pause stops everything", async () => {
  const { keypair, wallet } = setup();
  await assert.rejects(wallet.signMessage(new Uint8Array([1])), { code: "unchecked" });
  assert.equal(wallet.payer, undefined);
  assert.equal(wallet.publicKey.toBase58(), keypair.publicKey.toBase58());
  const open = setup({ guard: { allowRawSign: true } });
  assert.equal((await open.wallet.signMessage(new Uint8Array([1]))).length, 64);
  assert.ok(open.wallet.payer);
  wallet.guard.pause();
  await assert.rejects(wallet.signTransaction(versioned(keypair.publicKey)), { code: "paused" });
  assert.throws(() => guardSolanaWallet({}), /Solana Agent Kit wallet/);
  assert.throws(() => guardSolanaWallet(new KeypairWallet(keypair, "x"), { pay: async () => {}, network: "testnet" }), /network/);
});

test("in Solana Agent Kit: signOrSendTX goes through the guard, and GuardPlugin shows the budget and pauses", async () => {
  const { keypair, wallet, calls } = setup({ presignOpts: { simulation: { ok: true, fee: 0.000005, changes: [] } }, guard: { limits: { tokens: { SOL: { perDay: "1" } } } } });
  const agent = new SolanaAgentKit(wallet, "http://127.0.0.1:9", { signOnly: true }).use(GuardPlugin);
  const signed = await signOrSendTX(agent, versioned(keypair.publicKey));
  assert.ok(await verify(signed.signatures[0], keypair.publicKey, signed.message.serialize()));
  assert.equal(calls.length, 1);
  const byName = Object.fromEntries(agent.actions.map((a) => [a.name, a]));
  const limits = await byName.GET_SPENDING_LIMITS.handler(agent, {});
  assert.equal(limits.status, "success");
  assert.equal(limits.limits[0].token, "SOL");
  assert.equal((await agent.methods.getSpendingLimits(agent)).paused, false);
  const { executeAction } = await import("solana-agent-kit");
  assert.equal((await executeAction(byName.PAUSE_SPENDING, agent, { reason: "unexpected approve" })).status, "success");
  await assert.rejects(signOrSendTX(agent, versioned(keypair.publicKey)), { code: "paused" });
});
