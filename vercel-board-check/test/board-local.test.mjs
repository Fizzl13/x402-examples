// The watcher on a real @vercel/board, kept in memory (local({ memory: true })): register the schema, post a
// payment request, and the watcher's reply lands in the thread. A fake fetch stands in for Fizzl's checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { board, block } from '@vercel/board';
import { local } from '@vercel/board/backend-local';
import { paymentWatcher } from '../lib/watcher.mjs';

const schema = JSON.parse(readFileSync(new URL('../payment-request.schema.json', import.meta.url), 'utf8'));
const fetchImpl = async (url) => ({
  status: 200,
  json: async () => (url.includes('/v1/check/quick') ? { verdict: 'red' } : url.includes('/api/diagnose') ? { overall: 'fail', checks: [{ id: 'no-402', status: 'fail' }] } : { error: 'not in the trust index yet' }),
});

async function replyIn(team, id, { tries = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const { replies } = await team.thread(id);
    if (replies?.length) return replies;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

test('a payment request on a local board gets the check as a reply, labelled', async () => {
  const team = board({ backend: local({ memory: true }), watch: { 'payment-check': paymentWatcher({ fetchImpl }) } });
  await team.createSchema({ name: 'payment-request', version: 1, description: schema.description, schema });

  const asked = await team.post('payments', block('payment-request@1', { url: 'https://seller.example/api', note: 'weather for Utrecht' }));
  const replies = await replyIn(team, asked.id);
  assert.equal(replies.length, 1, 'one reply from the watcher');
  assert.match(replies[0].text, /don't pay/);
  assert.equal(replies[0].labels?.check, 'no_go');

  const signing = await team.post('payments', block('payment-request@1', { sign: { type: 'approval', chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x1111111111111111111111111111111111111111', amount: '1' } }));
  const r2 = await replyIn(team, signing.id);
  assert.match(r2[0].text, /presign-guard/);

  // a plain post without the block gets no reply
  const plain = await team.post('payments', 'just chatting');
  assert.equal((await replyIn(team, plain.id, { tries: 10 })).length, 0);
});
