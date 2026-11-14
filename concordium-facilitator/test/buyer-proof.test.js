// The buyer's zero-knowledge proof (src/proof.js createBuyerProofCheck): a seller asks, in extra.buyerProof, which facts
// the person behind the paying account must prove; the agent sends its owner's proof with the payment, and the
// facilitator checks it before it sponsors anything.
// The presentation is the real one from the demo seller's proof (made in its owner's wallet on 6 Nov 2026), relabelled
// with a buyer challenge: the stand-in verifier echoes it like Concordium's verifier does, so the zero-knowledge
// verification itself is not what these tests check (scripts/testnet.js does that live); everything around it is: the
// binding to network and paying account, the credential belonging to that account, the facts asked, and the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AccountAddress, buildBasicAccountSigner } from '@concordium/web-sdk';
import { BUYER_PROOF_EXTENSION, buyerChallengeFor, challengeFor, createBuyerProofCheck, requiredBuyerFacts } from '../src/proof.js';
import { buildPayment } from '../src/scheme.js';
import { createApp } from '../src/app.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SELLER_FILE = JSON.parse(readFileSync(new URL('./fixtures/seller-proof-2026-11-06.json', import.meta.url), 'utf8'));
const SUBJECT = SELLER_FILE.presentation.verifiableCredential[0].credentialSubject;
const CRED = SUBJECT.id.split(':cred:')[1];
const NOW = Date.parse('2026-11-06T18:00:00Z');

function account(credId = null) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const address = AccountAddress.toBase58(AccountAddress.fromBuffer(randomBytes(32)));
  const contents = { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: pub } } }, ...(credId ? { credId } : {}) };
  return { address, signer: buildBasicAccountSigner(priv), info: { accountAddress: AccountAddress.fromBase58(address), accountThreshold: 1, accountCredentials: { 0: { value: { contents } } } } };
}
const buyer = account(CRED), stranger = account('00'.repeat(48)), seller = account(), sponsor = account();

// The buyer's proof file, as x402 Doctor's page makes it (role=buyer).
function fileFor(acct, over = {}) {
  const presentation = JSON.parse(JSON.stringify(SELLER_FILE.presentation));
  presentation.presentationContext = buyerChallengeFor('testnet', acct);
  return { type: 'concordium-x402-buyer-proof', version: 1, network: 'testnet', account: acct, proves: ['adult', 'eu-residence'], challenge: presentation.presentationContext, created: '2026-11-06T20:00:00.000Z', presentation, ...over };
}
const echo = (calls = []) => async (vp) => { calls.push(vp); return { challenge: vp.presentationContext, credentialStatements: [{ id: SUBJECT.id, statement: SUBJECT.statement }] }; };
const infoOf = { [buyer.address]: buyer.info, [stranger.address]: stranger.info };
const node = (over = {}) => ({ accountInfo: async (a) => infoOf[a] ?? null, ...over });

test('the buyer challenge ties a proof to one network and one paying account, apart from the seller one', () => {
  assert.equal(buyerChallengeFor('testnet', buyer.address), fileFor(buyer.address).challenge);
  assert.notEqual(buyerChallengeFor('testnet', stranger.address), buyerChallengeFor('testnet', buyer.address));
  assert.notEqual(buyerChallengeFor('mainnet', buyer.address), buyerChallengeFor('testnet', buyer.address));
  assert.notEqual(buyerChallengeFor('testnet', buyer.address), challengeFor('testnet', 'https://x.example', buyer.address));
});

test('what a seller asks: extra.buyerProof as a list (or { facts }) of known facts', () => {
  assert.deepEqual(requiredBuyerFacts({ extra: {} }), []);
  assert.deepEqual(requiredBuyerFacts({ extra: { buyerProof: ['eu-residence', 'adult', 'adult'] } }), ['adult', 'eu-residence']);
  assert.deepEqual(requiredBuyerFacts({ extra: { buyerProof: { facts: ['adult'] } } }), ['adult']);
  assert.equal(requiredBuyerFacts({ extra: { buyerProof: ['rich'] } }), null);
  assert.equal(requiredBuyerFacts({ extra: { buyerProof: [] } }), null);
});

test('verified: the paying account\'s own proof showing what is asked, checked against the chain once', async () => {
  const calls = [];
  const check = createBuyerProofCheck({ network: TESTNET, node: node(), verify: echo(calls), now: () => NOW });
  const r = await check(fileFor(buyer.address), buyer.address, ['adult']);
  assert.deepEqual(r, { status: 'verified', account: buyer.address, facts: ['adult', 'eu-residence'], issuer: 0, credential: CRED, created: '2026-11-06T16:17:59.762Z', required: ['adult'] });
  await check(fileFor(buyer.address), buyer.address, ['adult', 'eu-residence']);
  assert.equal(calls.length, 1, 'the same file from the same account is verified once');
});

test('refused: no proof, another account\'s proof, a credential of another account, a fact not shown, a failing proof', async () => {
  const check = createBuyerProofCheck({ network: TESTNET, node: node(), verify: echo(), now: () => NOW });
  assert.equal((await check(null, buyer.address, ['adult'])).status, 'missing');
  // A buyer copies someone else's proof: it is tied to that account, not to the one paying.
  assert.match((await check(fileFor(buyer.address), stranger.address, ['adult'])).reason, /another account than the one paying/);
  // Relabelled for the stranger, it still comes from the buyer's credential, which isn't the stranger's.
  assert.match((await check(fileFor(stranger.address), stranger.address, ['adult'])).reason, /not the paying account's/);
  // Made for another challenge (a seller proof) and passed off as a buyer proof.
  assert.match((await check({ ...fileFor(buyer.address), presentation: SELLER_FILE.presentation }, buyer.address, ['adult'])).reason, /not made for this paying account/);
  const notNational = await check(fileFor(buyer.address), buyer.address, ['eu-nationality']);
  assert.equal(notNational.status, 'invalid');
  assert.match(notNational.reason, /does not show eu-nationality/);
  const failing = createBuyerProofCheck({ network: TESTNET, node: node(), verify: async () => { throw new Error('proof check failed'); }, now: () => NOW });
  assert.match((await failing(fileFor(buyer.address), buyer.address, ['adult'])).reason, /does not verify/);
  assert.match((await check({ ...fileFor(buyer.address), network: 'mainnet' }, buyer.address, ['adult'])).reason, /for mainnet/);
  assert.match((await check({ type: 'concordium-x402-seller-proof', version: 1 }, buyer.address, ['adult'])).reason, /not a concordium-x402-buyer-proof/);
});

// The app, with a stand-in node that accepts the buyer's signed transfer.
function stand() {
  let nonce = 1n;
  const sent = [];
  return { sent, accountInfo: async (a) => infoOf[a] ?? null, nextNonce: async () => nonce, balance: async () => 10n ** 9n, token: async () => null, send: async (tx) => { sent.push(tx); nonce += 1n; return `hash${sent.length}`; }, waitFinal: async () => ({ success: true }) };
}
async function serve(n) {
  const quiet = { info() {}, error() {} };
  const buyerProof = createBuyerProofCheck({ network: TESTNET, node: n, verify: echo(), now: () => NOW });
  const server = createApp({ network: TESTNET, sponsor: sponsor.address, sponsorSigner: sponsor.signer, node: n, log: quiet, buyerProof, demo: { payTo: seller.address, card: Buffer.from('{}') } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { base, post, close: () => new Promise((r) => server.close(r)) };
}
const adultsOnly = { scheme: 'exact', network: TESTNET, amount: '1000', asset: 'CCD', payTo: seller.address, maxTimeoutSeconds: 120, extra: { feePayer: sponsor.address, buyerProof: ['adult'] } };
const bodyFor = async (r, ext, nonce = 1n) => ({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: r, payload: await buildPayment({ requirements: r, sender: buyer.address, nonce, signer: buyer.signer }), ...(ext ? { extensions: { [BUYER_PROOF_EXTENSION]: ext } } : {}) }, paymentRequirements: r });

test('the app: /supported lists the extension; /verify and /settle sponsor only buyers who prove what the seller asks', async () => {
  const n = stand();
  const s = await serve(n);
  try {
    assert.ok((await (await fetch(`${s.base}/supported`)).json()).extensions.includes(BUYER_PROOF_EXTENSION));
    const without = await s.post('/verify', await bodyFor(adultsOnly));
    assert.deepEqual([without.isValid, without.invalidReason], [false, 'buyer_proof_required']);
    assert.match(without.invalidMessage, /sells only to buyers who prove adult/);
    const notShown = await s.post('/verify', await bodyFor({ ...adultsOnly, extra: { ...adultsOnly.extra, buyerProof: ['eu-nationality'] } }, fileFor(buyer.address)));
    assert.equal(notShown.invalidReason, 'buyer_proof_invalid');
    const ok = await s.post('/verify', await bodyFor(adultsOnly, fileFor(buyer.address)));
    assert.equal(ok.isValid, true);
    assert.deepEqual(ok.extensions[BUYER_PROOF_EXTENSION].facts, ['adult', 'eu-residence']);
    const refused = await s.post('/settle', await bodyFor(adultsOnly));
    assert.deepEqual([refused.success, refused.errorReason, n.sent.length], [false, 'buyer_proof_required', 0], 'nothing signed or sent without the proof');
    const settled = await s.post('/settle', await bodyFor(adultsOnly, fileFor(buyer.address)));
    assert.deepEqual([settled.success, settled.transaction, settled.extensions[BUYER_PROOF_EXTENSION].status], [true, 'hash1', 'verified']);
    // A seller that asks nothing: no proof needed, none reported.
    const plain = { ...adultsOnly, extra: { feePayer: sponsor.address } };
    const v = await s.post('/verify', await bodyFor(plain, null, 2n));
    assert.deepEqual([v.isValid, v.extensions], [true, undefined]);
  } finally { await s.close(); }
});

test('the demo: /demo/adult asks for an adult buyer in its 402, refuses without the proof, sells with it', async () => {
  const n = stand();
  const s = await serve(n);
  try {
    const first = await fetch(`${s.base}/demo/adult`);
    assert.equal(first.status, 402);
    const required = JSON.parse(Buffer.from(first.headers.get('payment-required'), 'base64').toString('utf8'));
    const req = required.accepts[0];
    assert.deepEqual(req.extra.buyerProof, ['adult']);
    assert.match(required.extensions[BUYER_PROOF_EXTENSION].info.make, /role=buyer/);
    const pay = async (ext) => {
      const payload = await buildPayment({ requirements: req, sender: buyer.address, nonce: 1n, signer: buyer.signer });
      const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: req, payload, ...(ext ? { extensions: { [BUYER_PROOF_EXTENSION]: ext } } : {}) })).toString('base64');
      return fetch(`${s.base}/demo/adult`, { headers: { 'payment-signature': header } });
    };
    const no = await pay(null);
    assert.equal(no.status, 402);
    assert.match((await no.json()).error, /^buyer_proof_required/);
    assert.equal(n.sent.length, 0);
    const yes = await pay(fileFor(buyer.address));
    assert.equal(yes.status, 200);
    const body = await yes.json();
    assert.deepEqual([body.paid, body.buyer.status, body.buyer.facts], [true, 'verified', ['adult', 'eu-residence']]);
    assert.match(await (await fetch(`${s.base}/`)).text(), /Who pays: the buyer's proof[\s\S]*\/demo\/adult/, 'the page explains it and links the demo');
    // /demo/paid still sells to anyone.
    assert.equal((await fetch(`${s.base}/demo/paid`)).status, 402);
    assert.equal(JSON.parse(Buffer.from((await fetch(`${s.base}/demo/paid`)).headers.get('payment-required'), 'base64').toString('utf8')).accepts[0].extra.buyerProof, undefined);
  } finally { await s.close(); }
});
