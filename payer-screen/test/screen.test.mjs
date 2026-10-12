// x402-payer-screen against real payment payloads (built with the chains' own encoders) and a stand-in list: no
// network, no money.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import algosdk from "algosdk";
import * as k from "@solana/kit";
import { encode as xrplEncode } from "ripple-binary-codec";
import { payerOf, addressKey, createScreen, checkPayment, screenPayers, VERSION, LIST_URL } from "../index.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

// EVM: the EIP-3009 authorization (or Permit2's) carries the payer.
const EVM_LISTED = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96"; // Lazarus Group (Ronin hack), on the real list
const EVM_CLEAN = "0x1000000000000000000000000000000000000001";
const evm = (from) => ({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: "0x" + "22".repeat(20), value: "10000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } } });
const permit2 = (from) => ({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: { signature: "0x", permit2Authorization: { from, permitted: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000" } } } });

// Solana: the facilitator pays the fee (signer 1), the payer authorizes the token transfer (signer 2).
const FEE_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_LISTED = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi"; // on the real list
function solanaTx(payer) {
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const d = new Uint8Array(10); d[0] = 12; new DataView(d.buffer).setBigUint64(1, 10000n, true); d[9] = 6; // TransferChecked
  const ix = { programAddress: k.address(TOKEN), accounts: [
    { address: k.address("2ocS3orPq3jyszjsJ4NozKWyhdotr3csDjAizmkj65aH"), role: k.AccountRole.WRITABLE },
    { address: k.address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), role: k.AccountRole.READONLY },
    { address: k.address("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), role: k.AccountRole.WRITABLE },
    { address: k.address(payer), role: k.AccountRole.READONLY_SIGNER },
  ], data: d };
  let m = k.createTransactionMessage({ version: 0 });
  m = k.setTransactionMessageFeePayer(k.address(FEE_PAYER), m);
  m = k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n }, m);
  m = k.appendTransactionMessageInstruction(ix, m);
  return k.getBase64EncodedWireTransaction(k.compileTransaction(m));
}
const solana = (payer) => ({ x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: solanaTx(payer) } });

// Algorand: a group with the facilitator's fee transaction first and the payer's signed USDC transfer second.
const ALGO_PAYER = algosdk.generateAccount();
const ALGO_FEE = algosdk.generateAccount();
const sp = { fee: 0, minFee: 1000, flatFee: true, firstValid: 1000, lastValid: 2000, genesisHash: Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"), genesisID: "mainnet-v1.0" };
function algorandGroup(payer) {
  const fee = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: ALGO_FEE.addr, receiver: ALGO_FEE.addr, amount: 0, suggestedParams: { ...sp, fee: 2000 } });
  const pay = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: ALGO_FEE.addr, amount: 10000, assetIndex: 31566704, suggestedParams: sp });
  algosdk.assignGroupID([fee, pay]);
  return [Buffer.from(algosdk.encodeUnsignedTransaction(fee)).toString("base64"), Buffer.from(pay.signTxn(payer.sk)).toString("base64")];
}
const algorand = (payer) => ({ x402Version: 2, accepted: { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }, payload: { paymentGroup: algorandGroup(payer), paymentIndex: 1 } });

// XRP Ledger: a signed Payment blob; Account is the payer.
const XRP_LISTED = "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66"; // Chatex, on the real list
const XRP_CLEAN = "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32";
const xrplBlob = (account, amount) => xrplEncode({
  TransactionType: "Payment", Account: account, Destination: "r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw", Amount: amount,
  Fee: "12", Sequence: 7, Flags: 2147483648, SourceTag: 804681468, LastLedgerSequence: 99999999,
  InvoiceID: "AB".repeat(32), SigningPubKey: "ED" + "01".repeat(32), TxnSignature: "02".repeat(64),
  Memos: [{ Memo: { MemoData: "68656C6C6F" } }],
});
const RLUSD = { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", value: "0.01" };
const xrpl = (account, amount = RLUSD) => ({ x402Version: 2, accepted: { network: "xrpl:0" }, payload: { signedTxBlob: xrplBlob(account, amount) } });

const LIST = {
  list: "OFAC SDN", published: "2026-10-09", checkedAt: "2026-10-11T21:23:31.910Z", count: 4,
  addresses: [
    { address: EVM_LISTED.toLowerCase(), entries: [{ uid: 27307, name: "LAZARUS GROUP", type: "Entity", programs: ["DPRK3"], currency: "ETH" }] },
    { address: SOL_LISTED, entries: [{ uid: 56360, name: "Rolan SOKOLOVSKI", type: "Individual", programs: ["ILLICIT-DRUGS-EO14059"], currency: "SOL" }] },
    { address: XRP_LISTED, entries: [{ uid: 33854, name: "CHATEX", type: "Entity", programs: ["CYBER2"], currency: "XRP" }] },
    { address: ALGO_PAYER.addr.toString(), entries: [{ uid: 990001, name: "TEST ENTITY", type: "Entity", programs: ["TEST"], currency: "ALGO" }] },
  ],
};

test("payerOf: the payer of every payment kind, from the header or the object", () => {
  assert.deepEqual(payerOf(b64(evm(EVM_LISTED))), { payer: EVM_LISTED, network: "eip155:8453", kind: "eip3009" });
  assert.deepEqual(payerOf(permit2(EVM_CLEAN)), { payer: EVM_CLEAN, network: "eip155:8453", kind: "permit2" });
  assert.deepEqual(payerOf(b64(solana(SOL_LISTED))), { payer: SOL_LISTED, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", kind: "solana" });
  const algo = payerOf(b64(algorand(ALGO_PAYER)));
  assert.equal(algo.payer, ALGO_PAYER.addr.toString(), "the signed transfer's sender, not the fee payer");
  assert.equal(algo.kind, "algorand");
  assert.equal(payerOf(b64(xrpl(XRP_LISTED))).payer, XRP_LISTED, "a token amount (48 bytes) before Account");
  assert.equal(payerOf(b64(xrpl(XRP_CLEAN, "10000"))).payer, XRP_CLEAN, "an XRP amount (8 bytes)");
  // v1 (no accepted): the network is at the top level.
  assert.equal(payerOf({ x402Version: 1, network: "base", payload: evm(EVM_CLEAN).payload }).network, "base");
});

test("payerOf: anything unreadable is null, never a throw", () => {
  for (const bad of [undefined, null, "", "not base64 json", b64({}), b64({ payload: {} }), b64({ payload: { transaction: "AAAA" } }), b64({ payload: { signedTxBlob: "zz" } }), b64({ payload: { paymentGroup: ["AAAA"], paymentIndex: 0 } }), b64({ payload: { paymentGroup: [], paymentIndex: 3 } })]) {
    assert.equal(payerOf(bad), null, String(bad).slice(0, 40));
  }
});

test("addressKey: EVM and bech32 ignore case, base58 and base32 do not", () => {
  assert.equal(addressKey(EVM_LISTED), EVM_LISTED.toLowerCase());
  assert.equal(addressKey("BC1QJZK63WWATQ"), "bc1qjzk63wwatq");
  assert.equal(addressKey(SOL_LISTED), SOL_LISTED);
});

test("checkPayment: listed payers are blocked on every chain, clean ones pass, no list means unscreened", async () => {
  const screen = createScreen({ list: LIST });
  for (const p of [evm(EVM_LISTED.toUpperCase().replace("0X", "0x")), solana(SOL_LISTED), algorand(ALGO_PAYER), xrpl(XRP_LISTED)]) {
    const r = await checkPayment(b64(p), screen);
    assert.equal(r.blocked, true, r.kind);
    assert.equal(r.published, "2026-10-09");
    assert.ok(r.entries[0].name);
  }
  for (const p of [evm(EVM_CLEAN), solana(FEE_PAYER), algorand(ALGO_FEE), xrpl(XRP_CLEAN)]) assert.equal((await checkPayment(b64(p), screen)).blocked, false);
  assert.deepEqual(await checkPayment(undefined, screen), { blocked: false, unscreened: "no_payment" });
  assert.deepEqual(await checkPayment("garbage", screen), { blocked: false, unscreened: "payer_unreadable" });
  const none = createScreen({ fetch: async () => new Response("down", { status: 503 }) });
  const r = await checkPayment(b64(evm(EVM_LISTED)), none);
  assert.equal(r.unscreened, "list_unavailable");
  assert.equal(r.blocked, false);
  assert.match(none.status().lastError, /503/);
});

test("the list: downloaded once with its own user agent, refreshed when old, kept when a refresh fails", async () => {
  let t = 0;
  const calls = [];
  let down = false;
  const fetchImpl = async (url, init) => { calls.push({ url, ua: init.headers["user-agent"] }); return down ? new Response("x", { status: 500 }) : Response.json(LIST); };
  const screen = createScreen({ fetch: fetchImpl, now: () => t });
  await Promise.all([screen.ready(), screen.ready()]);
  assert.equal(calls.length, 1, "one download for concurrent callers");
  assert.equal(calls[0].url, LIST_URL);
  assert.equal(calls[0].ua, `x402-payer-screen/${VERSION}`);
  assert.equal(screen.status().addresses, 4);
  t += 7 * 3600 * 1000;
  down = true;
  await screen.ready();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2, "a refresh after 6 hours");
  assert.equal(screen.check(SOL_LISTED).listed, true, "the last good list stays");
  assert.match(screen.status().lastError, /500/);
});

// Express: the screen before a stand-in paywall that "settles" by answering 200.
function app(options) {
  const a = express();
  const blocked = [];
  a.use(screenPayers({ onBlocked: (info) => blocked.push(info), ...options }));
  a.use((req, res) => res.json({ settled: true }));
  return { a, blocked };
}
async function call(a, header) {
  const server = a.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/paid`, { headers: header ? { "payment-signature": header } : {} });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test("middleware: 451 for a listed payer (never settled), the rest go through; onBlocked hears about it", async () => {
  const { a, blocked } = app({ list: LIST });
  const r = await call(a, b64(xrpl(XRP_LISTED)));
  assert.equal(r.status, 451);
  assert.equal(r.body.error, "payer_sanctioned");
  assert.equal(r.body.payer, XRP_LISTED);
  assert.deepEqual(r.body.entries, [{ name: "CHATEX", programs: ["CYBER2"] }]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, "xrpl");
  assert.deepEqual((await call(a, b64(evm(EVM_CLEAN)))).body, { settled: true });
  assert.deepEqual((await call(a)).body, { settled: true }, "no payment: the paywall answers its 402 as usual");
});

test("middleware: no list lets payments through (one warning), unless failClosed", async () => {
  const fetchDown = async () => { throw new Error("ECONNREFUSED"); };
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    assert.deepEqual((await call(app({ fetch: fetchDown }).a, b64(evm(EVM_LISTED)))).body, { settled: true });
    assert.equal(warnings.length, 1);
    const closed = await call(app({ fetch: fetchDown, failClosed: true }).a, b64(evm(EVM_LISTED)));
    assert.equal(closed.status, 503);
    assert.equal(closed.body.error, "screen_unavailable");
  } finally {
    console.warn = warn;
  }
});
