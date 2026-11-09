// An agent's statement (src/history.js createStatement, GET /statement): what one paying account sent through this
// facilitator, read from that account's own history on the wallet proxy (the shapes below are as the testnet wallet
// proxy listed them for buyer 3acK… on 6 Nov 2026), with totals and who each payee is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatement } from '../src/history.js';
import { createApp } from '../src/app.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '4nkWEqH5534jL4LkSQAuL6zZdZugaU171DXqVvWB7uHbecuYS6';
const BUYER = '3acKWtGJQuFqoDgt16ghwvrcEVSQygj67fynVWaAKbmnEHaWeZ';
const SELLER = '3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3';
const OTHER = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';

const sent = (hash, to, amount, time, { sponsor = SPONSOR, outcome = 'success', cost = '5013808' } = {}) => ({
  blockTime: time, cost: '0', origin: { type: 'self' }, transactionHash: hash, subtotal: `-${amount}`, total: `-${amount}`,
  ...(sponsor ? { sponsor: { cost, sponsor } } : {}),
  details: { description: 'Transfer', outcome, type: 'transfer', transferAmount: amount, transferSource: BUYER, transferDestination: to, events: [] },
});
const HISTORY = [
  sent('9792249d', SELLER, '1000', 1793999043.957),
  sent('23948f54', SELLER, '1000', 1793999033.957),
  sent('aa01', OTHER, '250000', 1793990000.957),
  sent('bb02', OTHER, '1000', 1793980000.957, { outcome: 'reject' }),
  sent('cc03', OTHER, '5000000', 1793970000.957, { sponsor: null }), // paid its own fee: not through this facilitator
  { ...sent('dd04', BUYER, '20000000000', 1793960000.957, { sponsor: null }), origin: { type: 'account', address: '3v1J' }, details: { type: 'transfer', outcome: 'success', transferAmount: '20000000000', transferSource: '3v1J', transferDestination: BUYER } }, // faucet in
];
const identity = { check: async ({ payTo }) => (payTo === SELLER ? { outcome: 'identity-backed', credential: { provider: 'Concordium testnet IP', validTo: '2027-11', expired: false } } : { outcome: 'expired', credential: { provider: 'Notabene (Testnet)', validTo: '2025-01', expired: true } }) };

function proxy(calls = []) {
  return async (url) => {
    calls.push(url);
    assert.match(url, new RegExp(`^https://wallet-proxy\\.testnet\\.concordium\\.com/v0/accTransactions/${BUYER}\\?limit=100&order=descending$`));
    return { ok: true, json: async () => ({ transactions: HISTORY }) };
  };
}

test('the statement: only what this account sent through this facilitator, totals, payees with who they are', async () => {
  const calls = [];
  const statementOf = createStatement({ network: TESTNET, sponsor: SPONSOR, fetch: proxy(calls), identity });
  const s = await statementOf(BUYER);
  assert.deepEqual(s.payments.map((p) => [p.tx, p.to, p.amount, p.ok]), [['9792249d', SELLER, '0.001', true], ['23948f54', SELLER, '0.001', true], ['aa01', OTHER, '0.25', true], ['bb02', OTHER, '0.001', false]]);
  assert.equal(s.payments[0].time, '2026-11-06T21:04:03.957Z');
  assert.equal(s.payments[0].sponsor_fee_ccd, '5.013808');
  assert.deepEqual(s.totals, [{ asset: 'CCD', amount: '0.252', count: 3 }], 'a rejected transfer moved nothing');
  assert.deepEqual(s.payees, [
    { account: SELLER, payments: 2, identity: 'identity-backed', provider: 'Concordium testnet IP', validTo: '2027-11', expired: false },
    { account: OTHER, payments: 1, identity: 'expired', provider: 'Notabene (Testnet)', validTo: '2025-01', expired: true },
  ]);
  assert.equal(s.partial, false);
  await statementOf(BUYER);
  assert.equal(calls.length, 1, 'cached');
});

test('GET /statement: the JSON for an account, 400 without one, 503 when the chain history cannot be read', async () => {
  const quiet = { info() {}, error() {} };
  let up = true;
  const statement = createStatement({ network: TESTNET, sponsor: SPONSOR, fetch: async (u) => (up ? proxy()(u) : { ok: false, status: 502 }), identity, ttlMs: 0 });
  const server = createApp({ network: TESTNET, sponsor: SPONSOR, sponsorSigner: null, node: {}, log: quiet, statement, demo: { payTo: SELLER, card: Buffer.from('{}') } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/statement?account=${BUYER}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal((await res.json()).totals[0].amount, '0.252');
    assert.equal((await fetch(`${base}/statement?account=nope`)).status, 400);
    up = false;
    assert.equal((await fetch(`${base}/statement?account=${BUYER}`)).status, 503);
    assert.match(await (await fetch(`${base}/`)).text(), /What did my agent pay\?[\s\S]*statement\?account=3acK/);
  } finally { await new Promise((r) => server.close(r)); }
});
