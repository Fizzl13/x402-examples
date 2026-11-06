// The facilitator's HTTP API (x402 v2 facilitator routes): GET /supported, POST /verify, POST /settle, GET /health.
// It sponsors only payments to the sellers in `sellers` (when given) and at most `dailyLimit` settlements a day, so a
// stranger can't spend the sponsor's CCD on fees by paying themselves.
import fs from 'node:fs';
import http from 'node:http';
import { NETWORKS, paymentKey, settlePayment, verifyPayment } from './scheme.js';
import { page } from './page.js';
import { BUYER_PROOF_EXTENSION, PROOF_PATH, requiredBuyerFacts } from './proof.js';

const MAX_BODY = 64 * 1024;
// The concordium-identity extension's JSON Schema, served at GET /schema/concordium-identity.json.
const IDENTITY_SCHEMA = fs.readFileSync(new URL('../schema/concordium-identity.schema.json', import.meta.url));

// identity (src/identity.js createIdentity) and identityMode: 'off'; 'report' (default: what Concordium says about the
// seller rides along in the verify and settle answers, as extensions["concordium-identity"]); or 'agent' (only sellers
// whose payTo is the wallet of an active, registered agent for that endpoint are sponsored).
// demo: { payTo, card, proof, amount = '1000', asset = 'CCD' } adds a paid demo endpoint (GET /demo/paid, a plain x402 seller
// settled by this facilitator in-process) and its seller's Agent Card (GET /.well-known/agent-card.json, served byte for
// byte so its SHA-256 matches the metadata_hash pinned in the Agent Registry). With buyerProof (src/proof.js
// createBuyerProofCheck) it also serves GET /demo/adult: the same seller, for buyers who prove they are 18 or older.
// buyerProof: sellers whose requirements carry extra.buyerProof (the facts the buyer must prove) are sponsored only when
// the paying account's proof, sent as paymentPayload.extensions["concordium-buyer-proof"], shows them.
// statement (src/history.js createStatement): GET /statement?account= lists what one paying account (an agent) paid
// through this facilitator, to whom, and who those payees are.
export function createApp({ network, sponsor, sponsorSigner, node, sellers = null, dailyLimit = 500, history = null, statement = null, identity = null, identityMode = 'report', buyerProof = null, demo = null, now = () => Date.now(), log = console } = {}) {
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
  // The x402 body: { paymentPayload: { payload, accepted?, extensions? }, paymentRequirements }.
  function parts(body) {
    const requirements = body?.paymentRequirements ?? body?.paymentPayload?.accepted;
    const payload = body?.paymentPayload?.payload;
    const resourceUrl = body?.paymentPayload?.resource?.url ?? (typeof requirements?.resource === 'string' ? requirements.resource : null);
    const buyerFile = body?.paymentPayload?.extensions?.[BUYER_PROOF_EXTENSION] ?? null;
    return { requirements, payload, resourceUrl, buyerFile };
  }
  // The buyer proof a seller asks for (extra.buyerProof): null when it asks none; otherwise { refused, result }, where
  // refused is null when the paying account's proof shows every fact asked, else { reason, message }.
  async function buyerCheck(requirements, payer, buyerFile) {
    const required = requiredBuyerFacts(requirements);
    if (required && !required.length) return null;
    if (!required) return { refused: { reason: 'invalid_payment_requirements', message: 'extra.buyerProof must list facts: adult, eu-residence, eu-nationality, id-document-valid' }, result: null };
    if (!buyerProof) return { refused: { reason: 'buyer_proof_unsupported', message: 'this facilitator does not check buyer proofs' }, result: null };
    const result = await buyerProof(buyerFile, payer, required).catch((err) => ({ status: 'invalid', reason: `could not be checked (${err?.message || err})`, required }));
    if (result.status === 'verified') return { refused: null, result };
    return { refused: { reason: result.status === 'missing' ? 'buyer_proof_required' : 'buyer_proof_invalid', message: `this seller sells only to buyers who prove ${required.join(', ')}: ${result.reason}` }, result };
  }
  const withBuyer = (body, b) => (b?.result ? { ...body, extensions: { ...(body.extensions || {}), [BUYER_PROOF_EXTENSION]: b.result } } : body);
  // What Concordium says about the seller, when identity checks are on; null when off or not available.
  async function sellerIdentity(requirements, resourceUrl) {
    if (!identity || identityMode === 'off' || typeof requirements?.payTo !== 'string') return null;
    try { return await identity.check({ resourceUrl, payTo: requirements.payTo }); } catch { return null; }
  }
  const identityRefusal = (id) => {
    if (identityMode === 'agent' && id?.outcome !== 'verified-agent') return `this facilitator sponsors only sellers whose payTo is the wallet of a registered Concordium agent for this endpoint (${id?.agent?.reason || id?.outcome || 'not read'})`;
    if (identityMode === 'proof' && id?.proof?.status !== 'verified') return `this facilitator sponsors only sellers that prove who stands behind their payTo (a zero-knowledge proof at ${PROOF_PATH}: ${id?.proof?.reason || 'none served'})`;
    return null;
  };
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

  // Settle one payment for a seller: daily limit, the identity policy, the buyer proof it asks for, at most one
  // settlement of it at a time.
  async function settleOne(requirements, payload, resourceUrl, buyerFile = null) {
    if (settledToday() >= dailyLimit) return { success: false, errorReason: 'facilitator_daily_limit', network, transaction: '' };
    const id = await sellerIdentity(requirements, resourceUrl);
    const no = identityRefusal(id);
    if (no) return withIdentity({ success: false, errorReason: 'seller_identity_not_verified', errorMessage: no, network, transaction: '' }, id);
    const key = paymentKey(payload);
    if (settling.has(key)) return { success: false, errorReason: 'already_settling', network, transaction: '' };
    settling.add(key);
    try {
      let buyer = null;
      const check = async (v) => {
        buyer = await buyerCheck(requirements, v.payer, buyerFile);
        return buyer?.refused ? { errorReason: buyer.refused.reason, detail: buyer.refused.message } : null;
      };
      const s = await settlePayment({ requirements, payload, sponsor, sponsorSigner, node, now: now(), check });
      if (s.transaction) settled += 1; // a submitted transaction cost the sponsor a fee, settled or not
      log.info?.(`[settle] ${s.success ? 'ok' : s.errorReason} ${s.transaction || ''} payer=${s.payer ?? '-'}`);
      return withBuyer(withIdentity(s.detail ? { ...s, errorMessage: String(s.detail), detail: undefined } : s, id), buyer);
    } finally { settling.delete(key); }
  }

  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        const host = String(req.headers.host ?? '').replace(/[^A-Za-z0-9.:-]/g, '');
        const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const onChain = history ? await history.get().catch(() => null) : null;
        const html = page({ network, sponsor, settledToday: settledToday(), dailyLimit, sellersOnly: !!allowed, base: host ? `${proto}://${host}` : '', history: onChain, identityMode: identity ? identityMode : 'off', demo: Boolean(demo), buyerProof: Boolean(buyerProof), statement: Boolean(statement) });
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
      // An agent's statement: what the paying account sent through this facilitator, read from the chain.
      if (req.method === 'GET' && path === '/statement') {
        const account = new URL(req.url, 'http://x').searchParams.get('account') || '';
        if (!statement || !/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(account)) return json(res, 400, { error: 'give account: the Concordium account an agent pays from' }, OPEN);
        const s = await statement(account).catch(() => null);
        return json(res, s ? 200 : 503, s ?? { error: 'could not read the account history' }, OPEN);
      }
      if (req.method === 'GET' && path === '/supported') {
        const extensions = [...(identity && identityMode !== 'off' ? ['concordium-identity'] : []), ...(buyerProof ? [BUYER_PROOF_EXTENSION] : [])];
        return json(res, 200, { kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { feePayer: sponsor } }], extensions, signers: { [network]: [sponsor] } }, OPEN);
      }
      if (req.method === 'POST' && (path === '/verify' || path === '/settle')) {
        const { requirements, payload, resourceUrl, buyerFile } = parts(await readBody(req));
        const refused = refusedSeller(requirements);
        if (path === '/verify') {
          if (refused) return json(res, 200, { isValid: false, invalidReason: refused });
          const v = await verifyPayment({ requirements, payload, sponsor, node, now: now() });
          if (!v.isValid) return json(res, 200, { isValid: false, invalidReason: v.invalidReason, ...(v.detail ? { invalidMessage: v.detail } : {}) });
          const id = await sellerIdentity(requirements, resourceUrl);
          const no = identityRefusal(id);
          if (no) return json(res, 200, withIdentity({ isValid: false, invalidReason: 'seller_identity_not_verified', invalidMessage: no }, id));
          const buyer = await buyerCheck(requirements, v.payer, buyerFile);
          if (buyer?.refused) return json(res, 200, withBuyer(withIdentity({ isValid: false, invalidReason: buyer.refused.reason, invalidMessage: buyer.refused.message, payer: v.payer }, id), buyer));
          return json(res, 200, withBuyer(withIdentity({ isValid: true, payer: v.payer }, id), buyer));
        }
        if (refused) return json(res, 200, { success: false, errorReason: refused, network: requirements?.network ?? network, transaction: '' });
        return json(res, 200, await settleOne(requirements, payload, resourceUrl, buyerFile));
      }
      if (demo?.proof && req.method === 'GET' && path === PROOF_PATH) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...OPEN });
        return res.end(demo.proof);
      }
      if (demo && req.method === 'GET' && path === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...OPEN });
        return res.end(demo.card);
      }
      // /demo/adult: the same seller, selling only to buyers who prove they are 18 or older (extra.buyerProof).
      const adult = path === '/demo/adult' && Boolean(buyerProof);
      if (demo && req.method === 'GET' && (path === '/demo/paid' || adult)) {
        const host = String(req.headers.host ?? '').replace(/[^A-Za-z0-9.:-]/g, '');
        const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const resource = { url: `${proto}://${host}${path}`, description: adult ? 'Demo: a paid answer on Concordium testnet for adults only: the buyer proves, with zero knowledge, that an adult stands behind the paying account' : 'Demo: a paid answer on Concordium testnet, settled by this facilitator', mimeType: 'application/json' };
        const requirements = { scheme: 'exact', network, amount: demo.amount ?? '1000', asset: demo.asset ?? 'CCD', payTo: demo.payTo, maxTimeoutSeconds: 120, extra: { feePayer: sponsor, ...(adult ? { buyerProof: ['adult'] } : {}) } };
        // What a buyer needs to know to pay /demo/adult: the facts, the challenge its proof is made for, and where to make it.
        const extensions = adult ? { [BUYER_PROOF_EXTENSION]: { info: { facts: ['adult'], challenge: 'sha256("concordium-x402-buyer-proof:v1|<network>|<the account you pay from>")', make: 'https://x402-doctor.fizzl.eu/concordium-proof.html?role=buyer' } } } : undefined;
        const required = (error) => {
          const body = { x402Version: 2, error, resource, accepts: [requirements], ...(extensions ? { extensions } : {}) };
          res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(body)).toString('base64'), 'cache-control': 'no-store' });
          return res.end(JSON.stringify(body));
        };
        const header = req.headers['payment-signature'] || req.headers['x-payment'];
        if (!header) return required('payment required');
        let paymentPayload;
        try { paymentPayload = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { return required('the payment header is not base64 JSON'); }
        const s = await settleOne(requirements, paymentPayload?.payload, resource.url, paymentPayload?.extensions?.[BUYER_PROOF_EXTENSION] ?? null);
        if (!s.success) return required(`${s.errorReason}${s.errorMessage ? `: ${s.errorMessage}` : ''}`);
        res.writeHead(200, { 'content-type': 'application/json', 'payment-response': Buffer.from(JSON.stringify(s)).toString('base64'), 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ paid: true, message: adult ? 'Paid on Concordium by a buyer who proved an adult stands behind the paying account; this facilitator sponsored the fee.' : 'Paid on Concordium: the buyer signed, this facilitator sponsored the fee.', transaction: s.transaction, payer: s.payer, identity: s.extensions?.['concordium-identity'] ?? null, ...(adult ? { buyer: s.extensions?.[BUYER_PROOF_EXTENSION] ?? null } : {}) }));
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err?.status) return json(res, err.status, { error: err.message });
      log.error?.(`[facilitator] ${err?.message}`);
      return json(res, 500, { error: 'facilitator error' });
    }
  });
}
