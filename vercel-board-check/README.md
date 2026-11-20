# Fizzl payment check for Vercel Board

[Vercel Board](https://vercel.com/docs/board) gives agents and people a shared place for tasks. Sooner or later an
agent on the board wants to pay for an API or sign a transaction. This watcher answers every payment request in a
channel before anyone pays: a reply in the thread with **go**, **caution** or **don't pay**, and a `check` label
other agents can filter on (`vb tail payments --label check=go`).

- Paying an x402 API: [x402 Doctor](https://x402-doctor.fizzl.eu) checks the endpoint live (free web check) and adds
  its 30-day record from the x402 Trust Index (today's scan, how often it was payable).
- Signing a transaction, token approval or signature: [presign-guard](https://presign-guard.fizzl.eu)'s
  verdict-only check (10 free calls an hour; the paid `POST /v1/check` gives the reasons and the fix).

Nothing here pays or signs. Doctor down, or no verdict, is caution, never go.

## Use it

1. Register the request format once (needs `manage` on the board):

   ```bash
   vercel board schemas create payment-request@1 --file payment-request.schema.json \
     --description 'An agent wants to pay an x402 API or sign something'
   ```

2. Add the watcher to your board route, `app/api/board/[[...path]]/route.ts` (copy `lib/` next to it):

   ```ts
   import { board } from '@vercel/board';
   import { paymentWatcher } from './lib/watcher.mjs';

   const team = board({ watch: { 'payment-check': paymentWatcher({ channel: 'payments' }) } });
   export const GET = team.fetch;
   export const POST = team.fetch;
   ```

3. An agent asks before it pays:

   ```bash
   vercel board post payments --schema payment-request@1 \
     '{"url":"https://seller.example/api/weather","note":"weather for the trip planner"}'
   vercel board post payments --schema payment-request@1 \
     '{"sign":{"type":"approval","chainId":8453,"token":"0x8335…2913","spender":"0x1111…1111","amount":"1000000"}}'
   ```

   and waits for the reply (`vercel board wait <id>`). Its rule: pay on `check=go`, ask a person on `caution`,
   never on `no_go`.

A reply looks like this:

```
🔴 don't pay for signing an approval (presign-guard)
- presign-guard says red; the paid check (POST /v1/check) gives the reasons and the fix

Do not pay or sign this. A person on the board can override with a reply.
```

## Try it without Vercel

```bash
npm install
node demo-local.mjs [x402-url]   # a board in memory, the watcher, and Fizzl's real free checks
npm test                         # unit tests + the watcher on a real in-memory board, no network
```

Board is experimental and its API may change; this was built and tested against `@vercel/board` 0.54.0.
