// Run the facilitator against the live Concordium testnet (GitHub Actions can reach the node's gRPC port).
//   node scripts/testnet.js read   no keys: the node runs protocol 10+ (sponsored transactions), the testnet genesis
//                                  matches, EURR reads as a PLT, and a payment signed with a wrong key for a real
//                                  account is refused on its real credentials.
//   node scripts/testnet.js pay    a real testnet payment: BUYER_ADDRESS/BUYER_KEY pays AMOUNT (default 1000, i.e.
//                                  0.001 CCD) of ASSET (default CCD) to PAY_TO, sponsored by SPONSOR_ADDRESS/SPONSOR_KEY.
//                                  Testnet only; keys come from repository secrets, never from the code or the log.
import { generateKeyPairSync } from 'node:crypto';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { createNode } from '../src/node.js';
import { buildPayment, settlePayment, verifyPayment } from '../src/scheme.js';

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
  // A payment from a real account, signed with a key that isn't its: refused on its real on-chain credentials.
  const priv = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const req = { scheme: 'exact', network: TESTNET, amount: '1000', asset: 'CCD', payTo: KNOWN, maxTimeoutSeconds: 120, extra: { sponsor: KNOWN } };
  const sender = process.env.READ_SENDER || '3paEXqKpvG8MiHa9YphTDEkbLJNpJjdzJcJt2Jt623xqjCYidx' // a testnet token governance account;
  const realSender = (await node.accountInfo(sender)) ? sender : null;
  if (!realSender) { console.log(`skip signature check: ${sender.slice(0, 8)}… is not a testnet account`); return; }
  const payload = await buildPayment({ requirements: { ...req, payTo: KNOWN }, sender: realSender, nonce, signer: buildBasicAccountSigner(priv) });
  const v = await verifyPayment({ requirements: req, payload, sponsor: KNOWN, node });
  v.invalidReason === 'invalid_exact_signature' ? ok('a wrongly signed payment is refused on the account\'s real keys') : fail(`expected invalid_exact_signature, got ${v.invalidReason} ${v.detail ?? ''}`);
}

async function pay() {
  const need = ['BUYER_ADDRESS', 'BUYER_KEY', 'SPONSOR_ADDRESS', 'SPONSOR_KEY', 'PAY_TO'];
  const missing = need.filter((k) => !process.env[k]?.trim());
  if (missing.length) return fail(`set ${missing.join(', ')} (repository secrets)`);
  const e = (k) => process.env[k].trim();
  const asset = process.env.ASSET?.trim() || 'CCD';
  const token = asset === 'CCD' ? null : await node.token(asset);
  const req = { scheme: 'exact', network: TESTNET, amount: process.env.AMOUNT?.trim() || '1000', asset, payTo: e('PAY_TO'), maxTimeoutSeconds: 120, extra: { sponsor: e('SPONSOR_ADDRESS'), ...(token ? { decimals: token.decimals } : {}) } };
  const nonce = await node.nextNonce(e('BUYER_ADDRESS'));
  const payload = await buildPayment({ requirements: req, sender: e('BUYER_ADDRESS'), nonce, signer: buildBasicAccountSigner(e('BUYER_KEY')), token });
  const v = await verifyPayment({ requirements: req, payload, sponsor: e('SPONSOR_ADDRESS'), node });
  if (!v.isValid) return fail(`verify: ${v.invalidReason} ${v.detail ?? ''}`);
  ok(`verify: valid, payer ${v.payer}`);
  const s = await settlePayment({ requirements: req, payload, sponsor: e('SPONSOR_ADDRESS'), sponsorSigner: buildBasicAccountSigner(e('SPONSOR_KEY')), node });
  if (!s.success) return fail(`settle: ${s.errorReason} ${s.detail ?? ''} ${s.transaction}`);
  ok(`settled: ${s.transaction} (https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${s.transaction})`);
}

try { await (mode === 'pay' ? pay() : read()); } catch (err) { fail(err?.message ?? String(err)); }
