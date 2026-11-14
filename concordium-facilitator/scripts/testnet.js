// Run the facilitator against the live Concordium testnet (GitHub Actions can reach the node's gRPC port).
//   node scripts/testnet.js read   no keys: the node runs protocol 10+ (sponsored transactions), the testnet genesis
//                                  matches, EURR reads as a PLT, and a payment signed with a wrong key for a real
//                                  account is refused on its real credentials, and the demo seller's zero-knowledge
//                                  proof (demo/concordium-proof.json) verifies against the chain, and so does the
//                                  demo buyer's (demo/concordium-buyer-proof.json, when committed).
//   node scripts/testnet.js pay    real testnet payments: BUYER_ADDRESS/BUYER_KEY pays AMOUNT (default 1000, i.e.
//                                  0.001 CCD) of ASSET (default CCD) to PAY_TO, COUNT times, sponsored by SPONSOR_ADDRESS
//                                  (SPONSOR_KEY in process, or the deployed facilitator at FACILITATOR_URL).
//                                  Testnet only; keys come from repository secrets, never from the code or the log.
import { generateKeyPairSync } from 'node:crypto';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { createNode } from '../src/node.js';
import { buildPayment, settlePayment, verifyPayment } from '../src/scheme.js';
import { createIdentity } from '../src/identity.js';
import { BUYER_PROOF_EXTENSION, createBuyerProofCheck, createProofCheck } from '../src/proof.js';
import { existsSync, readFileSync } from 'node:fs';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const KNOWN = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB'; // an existing testnet account (read only)
const mode = process.argv[2] || 'read';
const node = createNode({ host: process.env.CONCORDIUM_NODE || undefined });
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok   ${msg}`);
// The demo buyer's proof (its owner is an adult), made with x402 Doctor's /concordium-proof.html?role=buyer for the
// account BUYER_ADDRESS pays from. Not a secret: worthless from any other account.
const BUYER_PROOF = new URL('../demo/concordium-buyer-proof.json', import.meta.url);
const buyerProofFile = () => (existsSync(BUYER_PROOF) ? JSON.parse(readFileSync(BUYER_PROOF, 'utf8')) : null);

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
  // The demo seller's zero-knowledge proof, as committed: verified against the chain with our own node.
  const proofFile = readFileSync(new URL('../demo/concordium-proof.json', import.meta.url), 'utf8');
  const { origin, payTo } = JSON.parse(proofFile);
  const zk = await createProofCheck({ network: TESTNET, node, get: async () => proofFile })(origin, payTo);
  zk?.status === 'verified' ? ok(`demo seller's proof: verified (${zk.facts.join(', ')}), credential ${zk.credential.slice(0, 12)}… of ${payTo.slice(0, 8)}…`) : fail(`demo seller's proof: ${zk?.reason ?? 'not read'}`);
  const bp = buyerProofFile();
  if (bp) {
    const r = await createBuyerProofCheck({ network: TESTNET, node })(bp, bp.account, ['adult']);
    r.status === 'verified' ? ok(`demo buyer's proof: verified (${r.facts.join(', ')}), credential ${r.credential.slice(0, 12)}… of ${bp.account.slice(0, 8)}…`) : fail(`demo buyer's proof: ${r.reason}`);
  } else console.log("     demo buyer's proof: none committed yet");
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

// buy: an x402 buyer against the demo seller (DEMO_URL, default the deployed facilitator's /demo/paid; another
// seller's URL buys from that seller once, for an interop test, in CCD or the PLT its 402 asks for): GET, read
// the 402, sign the payment it asks for, send it in PAYMENT-SIGNATURE, and print the answer, the transaction and what
// Concordium said about the seller. Needs only BUYER_ADDRESS and BUYER_KEY.
// The 402 of a demo endpoint, then (unless probe) a payment for it, with the buyer proof when given.
async function purchase(url, { proof = null, probe = false } = {}) {
  const first = await fetch(url, { signal: AbortSignal.timeout(150_000) });
  if (first.status !== 402) throw new Error(`${url}: expected 402, got ${first.status}`);
  const required = JSON.parse(Buffer.from(first.headers.get('payment-required') || '', 'base64').toString('utf8'));
  const req = required.accepts?.find((a) => a.network === TESTNET && a.scheme === 'exact');
  if (!req) throw new Error('no Concordium testnet option in the 402');
  const buyer = process.env.BUYER_ADDRESS.trim();
  const token = req.asset === 'CCD' ? null : await node.token(req.asset);
  const payload = await buildPayment({ requirements: req, sender: buyer, nonce: await node.nextNonce(buyer), signer: buildBasicAccountSigner(process.env.BUYER_KEY.trim()), token });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: req, payload, ...(proof ? { extensions: { [BUYER_PROOF_EXTENSION]: proof } } : {}) })).toString('base64');
  const paid = await fetch(url, { headers: { 'payment-signature': header }, signal: AbortSignal.timeout(150_000) });
  return { req, status: paid.status, body: await paid.json().catch(() => ({})) };
}

async function buy() {
  const missing = ['BUYER_ADDRESS', 'BUYER_KEY'].filter((k) => !process.env[k]?.trim());
  if (missing.length) return fail(`set ${missing.join(', ')} (repository secrets)`);
  const url = process.env.DEMO_URL?.trim() || 'https://ccd-facilitator.fizzl.eu/demo/paid';
  const { req, status, body } = await purchase(url);
  ok(`402: ${req.amount} ${req.asset} to ${req.payTo.slice(0, 8)}…, fee payer ${req.extra?.feePayer?.slice(0, 8)}…`);
  if (status !== 200) return fail(`paid request: ${status} ${body.error ?? ''}`);
  ok(`paid: ${body.transaction} (https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${body.transaction})`);
  const id = body.identity;
  ok(`seller: ${id?.outcome ?? 'not reported'}${id?.agent ? ` (agent ${id.agent.tokenId ?? id.agent.tokenAddress}: ${id.agent.outcome}${id.agent.reason ? `, ${id.agent.reason}` : ''})` : ''}`);
  // The demo seller serves its owner's zero-knowledge proof; a seller without one just has none to report.
  if (id?.proof?.status === 'verified') ok(`seller proof: verified (${id.proof.facts.join(', ')})`);
  else if (id?.proof) fail(`seller proof: ${id.proof.status}, ${id.proof.reason ?? ''}`);
  else console.log('     seller proof: none served');

  // The adults-only demo: refused without the buyer's proof (nothing signed or sent), sold with it. Only on our demo.
  if (!/\/demo\/paid$/.test(url)) return;
  const proof = buyerProofFile();
  if (!proof) { console.log("     adults-only demo: skipped, no buyer proof committed yet (demo/concordium-buyer-proof.json)"); return; }
  if (proof.account !== process.env.BUYER_ADDRESS.trim()) return fail(`the committed buyer proof is for ${proof.account.slice(0, 8)}…, not the buyer`);
  const adult = url.replace(/\/demo\/paid$/, '/demo/adult');
  const refused = await purchase(adult);
  refused.status === 402 && /^buyer_proof_required/.test(refused.body.error ?? '') ? ok('adults only, no proof: refused before anything was signed') : fail(`adults only, no proof: expected a 402 buyer_proof_required, got ${refused.status} ${refused.body.error ?? ''}`);
  const sold = await purchase(adult, { proof });
  if (sold.status !== 200) return fail(`adults only, with the proof: ${sold.status} ${sold.body.error ?? ''}`);
  ok(`adults only, with the proof: paid ${sold.body.transaction}; buyer ${sold.body.buyer?.status} (${sold.body.buyer?.facts?.join(', ')})`);
}

try { await (mode === 'buy' ? buy() : mode === 'pay' ? pay() : read()); } catch (err) { fail(err?.message ?? String(err)); }
