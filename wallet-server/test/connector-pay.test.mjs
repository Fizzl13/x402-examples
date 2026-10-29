// Paying from the connector (src/connector-pay.js): the app asks, the owner signs one EIP-3009 authorization in their
// own wallet, the server sends the paid request to a seller that checks that signature, and the app reads the answer.
// Also: no, a wrong signer, a signature sent twice, the sanctions list, the balance, the price cap, other networks,
// a free API, an account without an Ethereum address (the owner picks the wallet on the page), and an API that doesn't
// answer the paid request (sent once more with the same payment).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyTypedData } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { createAccounts } from "../src/accounts.js";
import { memoryStore } from "../src/store.js";
import { baseOffer, cleanHeaders, USDC_BASE } from "../src/connector-pay.js";

const PASSWORD = "correct horse battery staple";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const SELLER = "0x1111111111111111111111111111111111111111";
const SANCTIONED = "0x2222222222222222222222222222222222222222";
const COLLECTOR = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88"; // AuthCaptureEscrow v1.1's EIP-3009 collector
const RECEIVE = { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

// A seller: a 402 on Base (and Solana) until the PAYMENT-SIGNATURE carries a valid authorization for its price.
// /flaky...: the first paid request settles but gets no answer (the connection hangs); /flaky-dedup declares x402's
// payment-identifier and answers a retry from what it kept, /flaky-strict refuses the reused authorization with a 402,
// /flaky-down never answers. /escrow: only an "auth-capture" offer ($12, Coinbase's escrow), paid by a
// ReceiveWithAuthorization to the escrow's collector.
function seller() {
  const seen = [];
  const settled = new Map(); // nonce -> the payment-identifier it came with
  const kept = new Map(); // payment id -> the answer
  const challenge = (req, payTo, amount) => ({ x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, description: "weather" }, accepts: [
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "So11111111111111111111111111111111111111112", maxTimeoutSeconds: 60 },
    { scheme: "exact", network: "eip155:8453", amount, asset: USDC_BASE, payTo, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } },
  ] });
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url.startsWith("/free")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ free: true })); }
    const payTo = req.url.startsWith("/bad") ? SANCTIONED : SELLER;
    const amount = req.url.startsWith("/dear") ? "2000000" : "2000";
    const c = req.url.startsWith("/solana") ? { ...challenge(req, payTo, amount), accepts: challenge(req, payTo, amount).accepts.slice(0, 1) } : challenge(req, payTo, amount);
    if (req.url.startsWith("/escrow")) {
      const now = Math.floor(Date.now() / 1000);
      const offer = { scheme: "auth-capture", network: "eip155:8453", amount: "12000000", asset: USDC_BASE, payTo: SELLER, maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2", captureAuthorizer: SELLER, feeRecipient: SELLER, captureDeadline: now + 86400, refundDeadline: now + 7 * 86400, minFeeBps: 0, maxFeeBps: 100 } };
      const e = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, description: "a domain" }, accepts: [offer] };
      const header = req.headers["payment-signature"];
      if (header) {
        const p = JSON.parse(Buffer.from(header, "base64").toString());
        const a = p.payload.authorization;
        const ok = p.x402Version === 2 && p.accepted.scheme === "auth-capture" && a.to.toLowerCase() === COLLECTOR.toLowerCase() && BigInt(a.value) === 12000000n && typeof p.payload.salt === "string"
          && await verifyTypedData({ address: a.from, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE }, types: RECEIVE, primaryType: "ReceiveWithAuthorization", message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: p.payload.signature });
        if (ok) {
          res.setHeader("payment-response", Buffer.from(JSON.stringify({ success: true, transaction: "0xauthorized", network: "eip155:8453", payer: a.from })).toString("base64"));
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ domain: "example.com", status: "registering" }));
        }
      }
      res.statusCode = 402;
      res.setHeader("payment-required", Buffer.from(JSON.stringify(e)).toString("base64"));
      return res.end("{}");
    }
    if (req.url.startsWith("/flaky-dedup")) c.extensions = { "payment-identifier": { info: { required: false }, schema: { type: "object" } } };
    const header = req.headers["payment-signature"];
    if (header && req.url.startsWith("/flaky")) {
      const p = JSON.parse(Buffer.from(header, "base64").toString());
      const nonce = p.payload.authorization.nonce;
      const id = p.extensions?.["payment-identifier"]?.info?.id ?? null;
      if (req.url.startsWith("/flaky-down") || !settled.has(nonce)) { settled.set(nonce, id); if (id) kept.set(id, { city: "Amsterdam", temp_c: 11 }); return; } // settles, never answers
      if (id && kept.has(id)) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(kept.get(id))); }
      res.statusCode = 402;
      res.setHeader("payment-required", Buffer.from(JSON.stringify({ ...c, error: "authorization already used" })).toString("base64"));
      return res.end("{}");
    }
    if (header) {
      const p = JSON.parse(Buffer.from(header, "base64").toString());
      const a = p.payload.authorization;
      const ok = p.x402Version === 2 && p.accepted.network === "eip155:8453" && a.to.toLowerCase() === payTo.toLowerCase() && BigInt(a.value) === BigInt(amount)
        && await verifyTypedData({ address: a.from, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE }, types: TYPES, primaryType: "TransferWithAuthorization", message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: p.payload.signature });
      if (ok) {
        res.setHeader("payment-response", Buffer.from(JSON.stringify({ success: true, transaction: "0xsettled", network: "eip155:8453", payer: a.from })).toString("base64"));
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ city: "Amsterdam", temp_c: 11, rain_mm: 14.5 }));
      }
    }
    res.statusCode = 402;
    res.setHeader("payment-required", Buffer.from(JSON.stringify(c)).toString("base64"));
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  const close = server.close.bind(server);
  server.close = () => { server.closeAllConnections(); return close(); };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seen, settled })));
}

async function boot({ balance = 5_000_000n, authorizationUsed = () => false } = {}) {
  const store = memoryStore();
  const accounts = createAccounts({ store, publicUrl: "https://wallet.test", billing: { payTo: SELLER, priceUsdc: 5, rpcUrl: "https://rpc.test", fetch: async () => Response.json({ jsonrpc: "2.0", id: 1, result: null }) }, walletOptions: { authority: null } });
  const told = [];
  accounts.tellOwner = async (id, m) => { told.push({ id, ...m }); };
  const services = async (url, init) => {
    const u = String(url);
    if (u === "https://presign.test/v1/sanctions") return Response.json({ addresses: [{ address: SANCTIONED.toLowerCase() }] });
    if (u.startsWith("https://doctor.test/api/trust")) return Response.json({ days_checked: 30, days_payable: 29, last_scan: { verdict: "go" } });
    if (u === "https://base.test") {
      const data = JSON.parse(init.body).params[0].data;
      // authorizationState(authorizer, nonce): has USDC used this authorization?
      if (data.startsWith("0xe94a0102")) return Response.json({ jsonrpc: "2.0", id: 1, result: `0x${(authorizationUsed(`0x${data.slice(-64)}`) ? 1 : 0).toString(16).padStart(64, "0")}` });
      return Response.json({ jsonrpc: "2.0", id: 1, result: `0x${balance.toString(16)}` });
    }
    throw new Error(`unexpected ${u}`);
  };
  const app = createApp({ accounts, auth: createAuth({ password: PASSWORD, secure: false }), usage: { record: () => {} }, oauthStore: store.global,
    connector: { fetch: services, presignUrl: "https://presign.test", doctorUrl: "https://doctor.test", baseRpc: "https://base.test", allowPrivate: true, statusWaitMs: 300, paidTimeoutMs: 400, retryPauseMs: 0 } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, accounts, told, store };
}

const json = (body, cookie) => ({ method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function signIn(base, account) {
  const m = await (await fetch(`${base}/api/signin/message`, json({ address: account.address }))).json();
  const r = await fetch(`${base}/api/signin`, json({ nonce: m.nonce, signature: await account.signMessage({ message: m.message }) }));
  return r.headers.get("set-cookie").split(";")[0];
}
async function logIn(base) {
  const r = await fetch(`${base}/api/login`, json({ password: PASSWORD }));
  return r.headers.get("set-cookie").split(";")[0];
}
// Registration, consent and the token, as an app would: the agent's key.
async function connect(base, cookie) {
  const reg = await (await fetch(`${base}/oauth/register`, json({ redirect_uris: [REDIRECT], client_name: "ChatGPT" }))).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const loc = (await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`, { redirect: "manual" })).headers.get("location");
  const rid = new URL(loc, base).searchParams.get("req");
  const code = new URL((await (await fetch(`${base}/oauth/consent`, json({ req: rid, allow: true }, cookie))).json()).redirect).searchParams.get("code");
  const t = await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }).toString() })).json();
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t.access_token}` } } }));
  return client;
}
// What the owner's page does: ask for the typed data, sign it in "their wallet", send the signature.
async function signOnPage(base, id, wallet, from = wallet.address) {
  const t = await (await fetch(`${base}/connector/payments/${id}/typed`, json({ from }))).json();
  const { EIP712Domain: _d, ...types } = t.typedData.types;
  const m = t.typedData.message;
  const signature = await wallet.signTypedData({ domain: t.typedData.domain, types, primaryType: t.typedData.primaryType, message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) } });
  return fetch(`${base}/connector/payments/${id}/sign`, json({ signature }));
}
const call = async (client, name, args) => client.callTool({ name, arguments: args });

test("helpers: the Base offer of a challenge, and the headers an agent may send", () => {
  const c = { x402Version: 2, resource: { url: "https://x" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC_BASE.toLowerCase(), payTo: SELLER }] };
  assert.equal(baseOffer(c).amount, "1000");
  assert.equal(baseOffer(c).version, 2);
  assert.equal(baseOffer({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "5000", asset: USDC_BASE, payTo: SELLER }] }).amount, "5000");
  assert.equal(baseOffer({ ...c, accepts: [{ ...c.accepts[0], network: "eip155:1" }] }), null);
  assert.equal(baseOffer({ ...c, accepts: [{ ...c.accepts[0], amount: "0" }] }), null);
  assert.equal(baseOffer({ ...c, accepts: [{ ...c.accepts[0], asset: "0x0000000000000000000000000000000000000001" }] }), null);
  assert.deepEqual(cleanHeaders({ Authorization: "Bearer x", Cookie: "a", "PAYMENT-SIGNATURE": "p", "X-Api-Key": "k", "content-type": "application/json", "bad header": "x" }), { "x-api-key": "k", "content-type": "application/json" });
});

test("connector payments: the app asks, the owner signs in their own wallet, the seller is paid and the answer comes back", async () => {
  const s = await seller();
  const { base, server, accounts, told } = await boot();
  try {
    const owner = privateKeyToAccount(generatePrivateKey());
    const cookie = await signIn(base, owner);
    const client = await connect(base, cookie);

    const asked = await call(client, "pay_x402", { url: `${s.url}/weather?city=Amsterdam`, reason: "tomorrow's forecast for Amsterdam" });
    assert.equal(asked.isError, undefined);
    const a = asked.structuredContent;
    assert.equal(a.status, "waiting_for_owner");
    assert.equal(a.price_usd, 0.002);
    assert.equal(a.approve_url, `${base}/approve/${a.payment_id}`);
    assert.equal(s.seen.length, 1, "only the unpaid request so far");
    assert.match(s.seen[0].headers["user-agent"], /^fizzl-wallet-connector\//);
    assert.equal(told.length, 1);
    assert.equal(told[0].id, owner.address.toLowerCase());
    assert.equal(told[0].url, `/approve/${a.payment_id}`);
    assert.match(told[0].text, /\$0\.002 USDC to 127\.0\.0\.1:\d+ for "tomorrow's forecast for Amsterdam"/);

    // The owner's page: what will be paid, and the checks.
    assert.equal((await fetch(`${base}/approve/${a.payment_id}`)).status, 200);
    const v = await (await fetch(`${base}/connector/payments/${a.payment_id}`)).json();
    assert.deepEqual([v.status, v.agent, v.price, v.payTo, v.from, v.screened], ["waiting", "ChatGPT connector", 0.002, SELLER, owner.address, true]);
    assert.deepEqual(v.record, { known: true, verdict: "go", days: 30, payableDays: 29 });
    assert.equal((await call(client, "payment_status", { payment_id: a.payment_id })).structuredContent.status, "waiting_for_owner");

    // Signing first needs the typed data; then the signature pays.
    assert.equal((await fetch(`${base}/connector/payments/${a.payment_id}/sign`, json({ signature: `0x${"1".repeat(130)}` }))).status, 409);
    const t = await (await fetch(`${base}/connector/payments/${a.payment_id}/typed`, { method: "POST" })).json();
    assert.equal(t.typedData.message.to, SELLER);
    assert.equal(t.typedData.message.value, "2000");
    assert.equal(t.typedData.domain.chainId, 8453);
    assert.ok(Number(t.typedData.message.validBefore) - Math.floor(Date.now() / 1000) <= 121, "valid for the seller's time limit");
    const paid = await signOnPage(base, a.payment_id, owner);
    assert.equal(paid.status, 200);
    const pv = await paid.json();
    assert.equal(pv.status, "done");
    assert.deepEqual(pv.result.settlement, { transaction: "0xsettled", network: "eip155:8453" });
    assert.equal(pv.result.receipt, true);

    const st = (await call(client, "payment_status", { payment_id: a.payment_id })).structuredContent;
    assert.equal(st.status, "paid");
    assert.equal(st.http_status, 200);
    assert.deepEqual(JSON.parse(st.body), { city: "Amsterdam", temp_c: 11, rain_mm: 14.5 });
    assert.equal(st.receipt, `${base}/#/purchases`);

    // One payment per request: a second signature is refused.
    assert.equal((await fetch(`${base}/connector/payments/${a.payment_id}/typed`, { method: "POST" })).status, 409);
    assert.equal((await fetch(`${base}/connector/payments/${a.payment_id}/sign`, json({ signature: `0x${"1".repeat(130)}` }))).status, 409);
    assert.equal(s.seen.filter((x) => x.headers["payment-signature"]).length, 1);

    // The receipt, and the day's total.
    const wallet = accounts.walletFor(owner.address.toLowerCase());
    const [receipt] = await wallet.purchases();
    assert.deepEqual([receipt.agentName, receipt.amounts, receipt.approvedBy, receipt.status, receipt.to], ["ChatGPT connector", ["0.002 USDC"], "your wallet", "signed", SELLER]);
    assert.equal(receipt.what.url, `${s.url}/weather?city=Amsterdam`);
    assert.equal((await wallet.spending()).find((b) => b.token === "USDC").used, "0.002");
    await client.close();
  } finally { server.close(); s.server.close(); }
});

test("connector payments: no, a wrong signer, the sanctions list, the cap, other networks, a free API and the balance", async () => {
  const s = await seller();
  const { base, server } = await boot();
  try {
    const owner = privateKeyToAccount(generatePrivateKey());
    const client = await connect(base, await signIn(base, owner));

    // No: nothing is paid.
    const one = (await call(client, "pay_x402", { url: `${s.url}/weather` })).structuredContent;
    const no = await (await fetch(`${base}/connector/payments/${one.payment_id}/deny`, { method: "POST" })).json();
    assert.equal(no.status, "denied");
    assert.equal((await call(client, "payment_status", { payment_id: one.payment_id })).structuredContent.status, "denied");
    assert.equal((await fetch(`${base}/connector/payments/${one.payment_id}/typed`, { method: "POST" })).status, 409);

    // Another wallet's signature: refused, nothing sent.
    const two = (await call(client, "pay_x402", { url: `${s.url}/weather` })).structuredContent;
    const wrong = await signOnPage(base, two.payment_id, privateKeyToAccount(generatePrivateKey()));
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).message, new RegExp(owner.address));
    assert.equal(s.seen.filter((x) => x.headers["payment-signature"]).length, 0);

    const err = async (args) => { const r = await call(client, "pay_x402", args); assert.equal(r.isError, true); return r.content[0].text; };
    assert.match(await err({ url: `${s.url}/bad` }), /OFAC sanctions list/);
    assert.match(await err({ url: `${s.url}/dear` }), /asks \$2, above max_price_usd \(\$1\)/);
    assert.match(await err({ url: `${s.url}/solana` }), /doesn't take USDC on Base.*solana:5eykt/);
    assert.match(await err({ url: "ftp://example.com/x" }), /Only https URLs/);
    const free = (await call(client, "pay_x402", { url: `${s.url}/free` })).structuredContent;
    assert.deepEqual([free.status, free.http_status, JSON.parse(free.body)], ["no_payment_needed", 200, { free: true }]);
    assert.match((await call(client, "payment_status", { payment_id: "x".repeat(32) })).content[0].text, /No such payment request/);
    await client.close();
  } finally { server.close(); s.server.close(); }
});

test("connector payments: too little USDC in the owner's wallet is said before asking", async () => {
  const s = await seller();
  const { base, server, told } = await boot({ balance: 1000n });
  try {
    const owner = privateKeyToAccount(generatePrivateKey());
    const client = await connect(base, await signIn(base, owner));
    const r = await call(client, "pay_x402", { url: `${s.url}/weather` });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /has \$0\.001 USDC on Base, less than the \$0\.002/);
    assert.equal(told.length, 0);
    await client.close();
  } finally { server.close(); s.server.close(); }
});

test("connector payments: an account without an Ethereum address pays from the wallet picked on the page", async () => {
  const s = await seller();
  const { base, server, accounts, told } = await boot();
  try {
    const client = await connect(base, await logIn(base));
    const a = (await call(client, "pay_x402", { url: `${s.url}/weather` })).structuredContent;
    assert.equal(a.status, "waiting_for_owner");
    assert.equal(told[0].id, "admin");
    const v = await (await fetch(`${base}/connector/payments/${a.payment_id}`)).json();
    assert.deepEqual([v.from, v.pick], [null, true]);

    // The page has to say which wallet pays; a signature from another one is refused.
    assert.equal((await fetch(`${base}/connector/payments/${a.payment_id}/typed`, { method: "POST" })).status, 400);
    const payer = privateKeyToAccount(generatePrivateKey());
    const wrong = await signOnPage(base, a.payment_id, privateKeyToAccount(generatePrivateKey()), payer.address);
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).message, new RegExp(`isn't from ${payer.address}\\. Sign with that wallet;`));
    assert.equal((await fetch(`${base}/connector/payments/${a.payment_id}/typed`, json({ from: SANCTIONED }))).status, 403);

    // Another pick is fine while it waits; the wallet that signs pays.
    const paid = await (await signOnPage(base, a.payment_id, payer)).json();
    assert.deepEqual([paid.status, paid.from], ["done", payer.address]);
    assert.equal(s.seen.filter((x) => x.headers["payment-signature"]).length, 1);
    assert.equal((await call(client, "payment_status", { payment_id: a.payment_id })).structuredContent.status, "paid");
    const [receipt] = await accounts.walletFor("admin").purchases();
    assert.deepEqual([receipt.amounts, receipt.approvedBy, receipt.status], [["0.002 USDC"], "your wallet", "signed"]);
    await client.close();
  } finally { server.close(); s.server.close(); }
});

test("connector payments: the picked wallet's balance is checked on the page; an e-mail account's linked wallet is the payer", async () => {
  const s = await seller();
  const { base, server, accounts, store } = await boot({ balance: 1000n });
  try {
    const client = await connect(base, await logIn(base));
    const a = (await call(client, "pay_x402", { url: `${s.url}/weather` })).structuredContent;
    assert.equal(a.status, "waiting_for_owner", "asked: the wallet isn't known yet");
    const low = await fetch(`${base}/connector/payments/${a.payment_id}/typed`, json({ from: privateKeyToAccount(generatePrivateKey()).address }));
    assert.equal(low.status, 400);
    assert.match((await low.json()).message, /has \$0\.001 USDC on Base, less than \$0\.002\. Add USDC on Base to it, or pick another wallet\./);
    await client.close();

    const linked = privateKeyToAccount(generatePrivateKey());
    await store.global.putAccount({ id: "em:test", chain: "email", address: linked.address, payChain: "ethereum" });
    await store.global.putAccount({ id: "em:sol", chain: "email", address: "So11111111111111111111111111111111111111112", payChain: "solana" });
    assert.equal(await accounts.payer("em:test"), linked.address.toLowerCase());
    assert.equal(await accounts.payer("em:sol"), null);
    assert.equal(await accounts.payer("admin"), null);
    assert.equal(await accounts.payer("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"), "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  } finally { server.close(); s.server.close(); }
});

test("connector payments: an API that doesn't answer the paid request gets the same payment once more, never a second charge", async () => {
  const s = await seller();
  let used = false; // what USDC on Base says about the authorization
  const { base, server, accounts } = await boot({ authorizationUsed: () => used });
  try {
    const owner = privateKeyToAccount(generatePrivateKey());
    const cookie = await signIn(base, owner);
    const client = await connect(base, cookie);
    const ask = async (path) => (await call(client, "pay_x402", { url: `${s.url}${path}` })).structuredContent.payment_id;
    const paidTries = (path) => s.seen.filter((x) => x.url === path && x.headers["payment-signature"]);

    // A seller with payment-identifier: the retry carries the same payment and the request's id, and gets the answer it kept.
    const id = await ask("/flaky-dedup");
    const done = await (await signOnPage(base, id, owner)).json();
    assert.equal(done.status, "done");
    const [first, second] = paidTries("/flaky-dedup");
    assert.equal(first.headers["payment-signature"], second.headers["payment-signature"], "the same signed payment, not a new one");
    assert.equal(JSON.parse(Buffer.from(first.headers["payment-signature"], "base64").toString()).extensions["payment-identifier"].info.id, id);
    const st = (await call(client, "payment_status", { payment_id: id })).structuredContent;
    assert.equal(st.status, "paid");
    assert.deepEqual(JSON.parse(st.body), { city: "Amsterdam", temp_c: 11 });

    // Without it, the retry is refused; the chain says the first try settled: a receipt, and the agent is told the answer got lost.
    used = true;
    const id2 = await ask("/flaky-strict");
    const lost = await (await signOnPage(base, id2, owner)).json();
    assert.equal(lost.status, "settled_no_answer", "paid without an answer is its own state, not failed");
    assert.match(lost.error, /went through on the first try, but the API's answer got lost/);
    assert.equal(paidTries("/flaky-strict").length, 2);
    assert.equal(JSON.parse(Buffer.from(paidTries("/flaky-strict")[0].headers["payment-signature"], "base64").toString()).extensions, undefined, "no payment-identifier when the seller didn't declare it");
    const st2 = (await call(client, "payment_status", { payment_id: id2 })).structuredContent;
    assert.equal(st2.status, "settled_no_answer");
    assert.equal(st2.receipt, `${base}/#/purchases`);
    const wallet = accounts.walletFor(owner.address.toLowerCase());
    assert.equal((await wallet.purchases()).length, 2, "one receipt per payment: the dedup one and the lost one");

    // The chain says it didn't settle: nothing was paid.
    used = false;
    const id3 = await ask("/flaky-strict-2");
    s.settled.clear();
    const refused = await (await signOnPage(base, id3, owner)).json();
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /Nothing was paid/);

    // Never an answer: at most one charge, and the owner is told to look.
    const id4 = await ask("/flaky-down");
    const down = await (await signOnPage(base, id4, owner)).json();
    assert.equal(down.status, "outcome_unknown");
    assert.equal((await call(client, "payment_status", { payment_id: id4 })).structuredContent.status, "outcome_unknown");
    assert.match(down.error, /also not when it was sent once more with the same payment/);
    assert.match(down.error, /once at most/);
    assert.equal(paidTries("/flaky-down").length, 2);
    assert.equal((await wallet.purchases()).length, 2);

    // The same request asked again while its outcome is unknown: the agent and the owner's page are warned, nothing is
    // asked silently. Another request, or one whose payment simply failed, carries no warning.
    const askedAgain = (await call(client, "pay_x402", { url: `${s.url}/flaky-down` })).structuredContent;
    assert.equal(askedAgain.status, "waiting_for_owner");
    assert.equal(askedAgain.previous_payment_id, id4);
    assert.match(askedAgain.warning, /may have gone through without an answer: check the wallet before paying again/);
    assert.notEqual(askedAgain.payment_id, id4, "a new request gets its own id: an id is never reused for another payment");
    const page = await (await fetch(`${base}/connector/payments/${askedAgain.payment_id}`)).json();
    assert.match(page.warning, /check the wallet before paying again/);
    const lostAgain = (await call(client, "pay_x402", { url: `${s.url}/flaky-strict` })).structuredContent;
    assert.match(lostAgain.warning, /paid .* min ago .* answer got lost: paying again pays twice/);
    assert.equal((await call(client, "pay_x402", { url: `${s.url}/flaky-strict-2` })).structuredContent.warning, undefined, "nothing was paid there");
    assert.equal((await call(client, "pay_x402", { url: `${s.url}/flaky-down?other=1` })).structuredContent.warning, undefined, "another request");
    await client.close();
  } finally { server.close(); s.server.close(); }
});

test("connector payments: an escrowed offer (auth-capture) is signed to the escrow's collector, up to max_price_usd", async () => {
  const s = await seller();
  const { base, server } = await boot({ balance: 20_000_000n });
  try {
    const owner = privateKeyToAccount(generatePrivateKey());
    const client = await connect(base, await signIn(base, owner));

    // $12 is above the default $1 and the $5 for a direct payment, but an escrowed one may go up to $100 when asked.
    const low = await call(client, "pay_x402", { url: `${s.url}/escrow/example.com`, reason: "register example.com" });
    assert.equal(low.isError, true);
    assert.match(low.content[0].text, /asks \$12, above max_price_usd \(\$1\)/);
    const asked = (await call(client, "pay_x402", { url: `${s.url}/escrow/example.com`, reason: "register example.com", max_price_usd: 15 })).structuredContent;
    assert.equal(asked.status, "waiting_for_owner");
    assert.equal(asked.price_usd, 12);

    const v = await (await fetch(`${base}/connector/payments/${asked.payment_id}`)).json();
    assert.equal(v.options.base.escrow.maxFeeBps, 100);
    const t = await (await fetch(`${base}/connector/payments/${asked.payment_id}/typed`, { method: "POST" })).json();
    assert.equal(t.typedData.primaryType, "ReceiveWithAuthorization");
    assert.equal(t.typedData.message.to.toLowerCase(), COLLECTOR.toLowerCase());
    assert.equal(t.typedData.message.value, "12000000");

    const paid = await signOnPage(base, asked.payment_id, owner);
    assert.equal(paid.status, 200);
    const pv = await paid.json();
    assert.equal(pv.status, "done");
    assert.deepEqual(pv.result.settlement, { transaction: "0xauthorized", network: "eip155:8453" });
    const st = (await call(client, "payment_status", { payment_id: asked.payment_id })).structuredContent;
    assert.equal(st.status, "paid");
    assert.deepEqual(JSON.parse(st.body), { domain: "example.com", status: "registering" });
    await client.close();
  } finally { server.close(); s.server.close(); }
});
