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
  assert.deepEqual(w.log.checks[0].input, { type: "transaction", chainId: 8453, from: "0x2222222222222222222222222222222222222222", to: SPENDER, data: "0x", value: "5" });
  assert.match(w.log.checks[0].url, /presign-guard\.fizzl\.eu\/v1\/check$/);
  assert.match(w.log.checks[0].ua, /^presign-guard-wallet\//);
  assert.equal(w.log.signed.length, 1);
  assert.deepEqual(seen, [["green", "sendTransaction"]]);
});

test("from: the sending wallet goes with a transaction check (so presign-guard simulates it), not with a signature", async () => {
  const w = world();
  const g = make(w);
  const other = "0x3333333333333333333333333333333333333333";
  await g.sendTransaction({ account: other, to: SPENDER, data: "0x" });
  await g.writeContract({ account: { address: other, type: "local" }, address: TOKEN, abi: parseAbi(["function transfer(address to, uint256 amount)"]), functionName: "transfer", args: [SPENDER, 1n] });
  await g.signTypedData({ domain: { name: "X", chainId: 8453 }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1n } }).catch(() => {});
  assert.equal(w.log.checks[0].input.from, other);
  assert.equal(w.log.checks[1].input.from, other);
  assert.equal(w.log.checks[2]?.input.from, undefined);
  const bare = world();
  delete bare.wallet.account;
  await make(bare).sendTransaction({ to: SPENDER, data: "0x" });
  assert.equal("from" in bare.log.checks[0].input, false);
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

test("signMessage is checked as a plain message (type message, with from); red is never signed; checkMessages: false skips it", async () => {
  const w = world();
  w.wallet.signMessage = async (args) => { w.log.signed.push(["signMessage", args]); return "0xmsg"; };
  const g = make(w, { origin: "https://app.example.org" });
  assert.equal(await g.signMessage({ message: "app.example.org wants you to sign in with your Ethereum account:\n0x2222222222222222222222222222222222222222\n" }), "0xmsg");
  assert.deepEqual(w.log.checks[0].input, { type: "message", method: "personal_sign", message: "app.example.org wants you to sign in with your Ethereum account:\n0x2222222222222222222222222222222222222222\n", chainId: 8453, origin: "https://app.example.org", from: "0x2222222222222222222222222222222222222222" });
  await g.signMessage({ message: { raw: new Uint8Array([0xde, 0xad]) } });
  assert.equal(w.log.checks[1].input.message, "0xdead");
  assert.equal(w.log.signed.length, 2);

  const red = world({ verdict: "red", reasons: [{ code: "SIGN_IN_DOMAIN_MISMATCH", severity: "red" }] });
  red.wallet.signMessage = async () => { red.log.signed.push("signMessage"); return "0xmsg"; };
  await assert.rejects(make(red).signMessage({ message: "evil.example wants you to sign in…" }), { code: "red" });
  assert.equal(red.log.signed.length, 0);

  const off = world();
  off.wallet.signMessage = async () => "0xmsg";
  assert.equal(await make(off, { checkMessages: false }).signMessage({ message: "hi" }), "0xmsg");
  assert.equal(off.log.checks.length, 0);
  assert.throws(() => make(off, { checkMessages: "yes" }), /checkMessages/);
});

test("signMessage: checked on any chain (a message has no chain), stopped while paused, never counted toward limits", async () => {
  const w = world();
  w.wallet.chain = { id: 4217 };
  w.wallet.signMessage = async () => "0xmsg";
  const g = make(w, { limits: { tokens: { USDC: { perTx: "1" } } } });
  assert.equal(await g.signMessage({ message: "hello" }), "0xmsg");
  assert.equal(w.log.checks[0].input.chainId, 4217);
  g.pause();
  await assert.rejects(g.signMessage({ message: "hello" }), { code: "paused" });
});

const DELEGATE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
// A wallet that signs EIP-7702 authorizations (a fake signature: the fields signed, plus r and s).
function authWorld(options) {
  const w = world(options);
  let n = 0;
  w.wallet.signAuthorization = async (args) => {
    w.log.signed.push(["signAuthorization", args]);
    n += 1;
    return { address: args.address ?? args.contractAddress, chainId: args.chainId, nonce: args.nonce ?? 7, r: `0x${String(n).padStart(64, "a")}`, s: `0x${String(n).padStart(64, "b")}`, yParity: 0 };
  };
  return w;
}

test("signAuthorization: an EIP-7702 delegation is checked (type authorization, with from) and signed for exactly the chain id checked", async () => {
  const w = authWorld();
  const seen = [];
  const signed = await make(w, { onVerdict: (v, info) => seen.push(info.method) }).signAuthorization({ contractAddress: DELEGATE });
  assert.deepEqual(w.log.checks[0].input, { type: "authorization", chainId: 8453, address: DELEGATE, authorizationChainId: 8453, from: "0x2222222222222222222222222222222222222222" });
  assert.equal(w.log.signed[0][1].chainId, 8453, "viem gets the chain id that was checked");
  assert.equal(signed.address, DELEGATE);
  assert.deepEqual(seen, ["signAuthorization"]);

  // chainId 0 (every chain) is checked on the client's chain, and signed as 0; a nonce goes along.
  await make(w).signAuthorization({ address: DELEGATE, chainId: 0, nonce: 3 });
  assert.deepEqual(w.log.checks[1].input, { type: "authorization", chainId: 8453, address: DELEGATE, authorizationChainId: 0, nonce: "3", from: "0x2222222222222222222222222222222222222222" });
  assert.equal(w.log.signed[1][1].chainId, 0);
  assert.equal(checkRequestFor("signAuthorization", {}), null);

  // viem signs contractAddress before address: that is the one checked, and the only one passed on.
  await make(w).signAuthorization({ contractAddress: DELEGATE, address: SPENDER });
  assert.equal(w.log.checks[2].input.address, DELEGATE);
  assert.equal(w.log.signed[2][1].address, DELEGATE);
  assert.equal("contractAddress" in w.log.signed[2][1], false);
});

test("signAuthorization: red is never signed; orange needs your onOrange function's yes (\"allow\" does not cover it); a failed check always stops", async () => {
  const red = authWorld({ verdict: "red", reasons: [{ code: "AUTHORIZATION_TO_UNVERIFIED_CONTRACT", severity: "red" }] });
  await assert.rejects(make(red, { onOrange: "allow" }).signAuthorization({ address: DELEGATE }), { code: "red" });
  assert.equal(red.log.signed.length, 0);

  const orange = authWorld({ verdict: "orange", reasons: [{ code: "EIP7702_AUTHORIZATION", severity: "orange" }] });
  await assert.rejects(make(orange, { onOrange: "allow" }).signAuthorization({ address: DELEGATE }), (err) => {
    assert.equal(err.code, "orange");
    assert.match(err.message, /EIP7702_AUTHORIZATION.*only when your onOrange function says yes/);
    return true;
  });
  assert.equal(orange.log.signed.length, 0);
  const asked = [];
  await make(orange, { onOrange: async (v, info) => { asked.push([info.method, info.request.address]); return true; } }).signAuthorization({ address: DELEGATE });
  assert.deepEqual(asked, [["signAuthorization", DELEGATE]]);
  assert.equal(orange.log.signed.length, 1);
  // "allow" still covers everything else.
  await make(orange, { onOrange: "allow" }).sendTransaction({ to: SPENDER });

  const down = authWorld({ status: 503 });
  await assert.rejects(make(down, { onError: "allow" }).signAuthorization({ address: DELEGATE }), { code: "check_failed" });
  const elsewhere = authWorld();
  elsewhere.wallet.chain = { id: 999 };
  await assert.rejects(make(elsewhere, { onError: "allow" }).signAuthorization({ address: DELEGATE }), { code: "unsupported_chain" });
  const tempo = authWorld();
  tempo.wallet.chain = { id: 4217 };
  await assert.rejects(make(tempo).signAuthorization({ address: DELEGATE }), { code: "unsupported_chain" });
  assert.equal(down.log.signed.length + elsewhere.log.signed.length + tempo.log.signed.length, 0);
});

test("authorizationList: authorizations signed here are not checked twice; others by this account are; other accounts' and other chains' are left alone", async () => {
  const me = privateKeyToAccount(generatePrivateKey());
  const someone = privateKeyToAccount(generatePrivateKey());
  const w = authWorld();
  w.wallet.account = { address: me.address };
  const g = make(w);
  const mine = await g.signAuthorization({ address: DELEGATE });
  await g.sendTransaction({ to: me.address, data: "0x", authorizationList: [mine] });
  assert.deepEqual(w.log.checks.map((c) => c.input.type), ["authorization", "transaction"]);

  const outside = await me.signAuthorization({ address: DELEGATE, chainId: 8453, nonce: 1 }); // signed with the raw key
  const theirs = await someone.signAuthorization({ address: DELEGATE, chainId: 8453, nonce: 0 });
  const otherChain = await me.signAuthorization({ address: DELEGATE, chainId: 1, nonce: 2 });
  await g.sendTransaction({ to: me.address, data: "0x", authorizationList: [outside, theirs, otherChain] });
  assert.deepEqual(w.log.checks.slice(2).map((c) => [c.input.type, c.input.from]), [["authorization", me.address], ["transaction", me.address]]);
  assert.equal(w.log.checks[2].input.nonce, "1");

  const red = authWorld({ verdict: "red", reasons: [{ code: "AUTHORIZATION_TO_FLAGGED_CONTRACT", severity: "red" }] });
  red.wallet.account = { address: me.address };
  const sweeper = await me.signAuthorization({ address: DELEGATE, chainId: 0, nonce: 4 });
  await assert.rejects(make(red, { onOrange: "allow" }).writeContract({ address: TOKEN, abi: parseAbi(["function transfer(address to, uint256 amount)"]), functionName: "transfer", args: [SPENDER, 1n], authorizationList: [sweeper] }), { code: "red" });
  assert.equal(red.log.checks[0].input.authorizationChainId, 0);
  assert.equal(red.log.signed.length, 0);
});

// viem's other ways to sign or send: the fake wallet records what each signs.
function moreWorld(options) {
  const w = world(options);
  for (const m of ["sendTransactionSync", "writeContractSync", "signTransaction", "deployContract", "sendCalls", "sendCallsSync"]) {
    w.wallet[m] = async (args) => { w.log.signed.push([m, args]); return `0x${m}`; };
  }
  return w;
}
const ERC20 = parseAbi(["function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("sendTransactionSync, writeContractSync and signTransaction are checked like sendTransaction and writeContract; red signs nothing", async () => {
  const w = moreWorld();
  const g = make(w);
  assert.equal(await g.sendTransactionSync({ to: SPENDER, data: "0x", value: 5n }), "0xsendTransactionSync");
  assert.equal(await g.signTransaction({ to: SPENDER, data: "0x12", value: 1n }), "0xsignTransaction");
  assert.equal(await g.writeContractSync({ address: BASE_USDC, abi: ERC20, functionName: "transfer", args: [SPENDER, 1n] }), "0xwriteContractSync");
  assert.deepEqual(w.log.checks.map((c) => [c.input.type, c.input.to, c.input.value]), [["transaction", SPENDER, "5"], ["transaction", SPENDER, "1"], ["transaction", BASE_USDC, "0"]]);
  assert.match(w.log.checks[2].input.data, /^0xa9059cbb/, "the transfer is encoded as writeContract would");
  assert.deepEqual(checkRequestFor("writeContractSync", { address: BASE_USDC, abi: ERC20, functionName: "transfer", args: [SPENDER, 1n] }, { chainId: 8453 }), checkRequestFor("writeContract", { address: BASE_USDC, abi: ERC20, functionName: "transfer", args: [SPENDER, 1n] }, { chainId: 8453 }));

  const red = moreWorld({ verdict: "red", reasons: [{ code: "KNOWN_DRAINER", severity: "red" }] });
  const r = make(red);
  for (const call of [() => r.sendTransactionSync({ to: SPENDER }), () => r.signTransaction({ to: SPENDER }), () => r.writeContractSync({ address: BASE_USDC, abi: ERC20, functionName: "approve", args: [SPENDER, 1n] })]) {
    await assert.rejects(call(), { code: "red" });
  }
  assert.equal(red.log.signed.length, 0);
});

test("deployContract: not checked by presign-guard, but the value it sends counts toward the limits", async () => {
  const w = moreWorld();
  const g = make(w, { limits: { tokens: { ETH: { perTx: "0.001" } } } });
  assert.equal(await g.deployContract({ abi: [], bytecode: "0x6000", value: 0n }), "0xdeployContract");
  await assert.rejects(g.deployContract({ abi: [], bytecode: "0x6000", value: 10n ** 16n }), { code: "over_limit" });
  assert.equal(w.log.checks.length, 0);
  assert.equal(w.log.signed.length, 1);
});

test("sendCalls and sendCallsSync: every call is checked; one red call stops the batch; all of it counts toward the limits or none", async () => {
  const w = moreWorld();
  const g = make(w, { limits: { tokens: { USDC: { perTx: "5", perDay: "5" } } } });
  const transfer = (usd) => ({ to: BASE_USDC, abi: ERC20, functionName: "transfer", args: [SPENDER, BigInt(usd * 1e6)] });
  assert.equal(await g.sendCalls({ calls: [transfer(2), { to: SPENDER, data: "0x", value: 0n }] }), "0xsendCalls");
  assert.deepEqual(w.log.checks.map((c) => [c.input.type, c.input.to, c.input.from]), [["transaction", BASE_USDC, "0x2222222222222222222222222222222222222222"], ["transaction", SPENDER, "0x2222222222222222222222222222222222222222"]]);
  assert.equal((await g.spending())[0].used, "2");
  // 2 + 2 fits each call's perTx of 5, but not the day's 5 with the 2 already spent: nothing of the batch is booked.
  await assert.rejects(g.sendCallsSync({ calls: [transfer(2), transfer(2)] }), { code: "over_limit" });
  assert.equal((await g.spending())[0].used, "2", "the first call of the refused batch was given back");
  assert.equal(w.log.signed.length, 1);
  await assert.rejects(g.sendCalls({ calls: [] }), { code: "check_failed" });

  const red = moreWorld({ verdict: "red", reasons: [{ code: "UNLIMITED_APPROVAL_TO_EOA", severity: "red" }] });
  await assert.rejects(make(red).sendCalls({ calls: [{ to: BASE_USDC, abi: ERC20, functionName: "approve", args: [SPENDER, 2n ** 255n] }] }), { code: "red" });
  assert.equal(red.log.signed.length, 0);
});

test("Tempo: writeContractSync of USDC.e is signed like writeContract; batches and signed transactions are refused", async () => {
  const w = world();
  const t = tempoWallet();
  for (const m of ["writeContractSync", "sendCalls", "signTransaction"]) t.wallet[m] = async (a) => { t.signed.push([m, a]); return "0xtempo"; };
  const tempo = make(w).wrap(t.wallet);
  assert.equal(await tempo.writeContractSync({ address: TEMPO_USDC, abi: TIP20, functionName: "transfer", args: [SPENDER, 1n] }), "0xtempo");
  await assert.rejects(tempo.sendCalls({ calls: [{ to: TEMPO_USDC, data: "0x" }] }), { code: "unsupported_chain" });
  await assert.rejects(tempo.signTransaction({ to: TEMPO_USDC, data: "0x" }), { code: "unsupported_chain" });
  assert.equal(t.signed.length, 1);
  assert.equal(w.log.checks.length, 0);
});
