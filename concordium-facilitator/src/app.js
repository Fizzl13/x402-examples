// The facilitator's HTTP API (x402 v2 facilitator routes): GET /supported, POST /verify, POST /settle, GET /health.
// It sponsors only payments to the sellers in `sellers` (when given) and at most `dailyLimit` settlements a day, so a
// stranger can't spend the sponsor's CCD on fees by paying themselves.
import fs from 'node:fs';
import http from 'node:http';
import { NETWORKS, paymentKey, settlePayment, verifyPayment } from './scheme.js';
import { page } from './page.js';

const MAX_BODY = 64 * 1024;
// The concordium-identity extension's JSON Schema, served at GET /schema/concordium-identity.json.
const IDENTITY_SCHEMA = fs.readFileSync(new URL('../schema/concordium-identity.schema.json', import.meta.url));

// identity (src/identity.js createIdentity) and identityMode: 'off'; 'report' (default: what Concordium says about the
// seller rides along in the verify and settle answers, as extensions["concordium-identity"]); or 'agent' (only sellers
// whose payTo is the wallet of an active, registered agent for that endpoint are sponsored).
// demo: { payTo, card, amount = '1000', asset = 'CCD' } adds a paid demo endpoint (GET /demo/paid, a plain x402 seller
// settled by this facilitator in-process) and its seller's Agent Card (GET /.well-known/agent-card.json, served byte for
// byte so its SHA-256 matches the metadata_hash pinned in the Agent Registry).
export function createApp({ network, sponsor, sponsorSigner, node, sellers = null, dailyLimit = 500, history = null, identity = null, identityMode = 'report', demo = null, now = () => Date.now(), log = console } = {}) {
  if (!NETWORKS[network]) throw new Error(`unknown network ${network}`);
  const allowed = sellers && sellers.length ? new Set(sellers) : null;
  const settling = new Set(); // transaction JSONs being settled right now: the same one is not submitted twice at once
  let day = '', settled = 0;

  // Read-only GETs (the Agent Card, /supported, /health, /identity, /payments, the schema) may be read from any page, e.g. a
  // registry's pin page fetching the card to hash it; POST /verify and /settle don't need it and don't get it.
  const OPEN = { 'access-control-allow-origin': '*' };
  const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
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
    const resourceUrl = body?.paymentPayload?.resource?.url ?? (typeof requirements?.resource === 'string' ? requirements.resource : null);
    return { requirements, payload, resourceUrl };
  }
  // What Concordium says about the seller, when identity checks are on; null when off or not available.
  async function sellerIdentity(requirements, resourceUrl) {
    if (!identity || identityMode === 'off' || typeof requirements?.payTo !== 'string') return null;
    try { return await identity.check({ resourceUrl, payTo: requirements.payTo }); } catch { return null; }
  }
  const identityRefusal = (id) => (identityMode === 'agent' && id?.outcome !== 'verified-agent'
    ? `this facilitator sponsors only sellers whose payTo is the wallet of a registered Concordium agent for this endpoint (${id?.agent?.reason || id?.outcome || 'not read'})` : null);
  const withIdentity = (body, id) => (id ? { ...body, extensions: { ...(body.extensions || {}), 'concordium-identity': id } } : body);
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

  // Settle one payment for a seller: daily limit, the identity policy, at most one settlement of it at a time.
  async function settleOne(requirements, payload, resourceUrl) {
    if (settledToday() >= dailyLimit) return { success: false, errorReason: 'facilitator_daily_limit', network, transaction: '' };
    const id = await sellerIdentity(requirements, resourceUrl);
    const no = identityRefusal(id);
    if (no) return withIdentity({ success: false, errorReason: 'seller_identity_not_verified', errorMessage: no, network, transaction: '' }, id);
    const key = paymentKey(payload);
    if (settling.has(key)) return { success: false, errorReason: 'already_settling', network, transaction: '' };
    settling.add(key);
    try {
      const s = await settlePayment({ requirements, payload, sponsor, sponsorSigner, node, now: now() });
      if (s.transaction) settled += 1; // a submitted transaction cost the sponsor a fee, settled or not
      log.info?.(`[settle] ${s.success ? 'ok' : s.errorReason} ${s.transaction || ''} payer=${s.payer ?? '-'}`);
      return withIdentity(s.detail ? { ...s, errorMessage: String(s.detail), detail: undefined } : s, id);
    } finally { settling.delete(key); }
  }

  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        const host = String(req.headers.host ?? '').replace(/[^A-Za-z0-9.:-]/g, '');
        const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const onChain = history ? await history.get().catch(() => null) : null;
        const html = page({ network, sponsor, settledToday: settledToday(), dailyLimit, sellersOnly: !!allowed, base: host ? `${proto}://${host}` : '', history: onChain, identityMode: identity ? identityMode : 'off', demo: Boolean(demo) });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && path === '/health') {
        const onChain = history ? await history.get().catch(() => null) : null;
        return json(res, 200, { ok: true, network, sponsor, settled_today: settledToday(), daily_limit: dailyLimit, ...(onChain ? { sponsored: onChain.sponsored, sponsored_today: onChain.sponsored_today, fees_ccd: onChain.fees_ccd } : {}) }, OPEN);
      }
      // What Concordium says about a seller, before it goes live: /identity?url=<paid endpoint>&payTo=<account>.
      if (req.method === 'GET' && path === '/identity') {
        const q = new URL(req.url, 'http://x').searchParams;
        const payTo = q.get('payTo') || '';
        if (!identity || !/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(payTo)) return json(res, 400, { error: 'give payTo (a Concordium account) and url (the paid endpoint)' });
        const id = await identity.check({ resourceUrl: q.get('url') || null, payTo }).catch(() => null);
        return json(res, id ? 200 : 503, id ?? { error: 'could not read' }, OPEN);
      }
      if (req.method === 'GET' && path === '/schema/concordium-identity.json') {
        res.writeHead(200, { 'content-type': 'application/schema+json', 'cache-control': 'public, max-age=300', ...OPEN });
        return res.end(IDENTITY_SCHEMA);
      }
      if (req.method === 'GET' && path === '/payments') {
        const onChain = history ? await history.get().catch(() => null) : null;
        return json(res, onChain ? 200 : 503, onChain ?? { error: 'payment history unavailable' }, OPEN);
      }
      if (req.method === 'GET' && path === '/supported') {
        return json(res, 200, { kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { feePayer: sponsor } }], extensions: identity && identityMode !== 'off' ? ['concordium-identity'] : [], signers: { [network]: [sponsor] } }, OPEN);
      }
      if (req.method === 'POST' && (path === '/verify' || path === '/settle')) {
        const { requirements, payload, resourceUrl } = parts(await readBody(req));
        const refused = refusedSeller(requirements);
        if (path === '/verify') {
          if (refused) return json(res, 200, { isValid: false, invalidReason: refused });
          const v = await verifyPayment({ requirements, payload, sponsor, node, now: now() });
          if (!v.isValid) return json(res, 200, { isValid: false, invalidReason: v.invalidReason, ...(v.detail ? { invalidMessage: v.detail } : {}) });
          const id = await sellerIdentity(requirements, resourceUrl);
          const no = identityRefusal(id);
          if (no) return json(res, 200, withIdentity({ isValid: false, invalidReason: 'seller_identity_not_verified', invalidMessage: no }, id));
          return json(res, 200, withIdentity({ isValid: true, payer: v.payer }, id));
        }
        if (refused) return json(res, 200, { success: false, errorReason: refused, network: requirements?.network ?? network, transaction: '' });
        return json(res, 200, await settleOne(requirements, payload, resourceUrl));
      }
      if (demo && req.method === 'GET' && path === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...OPEN });
        return res.end(demo.card);
      }
      if (demo && req.method === 'GET' && path === '/demo/paid') {
        const host = String(req.headers.host ?? '').replace(/[^A-Za-z0-9.:-]/g, '');
        const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const resource = { url: `${proto}://${host}/demo/paid`, description: 'Demo: a paid answer on Concordium testnet, settled by this facilitator', mimeType: 'application/json' };
        const requirements = { scheme: 'exact', network, amount: demo.amount ?? '1000', asset: demo.asset ?? 'CCD', payTo: demo.payTo, maxTimeoutSeconds: 120, extra: { feePayer: sponsor } };
        const required = (error) => {
          const body = { x402Version: 2, error, resource, accepts: [requirements] };
          res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(body)).toString('base64'), 'cache-control': 'no-store' });
          return res.end(JSON.stringify(body));
        };
        const header = req.headers['payment-signature'] || req.headers['x-payment'];
        if (!header) return required('payment required');
        let paymentPayload;
        try { paymentPayload = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { return required('the payment header is not base64 JSON'); }
        const s = await settleOne(requirements, paymentPayload?.payload, resource.url);
        if (!s.success) return required(`${s.errorReason}${s.errorMessage ? `: ${s.errorMessage}` : ''}`);
        res.writeHead(200, { 'content-type': 'application/json', 'payment-response': Buffer.from(JSON.stringify(s)).toString('base64'), 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ paid: true, message: 'Paid on Concordium: the buyer signed, this facilitator sponsored the fee.', transaction: s.transaction, payer: s.payer, identity: s.extensions?.['concordium-identity'] ?? null }));
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err?.status) return json(res, err.status, { error: err.message });
      log.error?.(`[facilitator] ${err?.message}`);
      return json(res, 500, { error: 'facilitator error' });
    }
  });
}
