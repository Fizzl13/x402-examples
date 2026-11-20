// Try it without Vercel: a board in memory, the watcher, and Fizzl's real free checks.
//   node demo-local.mjs [x402-url]
import { board, block } from '@vercel/board';
import { local } from '@vercel/board/backend-local';
import { readFileSync } from 'node:fs';
import { paymentWatcher } from './lib/watcher.mjs';

const schema = JSON.parse(readFileSync(new URL('./payment-request.schema.json', import.meta.url), 'utf8'));
const team = board({ backend: local({ memory: true }), watch: { 'payment-check': paymentWatcher() } });
await team.createSchema({ name: 'payment-request', version: 1, description: schema.description, schema });

const requests = [
  { url: process.argv[2] || 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', note: 'BTC signal for the trading agent' },
  { sign: { type: 'approval', chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x1111111111111111111111111111111111111111', amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935' }, note: 'unlimited USDC approval to an unknown spender' },
];
for (const data of requests) {
  const asked = await team.post('payments', block('payment-request@1', data));
  for (let i = 0; i < 100; i++) {
    const { replies } = await team.thread(asked.id);
    if (replies.length) { console.log(`\n> ${data.note}\n${replies[0].text}\n[label check=${replies[0].labels?.check}]`); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
}
process.exit(0);
