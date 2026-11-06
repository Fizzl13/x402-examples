// The facilitator's HTTP API (x402 v2 facilitator routes): GET /supported, POST /verify, POST /settle, GET /health.
// It sponsors only payments to the sellers in `sellers` (when given) and at most `dailyLimit` settlements a day, so a
// stranger can't spend the sponsor's CCD on fees by paying themselves.
import http from 'node:http';
import { NETWORKS, settlePayment, verifyPayment } from './scheme.js';
import { page } from './page.js';

const MAX_BODY = 64 * 1024;

export function createApp({ network, sponsor, sponsorSigner, node, sellers = null, dailyLimit = 500, history = null, now = () => Date.now(), log = console } = {}) {
  if (!NETWORKS[network]) throw new Error(`unknown network ${network}`);
  const allowed = sellers && sellers.length ? new Set(sellers) : null;
  const settling = new Set(); // transaction JSONs being settled right now: the same one is not submitted twice at once
  let day = '', settled = 0;

  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('not JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  // The x402 body: { paymentPayload: { payload, accepted? }, paymentRequirements }.
  function parts(body) {
    const requirements = body?.paymentRequirements ?? body?.paymentPayload?.accepted;
    const payload = body?.paymentPayload?.payload;
    return { requirements, payload };
  }
  function settledToday() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; settled = 0; }
    return settled;
  }
  function refusedSeller(requirements) {
    if (requirements?.network !== network) return 'invalid_network';
    if (allowed && !allowed.has(requirements?.payTo)) return 'seller_not_sponsored';
    return null;
  }

  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        const host = String(req.headers.host ?? '').replace(/[^A-Za-z0-9.:-]/g, '');
        const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const onChain = history ? await history.get().catch(() => null) : null;
        const html = page({ network, sponsor, settledToday: settledToday(), dailyLimit, sellersOnly: !!allowed, base: host ? `${proto}://${host}` : '', history: onChain });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && path === '/health') {
        const onChain = history ? await history.get().catch(() => null) : null;
        return json(res, 200, { ok: true, network, sponsor, settled_today: settledToday(), daily_limit: dailyLimit, ...(onChain ? { sponsored: onChain.sponsored, sponsored_today: onChain.sponsored_today, fees_ccd: onChain.fees_ccd } : {}) });
      }
      if (req.method === 'GET' && path === '/payments') {
        const onChain = history ? await history.get().catch(() => null) : null;
        return json(res, onChain ? 200 : 503, onChain ?? { error: 'payment history unavailable' });
      }
      if (req.method === 'GET' && path === '/supported') {
        return json(res, 200, { kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { sponsor } }], extensions: [], signers: { [network]: [sponsor] } });
      }
      if (req.method === 'POST' && (path === '/verify' || path === '/settle')) {
        const { requirements, payload } = parts(await readBody(req));
        const refused = refusedSeller(requirements);
        if (path === '/verify') {
          if (refused) return json(res, 200, { isValid: false, invalidReason: refused });
          const v = await verifyPayment({ requirements, payload, sponsor, node, now: now() });
          return json(res, 200, v.isValid ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.invalidReason, ...(v.detail ? { invalidMessage: v.detail } : {}) });
        }
        if (refused) return json(res, 200, { success: false, errorReason: refused, network: requirements?.network ?? network, transaction: '' });
        if (settledToday() >= dailyLimit) return json(res, 200, { success: false, errorReason: 'facilitator_daily_limit', network, transaction: '' });
        const key = String(payload?.transaction ?? '');
        if (settling.has(key)) return json(res, 200, { success: false, errorReason: 'already_settling', network, transaction: '' });
        settling.add(key);
        try {
          const s = await settlePayment({ requirements, payload, sponsor, sponsorSigner, node, now: now() });
          if (s.transaction) settled += 1; // a submitted transaction cost the sponsor a fee, settled or not
          log.info?.(`[settle] ${s.success ? 'ok' : s.errorReason} ${s.transaction || ''} payer=${s.payer ?? '-'}`);
          return json(res, 200, s.detail ? { ...s, errorMessage: String(s.detail), detail: undefined } : s);
        } finally { settling.delete(key); }
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err?.status) return json(res, err.status, { error: err.message });
      log.error?.(`[facilitator] ${err?.message}`);
      return json(res, 500, { error: 'facilitator error' });
    }
  });
}
