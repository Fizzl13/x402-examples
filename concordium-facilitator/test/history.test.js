// The page's payment history (src/history.js): sponsored transfers read from the wallet proxy's account history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, sponsoredPayment } from '../src/history.js';
import { page } from '../src/page.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '4nkWEqH5534jL4LkSQAuL6zZdZugaU171DXqVvWB7uHbecuYS6';
const BUYER = '3acKWtGJQuFqoDgt16ghwvrcEVSQygj67fynVWaAKbmnEHaWeZ';
const SELLER = '3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3';
// The first sponsored payment, as the testnet wallet proxy listed it on the sponsor's account (6 Nov 2026).
const FIRST = {
  blockTime: 1793968733.957, cost: '4430978', transactionHash: '1b2edc98d09914df0df49a96ff3371cdd6edbdf4c9390ce5d9e522b093254c98',
  details: { description: 'Transfer', events: [`Transferred 0.001000 CCD from ${BUYER} to ${SELLER}`], outcome: 'success', transferAmount: '1000', transferDestination: SELLER, transferSource: BUYER, type: 'transfer' },
  origin: { address: BUYER, type: 'account' }, sponsor: { cost: '4430978', sponsor: SPONSOR }, total: '-4430978',
};
const FAUCET = { blockTime: 1793967665.957, transactionHash: 'b4', details: { type: 'transfer', outcome: 'success', transferAmount: '20000000000', transferSource: '3v1J', transferDestination: SPONSOR }, origin: { address: '3v1J', type: 'account' } };
const TOKEN = { ...FIRST, transactionHash: 'c5', details: { description: 'Token update', outcome: 'success', type: 'tokenUpdate', events: [`Transferred 0.01 EURR from ${BUYER} to ${SELLER}`] }, sponsor: { cost: '5000000', sponsor: SPONSOR } };

test('a sponsored CCD transfer reads as a payment; a plain transfer to the sponsor does not', () => {
  assert.deepEqual(sponsoredPayment(FIRST, SPONSOR), { tx: FIRST.transactionHash, time: '2026-11-06T12:38:53.957Z', ok: true, from: BUYER, to: SELLER, asset: 'CCD', amount: '0.001', fee_ccd: '4.430978' });
  assert.equal(sponsoredPayment(FAUCET, SPONSOR), null);
  assert.equal(sponsoredPayment(FIRST, 'someone-else'), null);
  const plt = sponsoredPayment(TOKEN, SPONSOR);
  assert.deepEqual([plt.asset, plt.amount, plt.to, plt.fee_ccd], ['EURR', '0.01', SELLER, '5']);
});

test('history: counts, today, fees, cached, and the last answer kept when the proxy fails', async () => {
  let calls = 0, fail = false;
  const fetch = async (url) => {
    calls += 1;
    assert.match(url, new RegExp(`/v0/accTransactions/${SPONSOR}\\?limit=100&order=descending$`));
    if (fail) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ transactions: [TOKEN, FIRST, FAUCET] }) };
  };
  let t = Date.parse('2026-11-06T15:00:00Z');
  const h = createHistory({ network: TESTNET, sponsor: SPONSOR, fetch, now: () => t, ttlMs: 60_000 });
  const a = await h.get();
  assert.deepEqual([a.sponsored, a.sponsored_today, a.fees_ccd, a.recent.length, a.partial], [2, 2, '9.430978', 2, false]);
  await h.get();
  assert.equal(calls, 1, 'cached');
  t += 120_000; fail = true;
  assert.equal((await h.get()).sponsored, 2, 'last answer kept');
  t = Date.parse('2026-11-07T09:00:00Z'); fail = false;
  assert.equal((await h.get()).sponsored_today, 0, 'a new day');
});

test('the page lists the latest payments with links, and shows a dash without history', () => {
  const recent = [sponsoredPayment(FIRST, SPONSOR)];
  const html = page({ network: TESTNET, sponsor: SPONSOR, history: { sponsored: 1, sponsored_today: 1, fees_ccd: '4.430978', recent, partial: false } });
  assert.match(html, /Latest payments/);
  assert.ok(html.includes(`dhash=${FIRST.transactionHash}`));
  assert.match(html, /0\.001 CCD/);
  assert.doesNotMatch(page({ network: TESTNET, sponsor: SPONSOR }), /Latest payments/);
});
