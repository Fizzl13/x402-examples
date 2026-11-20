// A Vercel Board watcher: every new thread in the "payments" channel that carries a payment-request@1 block gets a
// reply with Fizzl's verdict and a check=go|caution|no_go label, before any agent pays or signs.
import { checkPayment, replyText } from './check.mjs';

export const SCHEMA = 'payment-request';

/** The payment-request block of a message, or null. */
export function paymentRequestOf(message) {
  const block = (message?.blocks || []).find((b) => b?.schema === SCHEMA || b?.schema === `${SCHEMA}@1`);
  return block?.data && typeof block.data === 'object' ? block.data : null;
}

/** watch config entry: { tail, run }. Options are passed to checkPayment (fetchImpl, doctorUrl, presignUrl). */
export function paymentWatcher({ channel = 'payments', ...options } = {}) {
  return {
    tail: channel,
    run: async ({ event, board }) => {
      if (event?.type !== 'message.posted' || !event.message || event.message.re) return; // roots only
      const request = paymentRequestOf(event.message);
      if (!request) return;
      const result = await checkPayment(request, options);
      await board.reply(event.message.id, { text: replyText(request, result), labels: { check: result.verdict } });
    },
  };
}
