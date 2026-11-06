// Run the facilitator against the live Concordium testnet (GitHub Actions can reach the node's gRPC port).
//   node scripts/testnet.js read   no keys: the node runs protocol 10+ (sponsored transactions), the testnet genesis
//                                  matches, EURR reads as a PLT, and a payment signed with a wrong key for a real
//                                  account is refused on its real credentials.
//   node scripts/testnet.js pay    real testnet payments: BUYER_ADDRESS/BUYER_KEY pays AMOUNT (default 1000, i.e.
//                                  0.001 CCD) of ASSET (default CCD) to PAY_TO, COUNT times, sponsored by SPONSOR_ADDRESS
//                                  (SPONSOR_KEY in process, or the deployed facilitator at FACILITATOR_URL).
//                                  Testnet only; keys come from repository secrets, never from the code or the log.
import { generateKeyPairSync } from 'node:crypto';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { createNode } from '../src/node.js';
import { buildPayment, settlePayment, verifyPayment } from '../src/scheme.js';
import { createIdentity } from '../src/identity.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const KNOWN = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB'; // an existing testnet account (read only)
const mode = process.argv[2] || 'read';
const node = createNode({ host: process.env.CONCORDIUM_NODE || undefined });
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok   ${msg}`);

async function read() {
  const status = await node.grpc.getConsensusStatus();
  const protocol = Number(status.protocolVersion);
  const genesis = `ccd:${status.genesisBlock.toString().slice(0, 32)}`;
  genesis === TESTNET ? ok(`testnet genesis ${genesis}`) : fail(`genesis ${genesis}, expected ${TESTNET}`);
  protocol >= 10 ? ok(`protocol ${protocol}: sponsored transactions available`) : fail(`protocol ${protocol}: sponsored transactions need 10`);
  const eurr = await node.token('EURR');
  eurr ? ok(`EURR: ${eurr.decimals} decimals, ${eurr.paused ? 'paused' : 'not paused'}`) : fail('EURR not found');
  const nonce = await node.nextNonce(KNOWN);
  ok(`next nonce of ${KNOWN.slice(0, 8)}…: ${nonce}`);
  // Who is being paid: the account's identity credential (provider, valid until), read from the node.
  const who = await createIdentity({ network: TESTNET, node }).check({ resourceUrl: null, payTo: KNOWN });
  who.credential ? ok(`identity of ${KNOWN.slice(0, 8)}…: ${who.outcome}, ${who.credential.provider}, valid to ${who.credential.validTo}`) : fail(`identity of ${KNOWN.slice(0, 8)}… not read`);
  // A payment from a real account, signed with a key that isn't its: refused on its real on-chain credentials.
  const priv = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const req = { scheme: 'exact', network: TESTNET, amount: '1000', asset: 'CCD', payTo: KNOWN, maxTimeoutSeconds: 120, extra: { feePayer: KNOWN } };
  const sender = process.env.READ_SENDER || '3paEXqKpvG8MiHa9YphTDEkbLJNpJjdzJcJt2Jt623xqjCYidx'; // a testnet token governance account
  const realSender = (await node.accountInfo(sender)) ? sender : null;
  if (!realSender) { console.log(`skip signature check: ${sender.slice(0, 8)}… is not a testnet account`); return; }
  const payload = await buildPayment({ requirements: { ...req, payTo: KNOWN }, sender: realSender, nonce, signer: buildBasicAccountSigner(priv) });
  const v = await verifyPayment({ requirements: req, payload, sponsor: KNOWN, node });
  v.invalidReason === 'invalid_exact_signature' ? ok('a wrongly signed payment is refused on the account\'s real keys') : fail(`expected invalid_exact_signature, got ${v.invalidReason} ${v.detail ?? ''}`);
}

// FACILITATOR_URL set: the payments go through that deployed facilitator's /verify and /settle (as a seller's server
// would send them), so the live service is tested end to end; empty: verified and settled in this process.
// COUNT: how many payments, one after another (1 to 5).
async function pay() {
  const need = ['BUYER_ADDRESS', 'BUYER_KEY', 'SPONSOR_ADDRESS', 'PAY_TO'];
  const remote = process.env.FACILITATOR_URL?.trim().replace(/\/+$/, '') || '';
  if (!remote) need.push('SPONSOR_KEY');
  const missing = need.filter((k) => !process.env[k]?.trim());
  if (missing.length) return fail(`set ${missing.join(', ')} (repository secrets)`);
  const e = (k) => process.env[k].trim();
  const count = Math.max(1, Math.min(5, Number(process.env.COUNT) || 1));
  const asset = process.env.ASSET?.trim() || 'CCD';
  const token = asset === 'CCD' ? null : await node.token(asset);
  if (asset !== 'CCD' && !token) return fail(`token ${asset} not found on testnet`);
  const req = { scheme: 'exact', network: TESTNET, amount: process.env.AMOUNT?.trim() || '1000', asset, payTo: e('PAY_TO'), maxTimeoutSeconds: 120, extra: { feePayer: e('SPONSOR_ADDRESS') } };
  const post = async (path, body) => {
    const res = await fetch(`${remote}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  };
  if (remote) ok(`via ${remote}`);
  for (let i = 1; i <= count; i++) {
    const nonce = await node.nextNonce(e('BUYER_ADDRESS'));
    const payload = await buildPayment({ requirements: req, sender: e('BUYER_ADDRESS'), nonce, signer: buildBasicAccountSigner(e('BUYER_KEY')), token });
    const body = { x402Version: 2, paymentPayload: { x402Version: 2, accepted: req, payload }, paymentRequirements: req };
    const v = remote ? await post('/verify', body) : await verifyPayment({ requirements: req, payload, sponsor: e('SPONSOR_ADDRESS'), node });
    if (!v.isValid) return fail(`payment ${i}: verify: ${v.invalidReason} ${v.invalidMessage ?? v.detail ?? ''}`);
    ok(`payment ${i}: verify valid, payer ${v.payer}`);
    const st = remote ? await post('/settle', body) : await settlePayment({ requirements: req, payload, sponsor: e('SPONSOR_ADDRESS'), sponsorSigner: buildBasicAccountSigner(e('SPONSOR_KEY')), node });
    if (!st.success) return fail(`payment ${i}: settle: ${st.errorReason} ${st.errorMessage ?? st.detail ?? ''} ${st.transaction}`);
    ok(`payment ${i}: settled ${st.transaction} (https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${st.transaction})`);
  }
}

// buy: an x402 buyer against the demo seller (DEMO_URL, default the deployed facilitator's /demo/paid): GET, read
// the 402, sign the payment it asks for, send it in PAYMENT-SIGNATURE, and print the answer, the transaction and what
// Concordium said about the seller. Needs only BUYER_ADDRESS and BUYER_KEY.
async function buy() {
  const missing = ['BUYER_ADDRESS', 'BUYER_KEY'].filter((k) => !process.env[k]?.trim());
  if (missing.length) return fail(`set ${missing.join(', ')} (repository secrets)`);
  const url = process.env.DEMO_URL?.trim() || 'https://concordium-facilitator.onrender.com/demo/paid';
  const first = await fetch(url, { signal: AbortSignal.timeout(150_000) });
  if (first.status !== 402) return fail(`${url}: expected 402, got ${first.status}`);
  const required = JSON.parse(Buffer.from(first.headers.get('payment-required') || '', 'base64').toString('utf8'));
  const req = required.accepts?.find((a) => a.network === TESTNET && a.scheme === 'exact');
  if (!req) return fail('no Concordium testnet option in the 402');
  ok(`402: ${req.amount} ${req.asset} to ${req.payTo.slice(0, 8)}…, fee payer ${req.extra?.feePayer?.slice(0, 8)}…`);
  const buyer = process.env.BUYER_ADDRESS.trim();
  const token = req.asset === 'CCD' ? null : await node.token(req.asset);
  const payload = await buildPayment({ requirements: req, sender: buyer, nonce: await node.nextNonce(buyer), signer: buildBasicAccountSigner(process.env.BUYER_KEY.trim()), token });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: req, payload })).toString('base64');
  const paid = await fetch(url, { headers: { 'payment-signature': header }, signal: AbortSignal.timeout(150_000) });
  const body = await paid.json().catch(() => ({}));
  if (paid.status !== 200) return fail(`paid request: ${paid.status} ${body.error ?? ''}`);
  ok(`paid: ${body.transaction} (https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${body.transaction})`);
  const id = body.identity;
  ok(`seller: ${id?.outcome ?? 'not reported'}${id?.agent ? ` (agent ${id.agent.tokenId ?? id.agent.tokenAddress}: ${id.agent.outcome}${id.agent.reason ? `, ${id.agent.reason}` : ''})` : ''}`);
}

try { await (mode === 'buy' ? buy() : mode === 'pay' ? pay() : read()); } catch (err) { fail(err?.message ?? String(err)); }
