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

// A presign-guard that also takes credit keys: `credits` checks, then 402 with "insufficient".
function creditWorld({ credits = 2, known = true } = {}) {
  const w = world();
  const plain = [];
  const fetchFn = async (url, init) => {
    plain.push(init.headers["x-credit-key"]);
    if (!known) return new Response("{}", { status: 402, headers: { "x-credit-status": "unknown" } });
    if (credits <= 0) return new Response("{}", { status: 402, headers: { "x-credit-status": "insufficient", "x-credits-remaining": "0" } });
    credits -= 1;
    const input = JSON.parse(init.body);
    const body = await signed({ version: "2", verdict: "green", reasons: [], checkedAt: "2026-09-30T10:00:00.000Z" }, input);
    return Response.json(body, { headers: { "x-credit-status": "paid", "x-credits-remaining": String(credits) } });
  };
  return { ...w, fetchFn, plain };
}
const KEY = "pgc_" + "A".repeat(43);

test("credits: checks are paid from the credit key first, then per check when they run out", async () => {
  const c = creditWorld({ credits: 2 });
  const seen = [];
  const g = make(c, { creditKey: KEY, fetch: c.fetchFn, onVerdict: (_v, info) => seen.push([info.paidWith, info.creditsLeft]) });
  await g.sendTransaction({ to: SPENDER });
  await g.sendTransaction({ to: SPENDER });
  await g.sendTransaction({ to: SPENDER }); // 0 left: pays per check without asking with the key
  assert.deepEqual(seen, [["credits", 1], ["credits", 0], ["x402", 0]]);
  assert.equal(c.plain.length, 2);
  assert.equal(c.log.checks.length, 1);
  assert.equal(c.log.signed.length, 3);

  // Without the remaining count, a 402 "insufficient" falls back to pay too.
  const d = creditWorld({ credits: 0 });
  await make(d, { creditKey: KEY, fetch: d.fetchFn }).sendTransaction({ to: SPENDER });
  assert.equal(d.plain.length, 1);
  assert.equal(d.log.checks.length, 1);
});

test("credits: an unknown key falls back to pay; without pay the wallet stops", async () => {
  const c = creditWorld({ known: false });
  await make(c, { creditKey: KEY, fetch: c.fetchFn }).sendTransaction({ to: SPENDER });
  assert.equal(c.log.checks.length, 1);

  const d = creditWorld({ credits: 0 });
  const g = guardWallet(d.wallet, { creditKey: KEY, fetch: d.fetchFn, signers: [presignKey.address] });
  await assert.rejects(g.sendTransaction({ to: SPENDER }), { code: "check_failed" });
  assert.equal(d.log.signed.length, 0);
  assert.throws(() => guardWallet(d.wallet, { creditKey: "nope" }), /credit key/);
});

test("withPurchase: what is bought reaches onSpend and onOverLimit; outside it nothing is attached", async () => {
  const w = world();
  const spends = [], asked = [];
  const g = make(w, {
    limits: { tokens: { ETH: { perTx: "0.001" } } },
    onSpend: (e) => spends.push(e),
    onOverLimit: async (info) => { asked.push(info.purchase); return true; },
  });
  const what = { url: "https://api.example.com/report", description: "weekly market report" };
  const out = await g.withPurchase(what, async (report) => {
    const hash = await g.sendTransaction({ to: SPENDER, value: 10n ** 14n });
    report({ httpStatus: 200 });
    return hash;
  });
  assert.equal(out, "0xtx");
  assert.deepEqual(spends[0].purchase, what);
  await g.withPurchase({ description: "big one" }, () => g.sendTransaction({ to: SPENDER, value: 10n ** 16n }));
  assert.deepEqual(asked, [{ description: "big one" }]);
  await g.sendTransaction({ to: SPENDER, value: 1n });
  assert.equal(spends.at(-1).purchase, null);
});

test("withPurchase: bad input is refused, errors from fn come through", async () => {
  const g = make(world());
  await assert.rejects(g.withPurchase({ url: "ftp://x" }, async () => {}), /https/);
  await assert.rejects(g.withPurchase(null, async () => {}), /info/);
  await assert.rejects(g.withPurchase({}, "nope"), /fn/);
  await assert.rejects(g.withPurchase({ description: "x" }, async () => { throw new Error("api down"); }), /api down/);
});

// Tempo: not covered by presign-guard; only a USDC.e transfer is signed, checked here and counted as USDC.
const TEMPO_USDC = "0x20C000000000000000000000b9537D11c60E8b50";
const TIP20 = parseAbi(["function transferWithMemo(address to, uint256 amount, bytes32 memo)", "function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);
const MEMO = `0x${"ab".repeat(32)}`;
function tempoWallet(id = 4217) {
  const signed = [];
  return { signed, wallet: { chain: { id }, account: { address: "0x2222222222222222222222222222222222222222" }, writeContract: async (a) => { signed.push(a); return "0xtempo"; }, sendTransaction: async (a) => { signed.push(a); return "0xtempo"; }, signTypedData: async (a) => { signed.push(a); return "0xsig"; } } };
}

test("Tempo: a USDC.e transferWithMemo is signed without a presign-guard check and counts toward the USDC limit", async () => {
  const w = world();
  const t = tempoWallet();
  const guard = make(w, { limits: { tokens: { USDC: { perTx: "1", perDay: "1.5" } } } });
  const tempo = guard.wrap(t.wallet);
  assert.equal(await tempo.writeContract({ address: TEMPO_USDC, abi: TIP20, functionName: "transferWithMemo", args: [SPENDER, 1_000_000n, MEMO] }), "0xtempo");
  assert.equal(w.log.checks.length, 0);
  assert.equal(t.signed.length, 1);
  // The same budget as USDC on Base: 1 of 1.5 used, so another 1 on Tempo is over the day limit.
  await assert.rejects(tempo.writeContract({ address: TEMPO_USDC, abi: TIP20, functionName: "transfer", args: [SPENDER, 1_000_000n] }), (err) => err.code === "over_limit");
  const [row] = await guard.spending();
  assert.deepEqual([row.token, row.used, row.left], ["USDC", "1", "0.5"]);
  assert.equal(t.signed.length, 1);
});

test("Tempo: anything but a stablecoin transfer is refused, and pause covers the wrapped wallet", async () => {
  const w = world();
  const t = tempoWallet();
  const guard = make(w);
  const tempo = guard.wrap(t.wallet);
  const refused = [
    tempo.writeContract({ address: TEMPO_USDC, abi: TIP20, functionName: "approve", args: [SPENDER, 1n] }),
    tempo.writeContract({ address: SPENDER, abi: TIP20, functionName: "transfer", args: [SPENDER, 1n] }),
    tempo.sendTransaction({ to: SPENDER, data: "0x" }),
    tempo.signTypedData({ domain: {}, types: {}, primaryType: "X", message: {} }),
  ];
  for (const p of refused) await assert.rejects(p, (err) => err instanceof PresignBlockedError && err.code === "unsupported_chain");
  guard.pause();
  await assert.rejects(tempo.writeContract({ address: TEMPO_USDC, abi: TIP20, functionName: "transfer", args: [SPENDER, 1n] }), (err) => err.code === "paused");
  assert.equal(t.signed.length, 0);
  assert.equal(w.log.checks.length, 0);
});

test("Tempo testnet: pathUSD is the stablecoin there", async () => {
  const w = world();
  const t = tempoWallet(42431);
  const tempo = make(w).wrap(t.wallet);
  assert.equal(await tempo.writeContract({ address: "0x20c0000000000000000000000000000000000000", abi: TIP20, functionName: "transfer", args: [SPENDER, 5n] }), "0xtempo");
  await assert.rejects(tempo.writeContract({ address: TEMPO_USDC, abi: TIP20, functionName: "transfer", args: [SPENDER, 5n] }), (err) => err.code === "unsupported_chain");
});

test("withPurchase with a wallet server: the server's answer check reaches onChecked before the result is returned", async () => {
  const w = world();
  const calls = [];
  const serverFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/v1/reserve") return Response.json({ status: "ok", entries: ["e1"], purchaseId: "pu_1" });
    if (path === "/v1/purchases/annotate") return Response.json({ updated: 1, check: { injection: { flagged: true, why: "test", decidedBy: "jev" } } });
    return Response.json({ ok: true });
  };
  const g = make(w, { server: { url: "https://wallet.test", key: "awk_test", fetch: serverFetch } });
  const out = await g.withPurchase({ url: "https://api.example.com/x", description: "data" }, async (report) => {
    await g.sendTransaction({ to: SPENDER, value: 1n });
    report({ httpStatus: 200, content: { contentType: "text/plain", body: "hi" } });
    return { body: "hi" };
  }, { onChecked: (check, o) => ({ warned: check.injection.flagged, ...o }) });
  assert.deepEqual(out, { warned: true, body: "hi" });
  assert.ok(calls.includes("/v1/purchases/annotate"));
  // Without onChecked the result is unchanged.
  const plain = await g.withPurchase({ description: "data" }, async (report) => { await g.sendTransaction({ to: SPENDER, value: 1n }); report({ httpStatus: 200 }); return "same"; });
  assert.equal(plain, "same");
});

// MPP sessions on Tempo: a guarded account that signs only escrow deposits (counted) and their vouchers.
const ESCROW = "0x4d50500000000000000000000000000000000000";
const ESCROW_ABI = parseAbi([
  "function open(address payee, address operator, address token, uint96 deposit, bytes32 salt, address authorizedSigner)",
  "function topUp((address payer, address payee, address operator, address token, bytes32 salt, address authorizedSigner, bytes32 expiringNonceHash) descriptor, uint96 additionalDeposit)",
]);
const { encodeFunctionData } = await import("viem");
function sessionAccount() {
  const signed = [];
  const base = privateKeyToAccount(generatePrivateKey());
  return { signed, base, account: { ...base, signTransaction: async (tx) => { signed.push(tx); return "0xsignedtx"; }, signTypedData: async (td) => { signed.push(td); return "0xvoucher"; } } };
}
const openCall = (me, { token = TEMPO_USDC.toLowerCase(), deposit = 500_000n, signer = me } = {}) => ({ to: ESCROW, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "open", args: [SPENDER, SPENDER, token, deposit, MEMO, signer] }) });
const voucher = (over = {}) => ({ domain: { name: "TIP20 Channel Reserve", version: "1", chainId: 4217, verifyingContract: ESCROW }, types: { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint96" }] }, primaryType: "Voucher", message: { channelId: MEMO, cumulativeAmount: 10_000n }, ...over });

test("MPP session account: an escrow open is signed and its deposit counts toward the USDC limit", async () => {
  const w = world();
  const s = sessionAccount();
  const guard = make(w, { limits: { tokens: { USDC: { perTx: "1", perDay: "0.75" } } } });
  const acct = guard.tempoSessionAccount(s.account);
  assert.equal(acct.address, s.base.address);
  assert.equal(await acct.signTransaction({ chainId: 4217, calls: [openCall(s.base.address)], feeToken: TEMPO_USDC }), "0xsignedtx");
  assert.equal(w.log.checks.length, 0);
  const [row] = await guard.spending();
  assert.deepEqual([row.used, row.left], ["0.5", "0.25"]);
  // A top-up of the same channel counts too: 0.5 more is over the day.
  const descriptor = { payer: s.base.address, payee: SPENDER, operator: SPENDER, token: TEMPO_USDC.toLowerCase(), salt: MEMO, authorizedSigner: s.base.address, expiringNonceHash: MEMO };
  const topUp = { to: ESCROW, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "topUp", args: [descriptor, 500_000n] }) };
  await assert.rejects(acct.signTransaction({ chainId: 4217, calls: [topUp] }), (err) => err.code === "over_limit");
  // Vouchers spend what is already deposited: signed, not counted again.
  assert.equal(await acct.signTypedData(voucher()), "0xvoucher");
  assert.equal(await acct.signTypedData(voucher({ primaryType: "CloseAuthorization", types: { CloseAuthorization: voucher().types.Voucher } })), "0xvoucher");
  assert.equal((await guard.spending())[0].used, "0.5");
});

test("MPP session account: anything but one escrow deposit for this account, or a voucher, is refused", async () => {
  const w = world();
  const s = sessionAccount();
  const guard = make(w);
  const acct = guard.tempoSessionAccount(s.account);
  const me = s.base.address;
  const refused = [
    acct.signTransaction({ chainId: 4217, calls: [openCall(me), openCall(me)] }),
    acct.signTransaction({ chainId: 4217, calls: [{ to: TEMPO_USDC, data: encodeFunctionData({ abi: TIP20, functionName: "approve", args: [SPENDER, 1n] }) }] }),
    acct.signTransaction({ chainId: 4217, calls: [openCall(me, { token: SPENDER })] }),
    acct.signTransaction({ chainId: 4217, calls: [openCall(me, { signer: SPENDER })] }),
    acct.signTransaction({ chainId: 4217, calls: [{ ...openCall(me), value: 1n }] }),
    acct.signTransaction({ chainId: 4217, calls: [openCall(me)], feeToken: SPENDER }),
    acct.signTransaction({ chainId: 1, calls: [openCall(me)] }),
    acct.signTypedData(voucher({ domain: { ...voucher().domain, verifyingContract: SPENDER } })),
    acct.signTypedData(voucher({ primaryType: "TransferWithAuthorization" })),
    acct.signTypedData(voucher({ domain: { ...voucher().domain, chainId: 8453 } })),
    acct.sign({ hash: MEMO }),
    acct.signMessage({ message: "hi" }),
  ];
  for (const p of refused) await assert.rejects(p, (err) => err instanceof PresignBlockedError && err.code === "unsupported_chain");
  guard.pause();
  await assert.rejects(acct.signTransaction({ chainId: 4217, calls: [openCall(me)] }), (err) => err.code === "paused");
  await assert.rejects(acct.signTypedData(voucher()), (err) => err.code === "paused");
  assert.equal(s.signed.length, 0);
  assert.throws(() => guard.tempoSessionAccount(s.account, { chainId: 8453 }), /chainId/);
});
