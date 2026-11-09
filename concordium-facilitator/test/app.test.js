// The facilitator's HTTP routes (src/app.js) with a stand-in node: /supported names the sponsor, /verify and /settle
// take x402 v2 bodies, sellers outside the list and the daily limit are refused, and nothing is submitted twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { AccountAddress, buildBasicAccountSigner } from '@concordium/web-sdk';
import { buildPayment } from '../src/scheme.js';
import { createApp } from '../src/app.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
function account() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const address = AccountAddress.toBase58(AccountAddress.fromBuffer(randomBytes(32)));
  return { address, signer: buildBasicAccountSigner(priv), info: { accountAddress: AccountAddress.fromBase58(address), accountThreshold: 1, accountCredentials: { 0: { value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: pub } } } } } } } } };
}
const buyer = account(), seller = account(), sponsor = account(), other = account();
const quiet = { info() {}, error() {} };
function stand(overrides = {}) {
  let nonce = 1n;
  const sent = [];
  return {
    sent,
    accountInfo: async (a) => (a === buyer.address ? buyer.info : null),
    nextNonce: async () => nonce,
    balance: async () => 10n ** 9n,
    token: async () => null,
    send: async (tx) => { sent.push(tx); nonce += 1n; return `hash${sent.length}`; },
    waitFinal: async () => ({ success: true }),
    ...overrides,
  };
}
async function serve(opts) {
  const server = createApp({ network: TESTNET, sponsor: sponsor.address, sponsorSigner: sponsor.signer, log: quiet, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => (await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  return { base, call, close: () => new Promise((r) => server.close(r)) };
}
const req = (over = {}) => ({ scheme: 'exact', network: TESTNET, amount: '10000', asset: 'CCD', payTo: seller.address, maxTimeoutSeconds: 120, extra: { feePayer: sponsor.address }, ...over });
const body = async (r, nonce = 1n) => ({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: r, payload: await buildPayment({ requirements: r, sender: buyer.address, nonce, signer: buyer.signer }) }, paymentRequirements: r });

test('/supported names the network and the sponsor; /health answers', async () => {
  const s = await serve({ node: stand() });
  const sup = await s.call('/supported');
  assert.deepEqual(sup.kinds, [{ x402Version: 2, scheme: 'exact', network: TESTNET, extra: { feePayer: sponsor.address } }]);
  assert.equal((await s.call('/health')).ok, true);
  await s.close();
});

test('GET / is a page with the network, the sponsor and how to use it', async () => {
  const s = await serve({ node: stand() });
  try {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /Concordium testnet/);
    assert.ok(html.includes(sponsor.address));
    assert.ok(html.includes('&quot;feePayer&quot;'), 'the 402 example names the fee payer');
    assert.match(html, /\/settle/);
    assert.ok(html.includes(new URL(s.base).host), 'shows its own host as the facilitator URL');
    assert.equal((await s.call('/health')).settled_today, 0);
  } finally { await s.close(); }
});

test('/verify then /settle: valid, settled once, the same payment again is refused (used nonce)', async () => {
  const node = stand();
  const s = await serve({ node });
  const b = await body(req());
  assert.deepEqual(await s.call('/verify', b), { isValid: true, payer: buyer.address });
  const first = await s.call('/settle', b);
  assert.deepEqual([first.success, first.transaction, first.payer], [true, 'hash1', buyer.address]);
  const again = await s.call('/settle', b);
  assert.equal(again.success, false);
  assert.match(again.errorMessage, /nonce/);
  assert.equal(node.sent.length, 1);
  await s.close();
});

test('only listed sellers are sponsored, other networks are refused, and the daily limit holds', async () => {
  const s = await serve({ node: stand(), sellers: [seller.address], dailyLimit: 1 });
  assert.equal((await s.call('/verify', await body(req({ payTo: other.address })))).invalidReason, 'seller_not_sponsored');
  assert.equal((await s.call('/verify', await body(req({ network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' })))).invalidReason, 'invalid_network');
  assert.equal((await s.call('/settle', await body(req()))).success, true);
  assert.equal((await s.call('/settle', await body(req(), 2n))).errorReason, 'facilitator_daily_limit');
  await s.close();
});

test('a transaction that does not parse is invalid, an unknown route a 404', async () => {
  const s = await serve({ node: stand() });
  const bad = await s.call('/verify', { paymentPayload: { payload: { transaction: 'x' } }, paymentRequirements: req() });
  assert.equal(bad.isValid, false);
  assert.equal((await s.call('/nope')).error, 'not found');
  await s.close();
});

test('identity: report mode adds what Concordium says about the seller; agent mode sponsors only verified agents', async () => {
  const id = (outcome) => ({ check: async ({ payTo }) => ({ outcome, agent: { outcome: outcome === 'verified-agent' ? 'verified-wallet' : 'mismatch', reason: 'payTo is not the agent\'s registered wallet' }, payTo }) });
  const report = await serve({ node: stand(), identity: id('identity-backed'), identityMode: 'report' });
  const v = await report.call('/verify', await body(req()));
  assert.equal(v.isValid, true);
  assert.equal(v.extensions['concordium-identity'].outcome, 'identity-backed');
  await report.close();

  const node = stand();
  const strict = await serve({ node, identity: id('identity-backed'), identityMode: 'agent' });
  const refused = await strict.call('/verify', await body(req()));
  assert.deepEqual([refused.isValid, refused.invalidReason], [false, 'seller_identity_not_verified']);
  const notSettled = await strict.call('/settle', await body(req()));
  assert.deepEqual([notSettled.success, notSettled.errorReason], [false, 'seller_identity_not_verified']);
  assert.equal(node.sent.length, 0, 'nothing sponsored');
  await strict.close();

  const verified = await serve({ node: stand(), identity: id('verified-agent'), identityMode: 'agent' });
  const s = await verified.call('/settle', await body(req()));
  assert.equal(s.success, true);
  assert.equal(s.extensions['concordium-identity'].outcome, 'verified-agent');
  await verified.close();

  const off = await serve({ node: stand(), identity: id('identity-backed'), identityMode: 'off' });
  assert.equal((await off.call('/verify', await body(req()))).extensions, undefined);
  await off.close();
});

test('identity: proof mode sponsors only sellers with a verified zero-knowledge proof', async () => {
  const id = (proof) => ({ check: async () => ({ outcome: 'identity-backed', ...(proof ? { proof } : {}) }) });
  const node = stand();
  const none = await serve({ node, identity: id(null), identityMode: 'proof' });
  const refused = await none.call('/verify', await body(req()));
  assert.deepEqual([refused.isValid, refused.invalidReason], [false, 'seller_identity_not_verified']);
  assert.match(refused.invalidMessage, /concordium-proof\.json: none served/);
  const bad = await serve({ node, identity: id({ status: 'invalid', reason: 'the proof is tied to another payTo' }), identityMode: 'proof' });
  assert.match((await bad.call('/settle', await body(req()))).errorMessage, /another payTo/);
  assert.equal(node.sent.length, 0, 'nothing sponsored');
  await none.close(); await bad.close();

  const proven = await serve({ node: stand(), identity: id({ status: 'verified', facts: ['adult', 'eu-residence'] }), identityMode: 'proof' });
  const s = await proven.call('/settle', await body(req()));
  assert.equal(s.success, true);
  assert.deepEqual(s.extensions['concordium-identity'].proof.facts, ['adult', 'eu-residence']);
  await proven.close();
});

test('demo seller: its card byte for byte, a 402 with the facilitator as fee payer, then paid and settled', async () => {
  const card = Buffer.from('{"name":"demo — seller"}');
  const node = stand();
  const s = await serve({ node, demo: { payTo: seller.address, card }, identity: { check: async () => ({ outcome: 'verified-agent' }) } });
  const got = await fetch(`${s.base}/.well-known/agent-card.json`);
  assert.equal(got.headers.get('access-control-allow-origin'), '*', 'a pin page on another origin can read and hash it');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), card);
  const first = await fetch(`${s.base}/demo/paid`);
  assert.equal(first.status, 402);
  const required = JSON.parse(Buffer.from(first.headers.get('payment-required'), 'base64').toString());
  const r = required.accepts[0];
  assert.deepEqual([r.payTo, r.extra.feePayer, r.amount, r.asset], [seller.address, sponsor.address, '1000', 'CCD']);
  assert.match(required.resource.url, /\/demo\/paid$/);
  const payload = await buildPayment({ requirements: r, sender: buyer.address, nonce: 1n, signer: buyer.signer });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: r, payload })).toString('base64');
  const paid = await fetch(`${s.base}/demo/paid`, { headers: { 'payment-signature': header } });
  assert.equal(paid.status, 200);
  const answer = await paid.json();
  assert.deepEqual([answer.paid, answer.transaction, answer.identity.outcome], [true, 'hash1', 'verified-agent']);
  const receipt = JSON.parse(Buffer.from(paid.headers.get('payment-response'), 'base64').toString());
  assert.equal(receipt.success, true);
  assert.equal(node.sent.length, 1);
  const again = await fetch(`${s.base}/demo/paid`, { headers: { 'payment-signature': header } });
  assert.equal(again.status, 402, 'the same payment again: its nonce is used');
  await s.close();
});

test('buyerDailyLimit: one buyer account can not use up the daily limit for everyone', async () => {
  const node = stand();
  const s = await serve({ node, buyerDailyLimit: 1 });
  try {
    assert.equal((await s.call('/settle', await body(req()))).success, true);
    const second = await s.call('/settle', await body(req(), 2n));
    assert.equal(second.errorReason, 'buyer_daily_limit');
    assert.equal(node.sent.length, 1, 'nothing submitted for the refused payment');
  } finally { await s.close(); }
});
