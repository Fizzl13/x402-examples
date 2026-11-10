// A node that is briefly unavailable (gRPC UNAVAILABLE, "Received HTTP status code 502") is asked once more; other
// errors, and a second failure, are passed on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, retryTransient } from '../src/node.js';

const nap = { pauseMs: 0, sleep: async () => {} };

test('a transient node error is retried once; the second answer counts', async () => {
  let calls = 0;
  const out = await retryTransient(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('14 UNAVAILABLE: Received HTTP status code 502'), { code: 14 });
    return 'ok';
  }, nap);
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
});

test('other errors are not retried, and a second transient failure is passed on', async () => {
  let calls = 0;
  await assert.rejects(retryTransient(async () => { calls++; throw new Error('account does not exist'); }, nap), /does not exist/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryTransient(async () => { calls++; throw new Error('Received HTTP status code 503'); }, nap), /503/);
  assert.equal(calls, 2);
});

test('what counts as transient', () => {
  assert.ok(isTransient({ code: 14, message: 'x' }));
  assert.ok(isTransient(new Error('Received HTTP status code 502')));
  assert.ok(isTransient(new Error('read ECONNRESET')));
  assert.ok(!isTransient(new Error('Received HTTP status code 404')));
  assert.ok(!isTransient(new Error('insufficient funds')));
});
