// Paying from the connector in USDC on Solana (src/connector-solana.js): the app asks, the owner's Solana wallet signs
// the x402 transaction on the approve page (the seller's facilitator pays the fee), the server checks what came back
// and sends it to a seller that verifies it. Also: a wallet's Lighthouse guard is fine, any other change isn't; a
// wrong signer, the seller's own accounts, too little USDC and a sanctioned wallet are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes, generateKeyPairSync, sign as edSign } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { createAccounts } from "../src/accounts.js";
import { memoryStore } from "../src/store.js";
import { b58encode, associatedTokenAccount, verifySolanaSignature, USDC_MINT } from "../src/solana.js";
import { solanaOffer, paymentMessage, unsignedTransaction, parseTransaction, parseMessage, checkSigned, signatureOf, createSolanaReader, SOLANA_MAINNET } from "../src/connector-solana.js";

const PASSWORD = "correct horse battery staple";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const BLOCKHASH = b58encode(randomBytes(32));

// A Solana keypair, as a wallet holds it.
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { address: b58encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")), sign: (m) => new Uint8Array(edSign(null, Buffer.from(m), privateKey)) };
}
const FEE_PAYER = keypair().address;
const PAY_TO = keypair().address;
const LISTED = keypair().address; // on the sanctions list
const compact = (n) => { const out = []; for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); return out; } } };
const b58bytes = (a) => { const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = 0n; for (const c of a) n = n * 58n + BigInt(ALPHA.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of a) { if (c !== "1") break; out.unshift(0); } return out; };
// A parsed message back to bytes (the test's wallet changes messages with this).
function encode(m) {
  const at = (k) => m.keys.indexOf(k);
  const out = [0x80, m.signers, m.readonlySigned, m.readonlyUnsigned, ...compact(m.keys.length)];
  for (const k of m.keys) out.push(...b58bytes(k));
  out.push(...b58bytes(m.blockhash), ...compact(m.instructions.length));
  for (const i of m.instructions) out.push(at(i.program), ...compact(i.accounts.length), ...i.accounts.map(at), ...compact(i.data.length), ...i.data);
  out.push(0);
  return Uint8Array.from(out);
}
// What a wallet does: sign the message (maybe changed first) and put the signature in the owner's slot.
function walletSign(txB64, wallet, change) {
  const { message } = parseTransaction(Buffer.from(txB64, "base64"));
  let msg = message;
  if (change) { const m = parseMessage(message); change(m); msg = encode(m); }
  return Buffer.from([...compact(2), ...new Uint8Array(64), ...wallet.sign(msg), ...msg]).toString("base64");
}

function seller() {
  const seen = [];
  const sol = { scheme: "exact", network: SOLANA_MAINNET, amount: "10000", asset: USDC_MINT, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    seen.push({ url: req.url, headers: req.headers });
    const header = req.headers["payment-signature"];
    if (header) {
      const p = JSON.parse(Buffer.from(header, "base64").toString());
      const { signatures, message } = parseTransaction(Buffer.from(p.payload.transaction, "base64"));
      const m = parseMessage(message);
      const t = m.instructions[2];
      const amount = Buffer.from(t.data).readBigUInt64LE(1);
      const ok = m.feePayer === FEE_PAYER && t.data[0] === 12 && amount === 10000n && t.accounts[2] === associatedTokenAccount(PAY_TO) && verifySolanaSignature(m.keys[1], message, signatures[1]);
      if (ok) {
        res.setHeader("payment-response", Buffer.from(JSON.stringify({ success: true, transaction: b58encode(signatures[1]), network: SOLANA_MAINNET })).toString("base64"));
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ city: "Amsterdam", temp_c: 13 }));
      }
    }
    res.statusCode = 402;
    res.setHeader("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}` }, accepts: [sol] })).toString("base64"));
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seen })));
}

async function boot() {
  const chain = { usdc: "5000000", sanctioned: [LISTED] };
  const services = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://presign.test/v1/sanctions") return Response.json({ addresses: chain.sanctioned.map((address) => ({ address })) });
    if (u.startsWith("https://doctor.test/api/trust")) return Response.json({ days_checked: 30, days_payable: 30, last_scan: { verdict: "go" } });
    if (u === "https://base.test") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" });
    if (u === "https://solana.test") {
      const { method } = JSON.parse(init.body);
      if (method === "getLatestBlockhash") return Response.json({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } } });
      if (method === "getTokenAccountBalance") return chain.usdc === null ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: could not find account" } }) : Response.json({ jsonrpc: "2.0", id: 1, result: { value: { amount: chain.usdc, decimals: 6 } } });
    }
    throw new Error(`unexpected ${u}`);
  };
  const store = memoryStore();
  const accounts = createAccounts({ store, publicUrl: "https://wallet.test", billing: { payTo: "0x1111111111111111111111111111111111111111", priceUsdc: 5, rpcUrl: "https://rpc.test", fetch: async () => Response.json({ result: null }) }, walletOptions: { authority: null } });
  accounts.tellOwner = async () => {};
  const app = createApp({ accounts, auth: createAuth({ password: PASSWORD, secure: false }), usage: { record: () => {} }, oauthStore: store.global,
    connector: { fetch: services, presignUrl: "https://presign.test", doctorUrl: "https://doctor.test", baseRpc: "https://base.test", solanaRpc: "https://solana.test", allowPrivate: true, statusWaitMs: 300 } });
  const server = app.listen(0);
  return { chain, base: `http://127.0.0.1:${server.address().port}`, server, accounts };
}

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function connect(base) {
  const cookie = (await fetch(`${base}/api/login`, json({ password: PASSWORD }))).headers.get("set-cookie").split(";")[0];
  const reg = await (await fetch(`${base}/oauth/register`, json({ redirect_uris: [REDIRECT], client_name: "Claude" }))).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const loc = (await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" })).headers.get("location");
  const consent = await (await fetch(`${base}/oauth/consent`, { ...json({ req: new URL(loc, base).searchParams.get("req"), allow: true }), headers: { "content-type": "application/json", cookie } })).json();
  const code = new URL(consent.redirect).searchParams.get("code");
  const t = await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }).toString() })).json();
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t.access_token}` } } }));
  return client;
}

test("solana helpers: the USDC offer, the x402 transaction, and the checks on what the wallet signed", () => {
  const accepts = [{ scheme: "exact", network: SOLANA_MAINNET, amount: "10000", asset: USDC_MINT, payTo: PAY_TO, extra: { feePayer: FEE_PAYER } }];
  const offer = solanaOffer({ x402Version: 2, accepts });
  assert.deepEqual([offer.amount, offer.price, offer.payTo, offer.feePayer, offer.memo], ["10000", 0.01, PAY_TO, FEE_PAYER, null]);
  assert.equal(solanaOffer({ x402Version: 2, accepts: [{ ...accepts[0], extra: {} }] }), null, "no fee payer");
  assert.equal(solanaOffer({ x402Version: 2, accepts: [{ ...accepts[0], asset: "So11111111111111111111111111111111111111112" }] }), null, "not USDC");
  assert.equal(solanaOffer({ x402Version: 2, accepts: [{ ...accepts[0], network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }] }), null, "devnet");

  const owner = keypair();
  const message = paymentMessage(offer, owner.address, BLOCKHASH, "abc");
  const m = parseMessage(message);
  assert.deepEqual([m.feePayer, m.keys[1], m.blockhash, m.signers, m.readonlySigned], [FEE_PAYER, owner.address, BLOCKHASH, 2, 1]);
  assert.deepEqual(m.instructions.map((i) => i.program), ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"]);
  assert.deepEqual(m.instructions[2].accounts, [associatedTokenAccount(owner.address), USDC_MINT, associatedTokenAccount(PAY_TO), owner.address]);
  assert.equal(Buffer.from(m.instructions[2].data).readBigUInt64LE(1), 10000n);
  assert.equal(Buffer.from(m.instructions[3].data).toString(), "abc");
  assert.deepEqual(encode(m), message, "the test's encoder matches");
  assert.throws(() => paymentMessage(offer, PAY_TO, BLOCKHASH), /can't pay this seller/);

  const unsigned = Buffer.from(unsignedTransaction(message)).toString("base64");
  assert.ok(checkSigned(walletSign(unsigned, owner), message, owner.address).transaction);
  // Phantom's Lighthouse guard after the payment: fine.
  const guarded = walletSign(unsigned, owner, (x) => { x.keys.push(LIGHTHOUSE); x.readonlyUnsigned += 1; x.instructions.push({ program: LIGHTHOUSE, accounts: [x.keys[2]], data: [9, 9] }); });
  assert.ok(checkSigned(guarded, message, owner.address).transaction);
  // Anything else changed: refused.
  const changed = (fn) => checkSigned(walletSign(unsigned, owner, fn), message, owner.address).error;
  assert.match(changed((x) => { x.instructions[2] = { ...x.instructions[2], data: [12, ...Buffer.from("40420f0000000000", "hex"), 6] }; }), /changed the payment/);
  assert.match(changed((x) => { x.instructions.push({ program: x.keys[5], accounts: [x.keys[2], x.keys[4], x.keys[3], x.keys[1]], data: [12, 1, 0, 0, 0, 0, 0, 0, 0, 6] }); }), /changed the payment/);
  assert.match(changed((x) => { x.blockhash = b58encode(randomBytes(32)); }), /changed the payment/);
  assert.match(checkSigned(walletSign(unsigned, keypair()), message, owner.address).error, /isn't from/);
  assert.match(checkSigned("bm90IGEgdHg=", message, owner.address).error, /isn't a Solana transaction/);
});

test("solana: the app asks, the owner's wallet signs on the page, the seller is paid; refusals before signing", async () => {
  const s = await boot();
  const shop = await seller();
  try {
    const client = await connect(s.base);
    const a = (await client.callTool({ name: "pay_x402", arguments: { url: `${shop.url}/forecast` } })).structuredContent;
    assert.deepEqual([a.status, a.price_usd, a.pay_with], ["waiting_for_owner", 0.01, ["USDC on Solana (Phantom)"]]);
    const id = a.payment_id;
    const v = await (await fetch(`${s.base}/connector/payments/${id}`)).json();
    assert.deepEqual([v.options.solana, v.options.base, v.token, v.network, v.payTo], [{ price: 0.01, payTo: PAY_TO }, null, "USDC", "Solana", PAY_TO]);

    const ask = (from) => fetch(`${s.base}/connector/payments/${id}/solana`, json({ from }));
    assert.equal((await ask("nope")).status, 400);
    assert.equal((await ask(FEE_PAYER)).status, 400, "the seller's fee payer");
    assert.equal((await ask(LISTED)).status, 403, "a sanctioned wallet");
    const owner = keypair();
    s.chain.usdc = "5000";
    let r = await ask(owner.address);
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /has \$0\.005 USDC on Solana, less than \$0\.01/);
    s.chain.usdc = null;
    assert.equal((await ask(owner.address)).status, 400, "no USDC account at all");
    s.chain.usdc = "5000000";
    assert.equal((await fetch(`${s.base}/connector/payments/${id}/solana/sign`, json({ transaction: "AA==" }))).status, 409, "ask for the transaction first");

    // A changed transaction is refused and nothing is sent; the real one pays.
    const t = await (await ask(owner.address)).json();
    assert.equal(t.from, owner.address);
    const bad = await fetch(`${s.base}/connector/payments/${id}/solana/sign`, json({ transaction: walletSign(t.transaction, owner, (x) => { x.instructions[3] = { ...x.instructions[3], data: [...Buffer.from("other")] }; }) }));
    assert.equal(bad.status, 400);
    assert.equal(shop.seen.filter((x) => x.headers["payment-signature"]).length, 0);
    const paid = await (await fetch(`${s.base}/connector/payments/${id}/solana/sign`, json({ transaction: walletSign(t.transaction, owner) }))).json();
    assert.deepEqual([paid.status, paid.paidWith, paid.from, paid.result.settlement.network], ["done", "solana", owner.address, SOLANA_MAINNET]);
    assert.equal(shop.seen.filter((x) => x.headers["payment-signature"]).length, 1);
    assert.equal((await fetch(`${s.base}/connector/payments/${id}/solana/sign`, json({ transaction: walletSign(t.transaction, owner) }))).status, 409, "one payment per request");

    const st = (await client.callTool({ name: "payment_status", arguments: { payment_id: id } })).structuredContent;
    assert.deepEqual([st.status, JSON.parse(st.body).temp_c], ["paid", 13]);
    const [receipt] = await s.accounts.walletFor("admin").purchases();
    assert.deepEqual([receipt.amounts, receipt.method, receipt.to], [["0.01 USDC"], "solanaTransfer", PAY_TO]);

    await client.close();
  } finally { s.server.close(); shop.server.close(); }
});

test("solana: a signed transaction's id, and whether it landed", async () => {
  const sig = randomBytes(64);
  const wire = Buffer.concat([Buffer.from([1]), sig, randomBytes(100)]).toString("base64");
  assert.equal(signatureOf(wire), b58encode(sig));
  assert.equal(signatureOf(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), randomBytes(10)]).toString("base64")), null, "unsigned");
  assert.equal(signatureOf("not a transaction"), null);
  const reader = (value, error) => createSolanaReader({ rpcUrl: "https://rpc.test", fetch: async (_u, init) => {
    assert.deepEqual(JSON.parse(init.body).params, [["sig"], { searchTransactionHistory: true }]);
    return Response.json(error ? { jsonrpc: "2.0", id: 1, error: { message: error } } : { jsonrpc: "2.0", id: 1, result: { value: [value] } });
  } });
  assert.equal(await reader({ confirmationStatus: "finalized", err: null }).landed("sig"), true);
  assert.equal(await reader({ confirmationStatus: "confirmed", err: { InstructionError: [2, "x"] } }).landed("sig"), false, "landed but failed: nothing moved");
  assert.equal(await reader(null).landed("sig"), false);
  assert.equal(await reader(undefined, "busy").landed("sig"), null);
});
