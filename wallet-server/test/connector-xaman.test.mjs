// Paying from the connector on the XRP Ledger (src/connector-xaman.js): the app asks, the owner signs the Payment in
// Xaman (a link or QR code the first time, then pushed to their app), the server checks the signed blob and sends it
// as the x402 payment to a seller that verifies it. Also: no in Xaman, an expired request, a signature after the time
// limit, too little RLUSD, a blob that isn't what was asked, and a Base payment that cancels the one in Xaman.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Wallet, decode, verifySignature, hashes } from "xrpl";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { createAccounts } from "../src/accounts.js";
import { memoryStore } from "../src/store.js";
import { USDC_BASE } from "../src/connector-pay.js";
import { xrplOffer, paymentTx, checkSigned, decimalUnits, createXrplReader, RLUSD_HEX, RLUSD_ISSUER } from "../src/connector-xaman.js";

const PASSWORD = "correct horse battery staple";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PAY_TO = "r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw";
const BASE_PAY_TO = "0x1111111111111111111111111111111111111111";
const INVOICE = "weather.test GET /forecast";
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex").toUpperCase();

// A seller that takes RLUSD on the XRP Ledger (and, on /both, USDC on Base): paid once the signed blob checks out.
function seller(chain, payTo = PAY_TO) {
  const seen = [];
  const xrpl = { scheme: "exact", network: "xrpl:0", amount: "0.01", asset: RLUSD_HEX, payTo, maxTimeoutSeconds: 300, extra: { issuer: RLUSD_ISSUER, invoiceId: INVOICE, sourceTag: 804681468, areFeesSponsored: false } };
  const base = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC_BASE, payTo: BASE_PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    seen.push({ url: req.url, headers: req.headers });
    const header = req.headers["payment-signature"];
    if (header) {
      const p = JSON.parse(Buffer.from(header, "base64").toString());
      const blob = p.payload?.signedTxBlob;
      const tx = blob ? decode(blob) : null;
      const ok = tx && p.accepted.network === "xrpl:0" && verifySignature(blob) && tx.Destination === payTo && tx.Amount.value === "0.01" && tx.InvoiceID === sha(INVOICE) && tx.LastLedgerSequence > chain.ledger && !tx.Memos;
      if (ok) {
        res.setHeader("payment-response", Buffer.from(JSON.stringify({ success: true, transaction: hashes.hashSignedTx(blob), network: "xrpl:0", payer: tx.Account })).toString("base64"));
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ city: "Amsterdam", temp_c: 12 }));
      }
      if (p.payload?.authorization) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ paid: "on base" })); }
    }
    res.statusCode = 402;
    res.setHeader("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}` }, accepts: req.url.startsWith("/both") ? [base, xrpl] : [xrpl] })).toString("base64"));
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seen })));
}

// Xaman's platform API and an XRPL node, as the server sees them.
function fakes() {
  const chain = { ledger: 1000, rlusd: "5" };
  const payloads = new Map();
  const services = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://presign.test/v1/sanctions") return Response.json({ addresses: [] });
    if (u.startsWith("https://doctor.test/api/trust")) return Response.json({ days_checked: 30, days_payable: 30, last_scan: { verdict: "go" } });
    if (u === "https://base.test") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x4c4b40" });
    if (u === "https://xrpl.test") {
      const { method } = JSON.parse(init.body);
      if (method === "ledger") return Response.json({ result: { ledger_index: chain.ledger, validated: true } });
      if (method === "account_lines") return Response.json({ result: { lines: [{ account: RLUSD_ISSUER, currency: RLUSD_HEX, balance: chain.rlusd }] } });
    }
    if (u.startsWith("https://xumm.app/api/v1/platform/payload")) {
      assert.equal(init.headers["x-api-secret"], "secret");
      if (init.method === "POST") {
        const uuid = randomUUID();
        const body = JSON.parse(init.body);
        payloads.set(uuid, { body, state: "open" });
        return Response.json({ uuid, next: { always: `https://xumm.app/sign/${uuid}` }, refs: { qr_png: `https://xumm.app/sign/${uuid}_q.png` }, pushed: !!body.user_token });
      }
      const uuid = u.split("/").pop();
      const p = payloads.get(uuid);
      if (init.method === "DELETE") { p.state = "cancelled"; return Response.json({ result: { cancelled: true } }); }
      return Response.json({
        meta: { signed: p.state === "signed", resolved: ["signed", "declined", "cancelled"].includes(p.state), cancelled: p.state === "cancelled", expired: p.state === "expired" },
        response: p.state === "signed" ? { hex: p.blob, account: p.account } : {},
        application: p.state === "signed" ? { issued_user_token: "11111111-2222-3333-4444-555555555555" } : {},
      });
    }
    throw new Error(`unexpected ${u}`);
  };
  // What the owner does in Xaman: sign the Payment shown (Xaman fills in Account, Sequence and Fee).
  const sign = (wallet, change = {}) => {
    const [uuid, p] = [...payloads].at(-1);
    const tx = { ...p.body.txjson, Account: wallet.address, Sequence: 7, Fee: "12", ...change };
    Object.assign(p, { state: "signed", blob: wallet.sign(tx).tx_blob, account: wallet.address });
    return uuid;
  };
  return { chain, payloads, services, sign };
}

async function boot() {
  const f = fakes();
  const store = memoryStore();
  const accounts = createAccounts({ store, publicUrl: "https://wallet.test", billing: { payTo: BASE_PAY_TO, priceUsdc: 5, rpcUrl: "https://rpc.test", fetch: async () => Response.json({ result: null }) }, walletOptions: { authority: null } });
  const told = [];
  accounts.tellOwner = async (id, m) => { told.push({ id, ...m }); };
  const app = createApp({ accounts, auth: createAuth({ password: PASSWORD, secure: false }), usage: { record: () => {} }, oauthStore: store.global,
    connector: { fetch: f.services, presignUrl: "https://presign.test", doctorUrl: "https://doctor.test", baseRpc: "https://base.test", xrplRpc: "https://xrpl.test", xaman: { apiKey: "key", apiSecret: "secret" }, allowPrivate: true, statusWaitMs: 300 } });
  const server = app.listen(0);
  return { ...f, base: `http://127.0.0.1:${server.address().port}`, server, accounts, told };
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
const ask = async (client, url) => (await client.callTool({ name: "pay_x402", arguments: { url, reason: "tomorrow in Amsterdam" } })).structuredContent;
const view = async (base, id) => (await fetch(`${base}/connector/payments/${id}`)).json();
const xaman = async (base, id) => fetch(`${base}/connector/payments/${id}/xaman`, { method: "POST" });

test("xrpl helpers: the RLUSD offer, the Payment Xaman shows, and the checks on what comes back", () => {
  const accepts = [{ scheme: "exact", network: "xrpl:0", amount: "0.01", asset: RLUSD_HEX, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { issuer: RLUSD_ISSUER, invoiceId: INVOICE, sourceTag: 804681468, areFeesSponsored: false } }];
  const offer = xrplOffer({ x402Version: 2, accepts });
  assert.deepEqual([offer.amount, offer.units, offer.price, offer.payTo, offer.sourceTag], ["0.01", "10000", 0.01, PAY_TO, 804681468]);
  assert.equal(xrplOffer({ x402Version: 2, accepts: [{ ...accepts[0], asset: "RLUSD" }] }).units, "10000", "the currency by name");
  assert.equal(xrplOffer({ x402Version: 2, accepts: [{ ...accepts[0], network: "xrpl:1" }] }), null, "testnet");
  assert.equal(xrplOffer({ x402Version: 2, accepts: [{ ...accepts[0], extra: { issuer: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" } }] }), null, "another issuer");
  assert.equal(xrplOffer({ x402Version: 2, accepts: [{ ...accepts[0], asset: "XRP", amount: "10000" }] }), null, "XRP has no dollar price here");
  assert.equal(xrplOffer({ x402Version: 2, accepts: [{ ...accepts[0], extra: { ...accepts[0].extra, areFeesSponsored: true } }] }), null);
  assert.equal(decimalUnits("1.5"), 1_500_000n);

  const tx = paymentTx(offer, 1062);
  assert.deepEqual(tx, { TransactionType: "Payment", Destination: PAY_TO, Amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: "0.01" }, SendMax: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: "0.01" }, InvoiceID: sha(INVOICE), SourceTag: 804681468, LastLedgerSequence: 1062 });
  const w = Wallet.generate();
  const signed = (change) => w.sign({ ...tx, Account: w.address, Sequence: 3, Fee: "12", ...change }).tx_blob;
  assert.equal(checkSigned(signed({}), offer, 1062).tx.Account, w.address);
  assert.match(checkSigned(signed({ Destination: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" }), offer, 1062).error, /another payee/);
  assert.match(checkSigned(signed({ Amount: { ...tx.Amount, value: "1" }, SendMax: { ...tx.Amount, value: "1" } }), offer, 1062).error, /another amount/);
  assert.match(checkSigned(signed({ Flags: 0x00020000 }), offer, 1062).error, /another kind of payment/);
  assert.match(checkSigned(signed({ LastLedgerSequence: 2000 }), offer, 1062).error, /another time limit/);
  assert.match(checkSigned("00ff", offer, 1062).error, /isn't a transaction/);
});

test("xaman: the app asks, the owner signs in Xaman, the seller gets the signed Payment, and the next one is pushed", async () => {
  const s = await boot();
  const shop = await seller(s.chain);
  try {
    const client = await connect(s.base);
    const a = await ask(client, `${shop.url}/forecast`);
    assert.equal(a.status, "waiting_for_owner");
    assert.deepEqual(a.pay_with, ["RLUSD on the XRP Ledger (Xaman)"]);
    assert.equal(a.price_usd, 0.01);
    assert.equal(s.payloads.size, 0, "nothing in Xaman before the owner asks for it (no token yet)");
    assert.match(s.told[0].text, /\$0\.01 RLUSD to 127\.0\.0\.1:\d+/);

    let v = await view(s.base, a.payment_id);
    assert.deepEqual([v.options.base, v.options.xrpl.price, v.options.xrpl.payTo, v.token, v.network, v.xaman], [null, 0.01, PAY_TO, "RLUSD", "XRP Ledger", null]);
    assert.equal((await fetch(`${s.base}/connector/payments/${a.payment_id}/typed`, json({ from: privateKeyToAccount(generatePrivateKey()).address }))).status, 409, "no Base offer");
    const page = await fetch(`${s.base}/approve/${a.payment_id}`);
    assert.match(page.headers.get("content-security-policy"), /img-src [^;]*https:\/\/xumm\.app/);

    // Sign in Xaman: one sign request, as asked, valid for the seller's time limit.
    const r = await xaman(s.base, a.payment_id);
    assert.equal(r.status, 200);
    v = await r.json();
    const [[uuid, p]] = [...s.payloads];
    assert.deepEqual([v.xaman.url, v.xaman.qr, v.xaman.pushed], [`https://xumm.app/sign/${uuid}`, `https://xumm.app/sign/${uuid}_q.png`, false]);
    assert.deepEqual(p.body.txjson, paymentTx(xrplOffer({ x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:0", amount: "0.01", asset: RLUSD_HEX, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { issuer: RLUSD_ISSUER, invoiceId: INVOICE, sourceTag: 804681468 } }] }), 1062));
    assert.deepEqual([p.body.options.submit, p.body.options.force_network, p.body.options.expire, p.body.user_token], [false, "MAINNET", 3, undefined]);
    assert.equal(p.body.options.return_url.app, `${s.base}/approve/${a.payment_id}`);
    assert.match(p.body.custom_meta.instruction, /Claude connector pays \$0\.01 to 127\.0\.0\.1:\d+ for "tomorrow in Amsterdam"/);
    assert.equal((await (await xaman(s.base, a.payment_id)).json()).xaman.url, v.xaman.url, "the open request is reused");
    assert.equal(s.payloads.size, 1);

    // The owner signs; the next look pays.
    const owner = Wallet.generate();
    s.sign(owner);
    v = await view(s.base, a.payment_id);
    assert.deepEqual([v.status, v.paidWith, v.from, v.result.httpStatus, v.result.settlement.network], ["done", "xrpl", owner.address, 200, "xrpl:0"]);
    const paid = shop.seen.filter((x) => x.headers["payment-signature"]);
    assert.equal(paid.length, 1);
    const st = (await client.callTool({ name: "payment_status", arguments: { payment_id: a.payment_id } })).structuredContent;
    assert.deepEqual([st.status, JSON.parse(st.body).temp_c], ["paid", 12]);
    const [receipt] = await s.accounts.walletFor("admin").purchases();
    assert.deepEqual([receipt.amounts, receipt.method, receipt.to, receipt.approvedBy], [["0.01 USDC"], "xrplPayment", PAY_TO, "your wallet"]);
    assert.equal(await s.accounts.xamanToken("admin"), "11111111-2222-3333-4444-555555555555");

    // Signed in Xaman before: the next request goes straight to the app.
    const b = await ask(client, `${shop.url}/forecast`);
    assert.equal(b.note, "The payment is also in your user's Xaman app.");
    const last = [...s.payloads.values()].at(-1);
    assert.equal(last.body.user_token, "11111111-2222-3333-4444-555555555555");
    assert.match(s.told.at(-1).text, /in Xaman \(it's in your app now\)/);
    assert.equal((await view(s.base, b.payment_id)).xaman.pushed, true);
    await client.close();
  } finally { s.server.close(); shop.server.close(); }
});

test("xaman: no in Xaman, an expired request, too late, too little RLUSD, a blob that isn't what was asked; Base cancels Xaman", async () => {
  const s = await boot();
  const shop = await seller(s.chain);
  try {
    const client = await connect(s.base);
    const owner = Wallet.generate();
    const started = async () => { const a = await ask(client, `${shop.url}/forecast`); await xaman(s.base, a.payment_id); return a.payment_id; };
    const latest = () => [...s.payloads.values()].at(-1);

    // No in Xaman: the request is declined.
    let id = await started();
    latest().state = "declined";
    assert.equal((await view(s.base, id)).status, "denied");
    assert.equal((await client.callTool({ name: "payment_status", arguments: { payment_id: id } })).structuredContent.status, "denied");

    // Expired in Xaman: back to waiting, with a note; it can be signed again.
    id = await started();
    latest().state = "expired";
    let v = await view(s.base, id);
    assert.deepEqual([v.status, v.xaman], ["waiting", null]);
    assert.match(v.note, /expired\. Nothing was paid/);

    // Signed after the last ledger: nothing is sent.
    id = await started();
    s.sign(owner);
    s.chain.ledger = 1100;
    v = await view(s.base, id);
    assert.match(v.note, /after the time limit, so nothing was paid/);
    s.chain.ledger = 1000;

    // Too little RLUSD on the signing account.
    id = await started();
    s.sign(owner);
    s.chain.rlusd = "0.005";
    v = await view(s.base, id);
    assert.match(v.note, /has \$0\.005 RLUSD, less than \$0\.01\. Nothing was paid/);
    s.chain.rlusd = "5";

    // Signed with the account the API is paid to: an XRPL account can't pay itself, so nothing is sent.
    const self = Wallet.generate();
    const own = await seller(s.chain, self.address);
    const o = await ask(client, `${own.url}/forecast`);
    await xaman(s.base, o.payment_id);
    s.sign(self);
    v = await view(s.base, o.payment_id);
    assert.deepEqual([v.status, v.xaman], ["waiting", null]);
    assert.match(v.note, /the account this API is paid to, and an XRPL account can't pay itself\. Nothing was paid/);
    assert.equal(own.seen.filter((x) => x.headers["payment-signature"]).length, 0);
    own.server.close();

    // A blob that pays someone else is refused.
    id = await started();
    s.sign(owner, { Destination: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" });
    v = await view(s.base, id);
    assert.equal(v.status, "failed");
    assert.match(v.error, /another payee/);
    assert.equal(shop.seen.filter((x) => x.headers["payment-signature"]).length, 0, "nothing was sent to the seller");

    // Both offered: Base signed first, and the request in Xaman is cancelled.
    const a = await ask(client, `${shop.url}/both`);
    assert.deepEqual(a.pay_with, ["USDC on Base", "RLUSD on the XRP Ledger (Xaman)"]);
    await xaman(s.base, a.payment_id);
    const wallet = privateKeyToAccount(generatePrivateKey());
    const t = await (await fetch(`${s.base}/connector/payments/${a.payment_id}/typed`, json({ from: wallet.address }))).json();
    const { EIP712Domain: _d, ...types } = t.typedData.types;
    const m = t.typedData.message;
    const signature = await wallet.signTypedData({ domain: t.typedData.domain, types, primaryType: t.typedData.primaryType, message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) } });
    v = await (await fetch(`${s.base}/connector/payments/${a.payment_id}/sign`, json({ signature }))).json();
    assert.deepEqual([v.status, v.paidWith], ["done", "base"]);
    assert.equal(latest().state, "cancelled");
    await client.close();
  } finally { s.server.close(); shop.server.close(); }
});

test("xrpl: whether a signed Payment was validated", async () => {
  const reader = (result) => createXrplReader({ rpcUrl: "https://xrpl.test", fetch: async (_u, init) => {
    assert.deepEqual(JSON.parse(init.body), { method: "tx", params: [{ transaction: "ABC" }] });
    return Response.json({ result });
  } });
  assert.equal(await reader({ validated: true, meta: { TransactionResult: "tesSUCCESS" } }).landed("ABC"), true);
  assert.equal(await reader({ validated: true, meta: { TransactionResult: "tecPATH_DRY" } }).landed("ABC"), false);
  assert.equal(await reader({ error: "txnNotFound" }).landed("ABC"), false);
  assert.equal(await reader({ validated: false }).landed("ABC"), null, "not validated yet");
});
