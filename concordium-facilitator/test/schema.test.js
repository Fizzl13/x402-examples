// The concordium-identity extension's JSON Schema (schema/concordium-identity.schema.json): what src/identity.js
// returns fits it, for every outcome; and the app serves it and names the extension in /supported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createIdentity } from '../src/identity.js';
import { createApp } from '../src/app.js';

const schema = JSON.parse(fs.readFileSync(new URL('../schema/concordium-identity.schema.json', import.meta.url), 'utf8'));

// The JSON Schema keywords the file uses: type, enum, pattern, required, properties, additionalProperties: false.
function validate(s, v, at = '$') {
  const errs = [];
  const types = [].concat(s.type ?? []);
  const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (types.length && !types.includes(kind)) return [`${at}: ${kind} is not ${types.join('|')}`];
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.join(', ')}`);
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) errs.push(`${at}: ${v} doesn't match ${s.pattern}`);
  if (kind === 'object' && s.properties) {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}.${r}: missing`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties[k]) errs.push(...validate(s.properties[k], x, `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}.${k}: not in the schema`);
    }
  }
  return errs;
}

const BADGE = 'JyP9Y8gHmf4U8QPMm1TkT'; // testnet agent #993
const MAINNET_BADGE = 'Mf22oVsbu3vf4Jb1cga49';
const WALLET = '3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3';
const OTHER = '3acKWtGJQuFqoDgt16ghwvrcEVSQygj67fynVWaAKbmnEHaWeZ';
const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const ORIGIN = 'https://seller.example';
const card = (badge = BADGE) => JSON.stringify({ url: ORIGIN, capabilities: { extensions: [{ uri: 'https://concordium.com/concordium-badge/v1', params: { tokenAddress: badge } }] } });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function identity({ served = card(), agent = {}, registryDown = false, credential = true } = {}) {
  const anchored = card();
  const record = { token_id: '993', status: 'Active', agent_wallet: WALLET, owner_account: WALLET, agent_uri: `${ORIGIN}/agent.json`, metadata_hash_hex: sha(anchored), ...agent };
  const pages = { [`${ORIGIN}/.well-known/agent-card.json`]: served, [`${ORIGIN}/agent.json`]: anchored };
  return createIdentity({
    network: TESTNET,
    node: {
      accountInfo: async () => (credential ? { accountCredentials: { 0: { value: { contents: { ipIdentity: 0, policy: { validTo: '202711', revealedAttributes: {} } } } } } } : null),
      identityProviders: async function* () { yield { ipIdentity: 0, ipDescription: { name: 'Concordium testnet IP' } }; },
    },
    get: async (u) => { if (!pages[u]) throw new Error('HTTP 404'); return pages[u]; },
    fetch: async () => {
      if (registryDown) throw new Error('down');
      return { ok: true, text: async () => JSON.stringify({ result: { content: [{ text: JSON.stringify(record) }] } }) };
    },
    now: () => Date.parse('2026-11-06T12:00:00Z'),
  });
}

test('every outcome src/identity.js gives fits the schema', async () => {
  const cases = [
    [identity(), WALLET, 'verified-agent', 'verified-wallet'],
    [identity(), OTHER, 'identity-backed', 'mismatch'],
    [identity({ agent: { agent_wallet: null } }), WALLET, 'identity-backed', 'owner-only'],
    [identity({ agent: { status: 'Revoked' } }), WALLET, 'identity-backed', 'revoked'],
    [identity({ agent: { metadata_hash_hex: '00'.repeat(32) } }), WALLET, 'identity-backed', 'card-mismatch'],
    [identity({ served: card(MAINNET_BADGE) }), WALLET, 'identity-backed', 'other-network'],
    [identity({ registryDown: true }), WALLET, 'identity-backed', 'not-read'],
    [identity({ served: null }), WALLET, 'identity-backed', undefined],
    [identity({ served: null, credential: false }), WALLET, 'not-read', undefined],
  ];
  for (const [id, payTo, outcome, agentOutcome] of cases) {
    const r = await id.check({ resourceUrl: `${ORIGIN}/paid`, payTo });
    assert.deepEqual([r.outcome, r.agent?.outcome], [outcome, agentOutcome]);
    assert.deepEqual(validate(schema, r), [], JSON.stringify(r));
  }
  for (const ex of schema.examples) assert.deepEqual(validate(schema, ex), []);
  assert.notDeepEqual(validate(schema, { outcome: 'trusted' }), [], 'an unknown outcome is refused');
});

test('the app serves the schema to any page and names the extension in /supported', async () => {
  const quiet = { info() {}, error() {} };
  const opts = { network: TESTNET, sponsor: WALLET, sponsorSigner: null, node: {}, log: quiet };
  for (const [identityMode, expected] of [['report', ['concordium-identity']], ['off', []]]) {
    const server = createApp({ ...opts, identity: identity(), identityMode });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.deepEqual((await (await fetch(`${base}/supported`)).json()).extensions, expected);
      const res = await fetch(`${base}/schema/concordium-identity.json`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal((await res.json()).title, 'concordium-identity');
    } finally { await new Promise((r) => server.close(r)); }
  }
});
