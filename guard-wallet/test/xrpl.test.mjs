// XRP Ledger: the guarded XRPL signer. Offline: presign-guard and the XRPL signer are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet, PresignBlockedError } from "../index.js";
import { spendFor, normalizeLimits, evaluate } from "../limits.js";

const presignKey = privateKeyToAccount(generatePrivateKey());
async function signed(body, input) {
  const route = "POST /v1/check";
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-10-07T10:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

const ME = "rPmD85rFnjqvAtK6Q3xTwkmzTWbQXrzJUk";
const SELLER = "r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw";
const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const rlusdPayment = (value = "0.02", extra = {}) => ({ TransactionType: "Payment", Account: ME, Destination: SELLER, Amount: { currency: RLUSD, issuer: ISSUER, value }, Fee: "12", Sequence: 7, ...extra });

function world({ verdict = "green", reasons = [] } = {}) {
  const log = { checks: [], signed: [] };
  const wallet = { chain: { id: 8453 }, account: { address: "0x2222222222222222222222222222222222222222" }, sendTransaction: async () => "0xtx" };
  const pay = async (url, init) => {
    const input = JSON.parse(init.body);
    log.checks.push(input);
    return Response.json(await signed({ version: "2", verdict, reasons }, input));
  };
  const xrpl = { classicAddress: ME, sign: async (tx) => { log.signed.push(tx); return { signedTxBlob: "ABCD", hash: "H1" }; } };
  return { log, wallet, pay, xrpl };
}
const make = (w, options = {}) => guardWallet(w.wallet, { pay: w.pay, signers: [presignKey.address], ...options });

test("green: an RLUSD payment is checked by presign-guard as type xrpl, then signed", async () => {
  const w = world();
  const signer = make(w).xrplSigner(w.xrpl);
  assert.equal(signer.classicAddress, ME);
  const out = await signer.sign(rlusdPayment());
  assert.equal(out.signedTxBlob, "ABCD");
  assert.equal(w.log.checks[0].type, "xrpl");
  assert.equal(w.log.checks[0].network, "xrpl:0");
  assert.equal(w.log.checks[0].tx.Destination, SELLER);
  assert.equal(w.log.signed.length, 1);
});

test("red (e.g. fake RLUSD) and anything but a Payment are never signed", async () => {
  const w = world({ verdict: "red", reasons: [{ code: "XRPL_FAKE_RLUSD", severity: "red" }] });
  await assert.rejects(make(w).xrplSigner(w.xrpl).sign(rlusdPayment()), (e) => e instanceof PresignBlockedError && e.code === "red" && /XRPL_FAKE_RLUSD/.test(e.message));
  const g = world();
  await assert.rejects(make(g).xrplSigner(g.xrpl).sign({ TransactionType: "SetRegularKey", Account: ME, RegularKey: SELLER }), (e) => e.code === "unsupported_chain");
  await assert.rejects(make(g).xrplSigner(g.xrpl).sign(rlusdPayment("1", { Account: SELLER })), (e) => e.code === "unsupported_chain");
  assert.equal(w.log.signed.length + g.log.signed.length, 0);
  assert.equal(g.log.checks.length, 0, "refused before paying for a check");
});

test("limits: RLUSD counts toward the USDC budget, XRP toward an XRP budget; over the limit goes to onOverLimit", async () => {
  const asked = [];
  const w = world();
  const signer = make(w, { limits: { tokens: { USDC: { perTx: "1", perDay: "2" }, XRP: { perTx: "5" } } }, onOverLimit: async (info) => { asked.push(info); return false; } }).xrplSigner(w.xrpl);
  await signer.sign(rlusdPayment("0.5"));
  await signer.sign({ TransactionType: "Payment", Account: ME, Destination: SELLER, Amount: "2000000" }); // 2 XRP
  await assert.rejects(signer.sign(rlusdPayment("1.5")), (e) => e.code === "over_limit");
  assert.equal(asked.length, 1);
  assert.equal(w.log.signed.length, 2);
});

test("spendFor: fake RLUSD (another issuer) is an unknown token; SendMax is what can leave", () => {
  const policy = normalizeLimits({ tokens: { USDC: { perTx: "10" } }, unknownTokens: "stop" });
  const fake = spendFor({ type: "xrpl", network: "xrpl:0", tx: rlusdPayment("1", { Amount: { currency: RLUSD, issuer: SELLER, value: "1" } }) });
  assert.equal(fake.items[0].token, `${RLUSD}.${SELLER}`);
  assert.ok(evaluate(policy, fake, new Map()).hardStop);
  const viaSendMax = spendFor({ type: "xrpl", network: "xrpl:0", tx: { TransactionType: "Payment", Account: ME, Destination: SELLER, Amount: "1000", SendMax: { currency: RLUSD, issuer: ISSUER, value: "3" } } });
  assert.equal(viaSendMax.items[0].token, "rlusd");
  assert.equal(viaSendMax.items[0].amount, 3n * 10n ** 18n);
});

test("any: other transactions are checked by presign-guard, then signed; red (a takeover inside a Batch) never", async () => {
  const w = world();
  const signer = make(w).xrplSigner(w.xrpl, { any: true });
  await signer.sign({ TransactionType: "TrustSet", Account: ME, LimitAmount: { currency: RLUSD, issuer: ISSUER, value: "1000" } });
  assert.equal(w.log.checks[0].tx.TransactionType, "TrustSet");
  assert.equal(w.log.signed.length, 1);

  const r = world({ verdict: "red", reasons: [{ code: "XRPL_REGULAR_KEY_CHANGE", severity: "red", details: { inner: 1 } }] });
  const batch = { TransactionType: "Batch", Account: ME, Flags: 65536, RawTransactions: [{ RawTransaction: rlusdPayment() }, { RawTransaction: { TransactionType: "SetRegularKey", Account: ME, RegularKey: SELLER } }] };
  await assert.rejects(make(r).xrplSigner(r.xrpl, { any: true }).sign(batch), (e) => e.code === "red" && /XRPL_REGULAR_KEY_CHANGE/.test(e.message));
  assert.equal(r.log.checks[0].tx.RawTransactions.length, 2, "the whole Batch goes to presign-guard");
  assert.equal(r.log.signed.length, 0);
  await assert.rejects(make(r).xrplSigner(r.xrpl, { any: true }).sign({ TransactionType: "TrustSet", Account: SELLER }), (e) => e.code === "unsupported_chain", "still only this account");
});

test("any + limits: a DEX order counts what it gives, a Batch its own inner payments together; unknown types go to onOverLimit", async () => {
  const asked = [];
  const w = world();
  const signer = make(w, { limits: { tokens: { USDC: { perTx: "1", perDay: "5" }, XRP: { perTx: "5" } } }, onOverLimit: async (info) => { asked.push(info); return false; } }).xrplSigner(w.xrpl, { any: true });
  await signer.sign({ TransactionType: "OfferCreate", Account: ME, TakerGets: { currency: RLUSD, issuer: ISSUER, value: "0.8" }, TakerPays: "2000000" });
  await assert.rejects(signer.sign({ TransactionType: "OfferCreate", Account: ME, TakerGets: { currency: RLUSD, issuer: ISSUER, value: "3" }, TakerPays: "8000000" }), (e) => e.code === "over_limit");
  const two = (v) => ({ TransactionType: "Batch", Account: ME, Flags: 65536, RawTransactions: [{ RawTransaction: rlusdPayment(v) }, { RawTransaction: rlusdPayment(v) }, { RawTransaction: { TransactionType: "Payment", Account: SELLER, Destination: ME, Amount: "99000000" } }] });
  await signer.sign(two("0.4")); // 0.8 RLUSD of this account; the other account's 99 XRP isn't ours
  await assert.rejects(signer.sign(two("0.6")), (e) => e.code === "over_limit", "1.2 together is over 1 per transaction");
  await assert.rejects(signer.sign({ TransactionType: "AccountDelete", Account: ME, Destination: SELLER }), (e) => e.code === "over_limit");
  assert.deepEqual(asked.map((a) => a.reasons.map((x) => x.code).join()), ["per_tx", "per_tx", "unknown_spend"]);
  await signer.sign({ TransactionType: "TrustSet", Account: ME, LimitAmount: { currency: RLUSD, issuer: ISSUER, value: "1000" } }); // moves nothing
  assert.equal(w.log.signed.length, 3);
});

test("spendFor: checks, escrows, channels, NFT buy offers and MPT amounts", () => {
  const sp = (tx) => spendFor({ type: "xrpl", network: "xrpl:0", tx: { Account: ME, ...tx } });
  assert.deepEqual(sp({ TransactionType: "CheckCreate", Destination: SELLER, SendMax: "5000000" }).items.map((i) => [i.token, i.amount]), [["native", 5000000n]]);
  assert.equal(sp({ TransactionType: "EscrowCreate", Destination: SELLER, Amount: "7" }).items[0].to, SELLER.toLowerCase());
  assert.equal(sp({ TransactionType: "PaymentChannelFund", Channel: "AB".repeat(32), Amount: "9" }).items[0].amount, 9n);
  assert.equal(sp({ TransactionType: "NFTokenCreateOffer", NFTokenID: "00", Owner: SELLER, Amount: "4" }).items[0].amount, 4n);
  assert.equal(sp({ TransactionType: "NFTokenCreateOffer", NFTokenID: "00", Amount: "0", Flags: 1 }).items.length, 0);
  assert.equal(sp({ TransactionType: "Payment", Destination: SELLER, Amount: { mpt_issuance_id: "0".repeat(48), value: "100" } }).items[0].token, `mpt.${"0".repeat(48)}`);
  assert.equal(sp({ TransactionType: "SetRegularKey", RegularKey: SELLER }).unknown, true);
  assert.equal(sp({ TransactionType: "MPTokenAuthorize", MPTokenIssuanceID: "0".repeat(48) }).unknown, false);
});

test("spendFor: vault deposits, cover deposits and loan payments count; withdrawals only to another account; loans move nothing out", () => {
  const sp = (tx) => spendFor({ type: "xrpl", network: "xrpl:0", tx: { Account: ME, ...tx } });
  const id = "AB".repeat(32);
  const rl = (value) => ({ currency: RLUSD, issuer: ISSUER, value });
  assert.deepEqual(sp({ TransactionType: "VaultDeposit", VaultID: id, Amount: rl("250") }).items.map((i) => [i.token, i.to]), [["rlusd", null]]);
  assert.equal(sp({ TransactionType: "LoanBrokerCoverDeposit", LoanBrokerID: id, Amount: "5000000" }).items[0].amount, 5000000n);
  assert.equal(sp({ TransactionType: "LoanPay", LoanID: id, Amount: rl("85.5") }).items[0].token, "rlusd");
  const own = sp({ TransactionType: "VaultWithdraw", VaultID: id, Amount: rl("100") });
  assert.deepEqual([own.items.length, own.unknown], [0, false]);
  assert.equal(sp({ TransactionType: "VaultWithdraw", VaultID: id, Amount: rl("100"), Destination: ME }).items.length, 0);
  const other = sp({ TransactionType: "VaultWithdraw", VaultID: id, Amount: rl("100"), Destination: SELLER });
  assert.deepEqual(other.items.map((i) => [i.token, i.to]), [["rlusd", SELLER.toLowerCase()]]);
  assert.equal(sp({ TransactionType: "LoanBrokerCoverWithdraw", LoanBrokerID: id, Amount: "7", Destination: SELLER }).items[0].amount, 7n);
  for (const TransactionType of ["VaultCreate", "VaultSet", "LoanBrokerSet", "LoanSet", "LoanManage", "LoanDelete"]) {
    const r = sp({ TransactionType, VaultID: id });
    assert.deepEqual([r.items.length, r.unknown], [0, false], TransactionType);
  }
});
