// No network: a fake fetch stands in for x402 Doctor and presign-guard, a fake board records the replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPayment, replyText } from '../lib/check.mjs';
import { paymentWatcher, paymentRequestOf } from '../lib/watcher.mjs';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const [status, body] = key ? routes[key] : [404, { error: 'not found' }];
    return { status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const fakeBoard = () => {
  const replies = [];
  return { replies, reply: async (id, input) => { replies.push({ id, ...input }); return { id: `r-${replies.length}` }; } };
};

test('an endpoint that passes and has a clean record is go', async () => {
  const fetchImpl = fakeFetch({ '/api/diagnose': [200, { overall: 'pass', checks: [] }], '/api/trust?': [200, { last_scan: { verdict: 'go', codes: [] }, payable_ratio: 1, days_checked: 30, history: 'ggg' }] });
  const r = await checkPayment({ url: 'https://seller.example/api' }, { fetchImpl });
  assert.equal(r.verdict, 'go');
  assert.deepEqual(r.reasons, []);
  assert.equal(fetchImpl.calls[0].body.url, 'https://seller.example/api');
  assert.equal(fetchImpl.calls[0].body.method, 'GET');
});

test("a live pass with today's scan no_go is no_go, with the codes", async () => {
  const fetchImpl = fakeFetch({ '/api/diagnose': [200, { overall: 'pass', checks: [] }], '/api/trust?': [200, { last_scan: { verdict: 'no_go', codes: ['price_mismatch'] }, payable_ratio: 1, days_checked: 30 }] });
  const r = await checkPayment({ url: 'https://seller.example/api' }, { fetchImpl });
  assert.equal(r.verdict, 'no_go');
  assert.match(r.reasons.join(' '), /price_mismatch/);
});

test('a live fail is no_go; a rarely payable endpoint is at least caution', async () => {
  let r = await checkPayment({ url: 'https://a.example/x' }, { fetchImpl: fakeFetch({ '/api/diagnose': [200, { overall: 'fail', checks: [{ id: 'no-402', status: 'fail' }] }] }) });
  assert.equal(r.verdict, 'no_go');
  assert.match(r.reasons[0], /fail: no-402/);
  r = await checkPayment({ url: 'https://a.example/x' }, { fetchImpl: fakeFetch({ '/api/diagnose': [200, { overall: 'pass', checks: [] }], '/api/trust?': [200, { payable_ratio: 0.5, days_checked: 20 }] }) });
  assert.equal(r.verdict, 'caution');
});

test('Doctor down is caution, never go', async () => {
  const r = await checkPayment({ url: 'https://a.example/x' }, { fetchImpl: fakeFetch({ '/api/diagnose': [503, null] }) });
  assert.equal(r.verdict, 'caution');
});

test('a signature goes to presign-guard quick check', async () => {
  const sign = { type: 'approval', chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x1111111111111111111111111111111111111111', amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935' };
  const fetchImpl = fakeFetch({ '/v1/check/quick': [200, { verdict: 'red' }] });
  const r = await checkPayment({ sign }, { fetchImpl });
  assert.equal(r.verdict, 'no_go');
  assert.equal(r.service, 'presign-guard');
  assert.deepEqual(fetchImpl.calls[0].body, sign);
});

test('the watcher replies once on a root with a payment-request block, with a check label', async () => {
  const fetchImpl = fakeFetch({ '/api/diagnose': [200, { overall: 'warn', checks: [{ id: 'accepts[0]-asset', status: 'warn' }] }], '/api/trust?': [404, { error: 'not in the trust index yet' }] });
  const w = paymentWatcher({ fetchImpl });
  assert.equal(w.tail, 'payments');
  const board = fakeBoard();
  const message = { id: 'm1', re: null, text: 'paying', blocks: [{ schema: 'payment-request', version: 1, data: { url: 'https://seller.example/api', note: 'weather' } }] };
  await w.run({ event: { type: 'message.posted', message }, board });
  assert.equal(board.replies.length, 1);
  assert.equal(board.replies[0].id, 'm1');
  assert.deepEqual(board.replies[0].labels, { check: 'caution' });
  assert.match(board.replies[0].text, /caution/);
  // replies, other event types and messages without the block are left alone
  await w.run({ event: { type: 'message.posted', message: { ...message, id: 'm2', re: 'm1' } }, board });
  await w.run({ event: { type: 'labels.changed', message }, board });
  await w.run({ event: { type: 'message.posted', message: { id: 'm3', re: null, text: 'hello', blocks: [] } }, board });
  assert.equal(board.replies.length, 1);
});

test('paymentRequestOf reads name or name@version; replyText warns on no_go', () => {
  assert.deepEqual(paymentRequestOf({ blocks: [{ schema: 'payment-request@1', data: { url: 'u' } }] }), { url: 'u' });
  assert.equal(paymentRequestOf({ blocks: [{ schema: 'other', data: {} }] }), null);
  const t = replyText({ url: 'https://x.example/a' }, { verdict: 'no_go', service: 'x402-doctor', reasons: ['fail: no-402'] });
  assert.match(t, /Do not pay/);
  assert.ok(t.length < 10000);
});
