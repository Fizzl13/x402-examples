// Who is being paid (src/identity.js): the payTo account's identity credential, and the seller's agent in Concordium's
// Agent Registry when its endpoint shows a badge; and how the app reports or requires it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { badgeNetwork, cardBadge, createIdentity, createSafeGet, credentialOf } from '../src/identity.js';

const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const BADGE = 'Mf22oVsbu3vf4Jb1cga49'; // x402 Doctor's agent #5120 in the mainnet registry
const WALLET = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const OTHER = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';
const ORIGIN = 'https://seller.example';
const AGENT_URI = `${ORIGIN}/agent.json`;
const NOW = Date.parse('2026-11-06T12:00:00Z');

const card = (origin = ORIGIN) => ({ name: 'seller', url: origin, capabilities: { extensions: [{ uri: 'https://concordium.com/concordium-badge/v1', params: { tokenAddress: BADGE } }] } });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function world({ served = card(), anchored = card(), agent = {}, credential = { ipIdentity: 0, policy: { validTo: '202711', createdAt: '202611', revealedAttributes: {} } } } = {}) {
  const anchoredText = JSON.stringify(anchored);
  const record = { token_id: '5120', status: 'Active', agent_wallet: WALLET, owner_account: WALLET, agent_uri: AGENT_URI, metadata_hash_hex: sha(anchoredText), ...agent };
  const pages = { [`${ORIGIN}/.well-known/agent-card.json`]: served === null ? null : JSON.stringify(served), [AGENT_URI]: anchoredText };
  const calls = [];
  const get = async (url) => { calls.push(url); if (!pages[url]) throw new Error('HTTP 404'); return pages[url]; };
  const fetch = async (url, init) => {
    const { params } = JSON.parse(init.body);
    calls.push(params.name);
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(params.arguments.token_address === BADGE ? record : null) }] } }) };
  };
  const node = {
    accountInfo: async () => (credential ? { accountCredentials: { 0: { v: 0, value: { type: 'normal', contents: credential } } } } : null),
    identityProviders: async function* () { yield { ipIdentity: 0, ipDescription: { name: 'Concordium testnet IP' } }; },
  };
  return { identity: createIdentity({ network: MAINNET, node, fetch, get, now: () => NOW }), calls };
}

test('badges: read from the card, and tied to the official registry they belong to', () => {
  assert.equal(cardBadge(card()), BADGE);
  assert.equal(cardBadge({ concordium: { tokenAddress: `${MAINNET}/cis-2:${BADGE}` } }), BADGE);
  assert.equal(cardBadge({ name: 'no badge' }), null);
  assert.equal(badgeNetwork(BADGE), 'mainnet');
  assert.equal(badgeNetwork('not-a-badge'), null);
});

test('the seller paid at its registered agent wallet is verified-agent, with its credential', async () => {
  const { identity } = world();
  const r = await identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: WALLET });
  assert.equal(r.outcome, 'verified-agent');
  assert.deepEqual([r.agent.outcome, r.agent.tokenId, r.agent.status], ['verified-wallet', '5120', 'Active']);
  assert.deepEqual(r.credential, { provider: 'Concordium testnet IP', validTo: '2027-11', expired: false, revealed: null });
});

test('not verified: another payTo, a revoked agent, a changed card, an endpoint the card does not list', async () => {
  const other = await world().identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: OTHER });
  assert.deepEqual([other.outcome, other.agent.outcome], ['identity-backed', 'mismatch']);
  const revoked = await world({ agent: { status: 'Revoked' } }).identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: WALLET });
  assert.equal(revoked.agent.outcome, 'revoked');
  const w = world();
  w.identity = createIdentity({ network: MAINNET, node: { accountInfo: async () => null, identityProviders: async function* () {} }, fetch: async (u, init) => ({ ok: true, text: async () => JSON.stringify({ result: { content: [{ text: JSON.stringify({ status: 'Active', agent_wallet: WALLET, agent_uri: AGENT_URI, metadata_hash_hex: '00'.repeat(32) }) }] } }) }), get: async (u) => JSON.stringify(card()), now: () => NOW });
  assert.equal((await w.identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: WALLET })).agent.outcome, 'card-mismatch');
  // The anchored card lives elsewhere and doesn't list this origin: a copied badge proves nothing here.
  const pages = { [`${ORIGIN}/.well-known/agent-card.json`]: JSON.stringify(card()), 'https://elsewhere.example/agent.json': JSON.stringify(card('https://elsewhere.example')) };
  const id = createIdentity({ network: MAINNET, node: { accountInfo: async () => null, identityProviders: async function* () {} }, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ result: { content: [{ text: JSON.stringify({ status: 'Active', agent_wallet: WALLET, agent_uri: 'https://elsewhere.example/agent.json', metadata_hash_hex: sha(pages['https://elsewhere.example/agent.json']) }) }] } }) }), get: async (u) => pages[u], now: () => NOW });
  assert.equal((await id.check({ resourceUrl: `${ORIGIN}/paid`, payTo: WALLET })).agent.outcome, 'endpoint-unlisted');
});

test('no badge: identity-backed from the credential alone; an expired credential says so; nothing read is not-read', async () => {
  const plain = await world({ served: null }).identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: OTHER });
  assert.deepEqual([plain.outcome, plain.agent], ['identity-backed', undefined]);
  const old = await world({ served: null, credential: { ipIdentity: 0, policy: { validTo: '202610', createdAt: '202510', revealedAttributes: { countryOfResidence: 'DK' } } } }).identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: OTHER });
  assert.equal(old.outcome, 'expired');
  assert.deepEqual(old.credential.revealed, { countryOfResidence: 'DK' });
  const none = await world({ served: null, credential: null }).identity.check({ resourceUrl: `${ORIGIN}/paid`, payTo: OTHER });
  assert.equal(none.outcome, 'not-read');
  assert.equal(credentialOf({ accountCredentials: { 0: { value: { contents: { ipIdentity: 1, policy: { validTo: '202611' } } } } } }, new Map(), NOW).expired, false, 'valid through its last month');
});

test('results are cached per origin and payTo', async () => {
  const { identity, calls } = world();
  await identity.check({ resourceUrl: `${ORIGIN}/a`, payTo: WALLET });
  const n = calls.length;
  await identity.check({ resourceUrl: `${ORIGIN}/b`, payTo: WALLET });
  assert.equal(calls.length, n);
});

test('the careful GET: https only, public hosts only, no redirects followed', async () => {
  const get = createSafeGet({ fetch: async (u, init) => { assert.equal(init.redirect, 'manual'); return { status: 200, text: async () => '{}' }; }, lookup: async (h) => [{ address: h === 'inside.example' ? '10.0.0.5' : '93.184.216.34' }] });
  assert.equal(await get('https://public.example/x'), '{}');
  await assert.rejects(get('http://public.example/x'), /https/);
  await assert.rejects(get('https://inside.example/x'), /public host/);
  await assert.rejects(get('https://127.0.0.1/x'), /public host/);
  const redirected = createSafeGet({ fetch: async () => ({ status: 302, text: async () => '' }), lookup: async () => [{ address: '93.184.216.34' }] });
  await assert.rejects(redirected('https://public.example/x'), /302/);
});
