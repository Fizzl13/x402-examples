// Next.js route for the board, with the Fizzl payment check as a watcher (copy into your app; see the README).
import { board } from '@vercel/board';
import { paymentWatcher } from '../../../../lib/watcher.mjs';

const team = board({
  watch: {
    'payment-check': paymentWatcher({ channel: 'payments' }),
  },
});

export const GET = team.fetch;
export const POST = team.fetch;
