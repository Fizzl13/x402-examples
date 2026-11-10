// A seller's zero-knowledge proof about the person behind its payTo (made with x402 Doctor's
// /concordium-proof.html, served by the seller at /.well-known/concordium-proof.json). The owner's Concordium wallet
// proves facts about the identity a regulated identity provider verified ("18 or older", "lives in the EU") without
// revealing them, for a challenge that ties the proof to one network, one site and one payTo:
//   sha256("concordium-x402-seller-proof:v1|<network>|<origin>|<payTo>")
// Before this facilitator sponsors a payment it checks, read-only:
//   1. the file is for this network, this site and this payTo, and the presentation was made for that challenge;
//   2. the zero-knowledge proofs verify against the chain (the credential's commitments and the global parameters,
//      read from our own node: @concordium/web-sdk getPublicData + verifyPresentation);
//   3. the credential that proved it is one of the payTo account's own credentials (so a proof from another account
//      can't be reused);
//   4. which facts the verified statements establish (adult, eu-residence, eu-nationality, id-document-valid).
// Result: { status: 'verified', facts, issuer, credential, created } or { status: 'invalid', reason } (or null when
// the seller serves no proof).
import crypto from 'node:crypto';
import { retryTransient } from './node.js';

export const PROOF_PATH = '/.well-known/concordium-proof.json';
const NETWORK_NAME = { 'ccd:9dd9ca4d19e9393877d2c44b70f89acb': 'mainnet', 'ccd:4221332d34e1694168c2a0c0b3fd0f27': 'testnet' };
const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);

export const challengeFor = (network, origin, payTo) => crypto.createHash('sha256').update(`concordium-x402-seller-proof:v1|${network}|${origin}|${payTo}`).digest('hex');

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
// The facts a set of verified account-credential statements establishes, as of `now`.
export function factsOf(statements, now = Date.now()) {
  const facts = new Set();
  const adultBy = new Date(now);
  adultBy.setUTCFullYear(adultBy.getUTCFullYear() - 18);
  adultBy.setUTCDate(adultBy.getUTCDate() + 1); // dob strictly before this day: 18 or older today
  for (const s of statements || []) {
    if (s?.type === 'AttributeInRange' && s.attributeTag === 'dob' && /^\d{8}$/.test(String(s.upper)) && String(s.upper) <= ymd(adultBy)) facts.add('adult');
    if (s?.type === 'AttributeInSet' && Array.isArray(s.set) && s.set.length && s.set.every((c) => EU.has(String(c).toUpperCase()))) {
      if (s.attributeTag === 'countryOfResidence') facts.add('eu-residence');
      if (s.attributeTag === 'nationality') facts.add('eu-nationality');
    }
    // The document was valid on the day the proof was made (its lower bound); still valid today if that is today or later.
    if (s?.type === 'AttributeInRange' && s.attributeTag === 'idDocExpiresAt' && String(s.lower) >= ymd(new Date(now))) facts.add('id-document-valid');
  }
  return [...facts].sort();
}

// The presentation's verification with the SDK against our own node (node.grpc). Returns the verified request
// ({ challenge, credentialStatements }) or throws.
export async function verifyWithNode(node, networkName, presentation) {
  const sdk = await import('@concordium/web-sdk');
  const vp = sdk.VerifiablePresentation.fromString(JSON.stringify(presentation));
  const net = networkName === 'mainnet' ? 'Mainnet' : 'Testnet';
  const publicData = await retryTransient(() => sdk.getPublicData(node.grpc, net, vp));
  if (publicData.some((p) => p.status !== 0)) throw new Error('the credential is not active'); // CIS4 CredentialStatus.Active
  const global = await retryTransient(() => node.grpc.getCryptographicParameters());
  return sdk.verifyPresentation(vp, global, publicData.map((p) => p.inputs));
}

const credIdsOf = (info) => Object.values(info?.accountCredentials || {})
  .map((c) => c?.value?.contents ?? c?.contents)
  .map((c) => String(c?.credId ?? c?.regId ?? '').toLowerCase())
  .filter(Boolean);

// The checks both proofs share, once the challenge is known: the presentation was made for it, holds one account
// credential, verifies (zero-knowledge proofs against the chain), that credential is one of `account`'s own, and the
// facts come from the verified statements only. Returns the verified result or { status: 'invalid', reason }.
async function checkPresentation({ vp, challenge, account, node, verify, now, whose }) {
  if (String(vp?.presentationContext || '').toLowerCase() !== challenge) return { status: 'invalid', reason: `the presentation was not made for this ${whose}` };
  const creds = vp.verifiableCredential || [];
  if (creds.length !== 1 || !String(creds[0]?.credentialSubject?.id || '').includes(':cred:')) return { status: 'invalid', reason: 'expected one account credential' };
  let verified;
  try { verified = await verify(vp); } catch (err) { return { status: 'invalid', reason: `the zero-knowledge proof does not verify (${String(err?.message || err).slice(0, 120)})` }; }
  if (String(verified?.challenge || '').toLowerCase() !== challenge) return { status: 'invalid', reason: 'verified for another challenge' };
  const credential = String(creds[0].credentialSubject.id).split(':cred:')[1].toLowerCase();
  const info = await node.accountInfo(account).catch(() => null);
  if (!info) return { status: 'invalid', reason: `the ${whose === 'paying account' ? 'paying' : 'payTo'} account could not be read` };
  if (!credIdsOf(info).includes(credential)) return { status: 'invalid', reason: `the proof comes from a credential that is not the ${whose === 'paying account' ? 'paying' : 'payTo'} account's` };
  const statements = (verified.credentialStatements || []).flatMap((c) => c?.statement || []);
  const facts = factsOf(statements, now());
  const issuer = String(creds[0].issuer || '').split(':idp:')[1];
  return { status: 'verified', facts, issuer: issuer !== undefined ? Number(issuer) : null, credential, created: vp.proof?.created ?? null };
}

export function createProofCheck({ network, node, get, verify = (vp) => verifyWithNode(node, NETWORK_NAME[network], vp), now = () => Date.now() }) {
  const networkName = NETWORK_NAME[network];
  return async function proofOf(origin, payTo) {
    let text;
    try { text = await get(`${origin}${PROOF_PATH}`); } catch { return null; } // no proof served
    let file;
    try { file = JSON.parse(text); } catch { return { status: 'invalid', reason: 'the proof file is not JSON' }; }
    if (file?.type !== 'concordium-x402-seller-proof' || file.version !== 1) return { status: 'invalid', reason: 'not a concordium-x402-seller-proof v1 file' };
    if (file.network !== networkName) return { status: 'invalid', reason: `the proof is for ${file.network}, not ${networkName}` };
    if (String(file.origin).toLowerCase() !== origin.toLowerCase()) return { status: 'invalid', reason: `the proof is tied to ${file.origin}, not ${origin}` };
    if (file.payTo !== payTo) return { status: 'invalid', reason: 'the proof is tied to another payTo' };
    const r = await checkPresentation({ vp: file.presentation, challenge: challengeFor(networkName, origin.toLowerCase(), payTo), account: payTo, node, verify, now, whose: 'site and payTo' });
    return r.status === 'verified' ? { ...r, created: r.created ?? file.created ?? null } : r;
  };
}

// --- The buyer's side ------------------------------------------------------------------------------------------------
// A seller can ask who stands behind the agent paying it: extra.buyerProof in its payment requirements lists the facts
// it needs (e.g. ["adult"] for an age-restricted service, ["eu-residence"] for an EU-only one). The agent's owner makes
// the proof once in their own wallet (x402 Doctor's /concordium-proof.html?role=buyer), for the challenge
//   sha256("concordium-x402-buyer-proof:v1|<network>|<account>")
// tied to the account the agent pays from, and the agent sends the file with its payments as
// paymentPayload.extensions["concordium-buyer-proof"]. It is no secret: from any other account it is worthless, because
// the credential that proved it must be one of the paying account's own, and the payment itself is signed by that
// account. Before sponsoring, the facilitator checks it the same way as the seller's proof, and that it proves every
// fact asked for.
export const BUYER_PROOF_EXTENSION = 'concordium-buyer-proof';
export const FACTS = ['adult', 'eu-residence', 'eu-nationality', 'id-document-valid'];
export const buyerChallengeFor = (network, account) => crypto.createHash('sha256').update(`concordium-x402-buyer-proof:v1|${network}|${account}`).digest('hex');

// The facts a seller's requirements ask the buyer to prove: [] when none, null when extra.buyerProof is malformed.
export function requiredBuyerFacts(requirements) {
  const want = requirements?.extra?.buyerProof;
  if (want === undefined || want === null) return [];
  const list = Array.isArray(want) ? want : Array.isArray(want?.facts) ? want.facts : null;
  if (!list || !list.length || !list.every((f) => FACTS.includes(f))) return null;
  return [...new Set(list)].sort();
}

// buyerProofOf(file, payer, required) -> { status: 'verified', account, facts, issuer, credential, created } or
// { status: 'missing' | 'invalid', reason }, with `required`. Verified answers are kept for ttlMs (the same file from the
// same account is checked against the chain once, not on every payment).
export function createBuyerProofCheck({ network, node, verify = (vp) => verifyWithNode(node, NETWORK_NAME[network], vp), now = () => Date.now(), ttlMs = 10 * 60 * 1000, max = 500 }) {
  const networkName = NETWORK_NAME[network];
  const cache = new Map(); // payer|sha256(presentation) -> { at, result }
  return async function buyerProofOf(file, payer, required = []) {
    const out = (r) => ({ ...r, required });
    if (!file) return out({ status: 'missing', reason: `send a buyer proof (paymentPayload.extensions["${BUYER_PROOF_EXTENSION}"]) made at https://x402-doctor.fizzl.eu/concordium-proof.html?role=buyer` });
    if (typeof file !== 'object' || file.type !== 'concordium-x402-buyer-proof' || file.version !== 1) return out({ status: 'invalid', reason: 'not a concordium-x402-buyer-proof v1 file' });
    if (file.network !== networkName) return out({ status: 'invalid', reason: `the proof is for ${file.network}, not ${networkName}` });
    if (file.account !== payer) return out({ status: 'invalid', reason: 'the proof is for another account than the one paying' });
    const key = `${payer}|${crypto.createHash('sha256').update(JSON.stringify(file.presentation ?? null)).digest('hex')}`;
    const hit = cache.get(key);
    let r = hit && now() - hit.at < ttlMs ? hit.result : null;
    if (!r) {
      r = await checkPresentation({ vp: file.presentation, challenge: buyerChallengeFor(networkName, payer), account: payer, node, verify, now, whose: 'paying account' });
      if (r.status === 'verified') {
        if (cache.size >= max) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), result: r });
      }
    }
    if (r.status !== 'verified') return out(r);
    const missing = required.filter((f) => !r.facts.includes(f));
    if (missing.length) return out({ status: 'invalid', reason: `the proof does not show ${missing.join(', ')} (it shows ${r.facts.join(', ') || 'nothing asked'})`, facts: r.facts });
    return out({ status: 'verified', account: payer, facts: r.facts, issuer: r.issuer, credential: r.credential, created: r.created ?? file.created ?? null });
  };
}
