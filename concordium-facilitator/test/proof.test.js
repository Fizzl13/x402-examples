// The seller's zero-knowledge proof (src/proof.js) with the real proof the demo seller serves
// (test/fixtures/seller-proof-2026-11-06.json: the proof the demo seller served at its first origin, on Render, made in
// the owner's wallet on 6 Nov 2026 with x402 Doctor's /concordium-proof.html; demo/concordium-proof.json now holds
// the one made on 14 Nov 2026 for https://ccd-facilitator.fizzl.eu, checked at the end of this file).
// A copycat serves the same file at its own site, so every check() serves it wherever it is asked for.
// The zero-knowledge verification itself needs the chain (scripts/testnet.js read checks it live); here a stand-in
// verifier answers like Concordium's verifier did for this proof, and everything around it is checked for real:
// the binding to network, site and payTo, the credential belonging to the payTo account, the facts, and the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { challengeFor, createProofCheck, factsOf, PROOF_PATH } from '../src/proof.js';
import { createIdentity } from '../src/identity.js';
import { createApp } from '../src/app.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const ORIGIN = 'https://concordium-facilitator.onrender.com';
const PAY_TO = '3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3';
const OTHER = '3acKWtGJQuFqoDgt16ghwvrcEVSQygj67fynVWaAKbmnEHaWeZ';
const RAW = readFileSync(new URL('./fixtures/seller-proof-2026-11-06.json', import.meta.url), 'utf8');
const FILE = JSON.parse(RAW);
const CRED = FILE.presentation.verifiableCredential[0].credentialSubject.id.split(':cred:')[1];
const NOW = Date.parse('2026-11-06T18:00:00Z');
// What Concordium's verifier answered for this presentation (6 Nov 2026, 200).
const VERIFIED = { challenge: FILE.challenge, credentialStatements: [{ id: FILE.presentation.verifiableCredential[0].credentialSubject.id, statement: FILE.presentation.verifiableCredential[0].credentialSubject.statement }] };
const node = (credIds = [CRED]) => ({ accountInfo: async (a) => (a === PAY_TO ? { accountCredentials: Object.fromEntries(credIds.map((c, i) => [i, { value: { contents: { credId: c } } }])) } : null) });
const check = ({ text = RAW, verify = async () => VERIFIED, credIds } = {}) => createProofCheck({ network: TESTNET, node: node(credIds), get: async (url) => { assert.ok(url.endsWith(PROOF_PATH)); if (text === null) throw new Error('HTTP 404'); return text; }, verify, now: () => NOW });

test('the challenge ties the proof to network, site and payTo', () => {
  assert.equal(challengeFor('testnet', ORIGIN, PAY_TO), FILE.challenge);
  assert.notEqual(challengeFor('testnet', 'https://copycat.example', PAY_TO), FILE.challenge);
  assert.notEqual(challengeFor('mainnet', ORIGIN, PAY_TO), FILE.challenge);
});

test('the demo seller\'s proof: verified, adult and EU resident, from the payTo account\'s own credential', async () => {
  const r = await check()(ORIGIN, PAY_TO);
  assert.deepEqual(r, { status: 'verified', facts: ['adult', 'eu-residence'], issuer: 0, credential: CRED, created: '2026-11-06T16:17:59.762Z' });
});

test('refused: another site, another payTo, a credential of another account, a failing proof, a forged file', async () => {
  assert.match((await check()('https://copycat.example', PAY_TO)).reason, /tied to/);
  assert.match((await check()(ORIGIN, OTHER)).reason, /another payTo/);
  assert.match((await check({ credIds: ['00'.repeat(48)] })(ORIGIN, PAY_TO)).reason, /not the payTo account's/);
  assert.match((await check({ verify: async () => { throw new Error('proof check failed'); } })(ORIGIN, PAY_TO)).reason, /does not verify/);
  // The file claims a fact, but the facts come only from the statements the verifier checked.
  const forged = JSON.parse(RAW); forged.proves = ['adult', 'eu-residence', 'eu-nationality'];
  assert.deepEqual((await check({ text: JSON.stringify(forged) })(ORIGIN, PAY_TO)).facts, ['adult', 'eu-residence']);
  // A presentation made for another challenge (another site), relabelled with this site.
  const moved = JSON.parse(RAW); moved.presentation.presentationContext = challengeFor('testnet', 'https://elsewhere.example', PAY_TO);
  assert.match((await check({ text: JSON.stringify(moved) })(ORIGIN, PAY_TO)).reason, /not made for this site/);
  assert.equal(await check({ text: null })(ORIGIN, PAY_TO), null, 'no proof served: nothing to report');
  assert.match((await check({ text: '<html>' })(ORIGIN, PAY_TO)).reason, /not JSON/);
});

test('facts: only what the statements establish, as of now', () => {
  const st = FILE.presentation.verifiableCredential[0].credentialSubject.statement;
  assert.deepEqual(factsOf(st, NOW), ['adult', 'eu-residence']);
  assert.deepEqual(factsOf([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20120101' }], NOW), [], 'under 18 is not adult');
  assert.deepEqual(factsOf([{ type: 'AttributeInSet', attributeTag: 'countryOfResidence', set: ['NL', 'US'] }], NOW), [], 'a set beyond the EU proves nothing about the EU');
  assert.deepEqual(factsOf([{ type: 'AttributeInSet', attributeTag: 'nationality', set: ['NL', 'DE'] }], NOW), ['eu-nationality']);
  assert.deepEqual(factsOf([{ type: 'AttributeInRange', attributeTag: 'idDocExpiresAt', lower: '20261106', upper: '99991231' }], NOW), ['id-document-valid']);
  assert.deepEqual(factsOf([{ type: 'AttributeInRange', attributeTag: 'idDocExpiresAt', lower: '20250101', upper: '99991231' }], NOW), [], 'valid back then says nothing about today');
});

test('the app: the proof in the identity answer, served for the demo, and IDENTITY=proof sponsors only proven sellers', async () => {
  const quiet = { info() {}, error() {} };
  const get = async (url) => { if (url === `${ORIGIN}${PROOF_PATH}`) return RAW; throw new Error('HTTP 404'); };
  const identity = createIdentity({ network: TESTNET, node: { ...node(), identityProviders: async function* () {} }, get, fetch: async () => { throw new Error('offline'); }, now: () => NOW, proof: createProofCheck({ network: TESTNET, node: node(), get, verify: async () => VERIFIED, now: () => NOW }) });
  const id = await identity.check({ resourceUrl: `${ORIGIN}/demo/paid`, payTo: PAY_TO });
  assert.equal(id.proof.status, 'verified');
  const other = await identity.check({ resourceUrl: 'https://plain.example/paid', payTo: PAY_TO });
  assert.equal(other.proof, undefined);

  const server = createApp({ network: TESTNET, sponsor: OTHER, sponsorSigner: null, node: {}, log: quiet, identity, identityMode: 'proof', demo: { payTo: PAY_TO, card: Buffer.from('{}'), proof: Buffer.from(RAW) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}${PROOF_PATH}`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(await res.text(), RAW, 'served byte for byte');
    const ans = await (await fetch(`${base}/identity?url=${encodeURIComponent('https://plain.example/paid')}&payTo=${PAY_TO}`)).json();
    assert.equal(ans.proof, undefined);
  } finally { await new Promise((r) => server.close(r)); }
});

test('the proof the demo seller serves now is tied to ccd-facilitator.fizzl.eu and its payTo', () => {
  const served = JSON.parse(readFileSync(new URL('../demo/concordium-proof.json', import.meta.url), 'utf8'));
  assert.equal(served.origin, 'https://ccd-facilitator.fizzl.eu');
  assert.equal(served.payTo, PAY_TO);
  assert.equal(served.challenge, challengeFor('testnet', 'https://ccd-facilitator.fizzl.eu', PAY_TO));
  assert.equal(served.presentation.presentationContext, served.challenge);
  assert.deepEqual(served.proves, ['adult', 'eu-residence']);
  // The same credential as the first proof: the payTo account's own.
  assert.equal(served.presentation.verifiableCredential[0].credentialSubject.id, FILE.presentation.verifiableCredential[0].credentialSubject.id);
});
