// Who is being paid: what Concordium can say about a seller before this facilitator sponsors a payment to it. Two
// sources, both read-only:
//
// 1. The payTo account's own identity credential (every Concordium account is opened from an identity a regulated
//    identity provider verified): which provider, and whether the credential is still valid (policy.validTo, YYYYMM).
//    Read from the node; nothing about the person is shown beyond what the account itself reveals on chain.
// 2. The seller's agent in Concordium's Agent Registry (CIS-8004): the Agent Card at the paid resource's origin
//    (/.well-known/agent-card.json) carries a Concordium badge; the registry says whether that agent is Active, whether
//    its anchored card still hashes to the metadata_hash on chain, whether the card lists this origin, and whether the
//    payTo is the agent wallet it registered. The same rules as x402 Doctor's payee check (lib/concordium-agent.js).
//
// Outcome (one word, never a score):
//   verified-agent   payTo is the agent wallet of an active, registered agent whose anchored card lists this origin
//   identity-backed  no verified agent, but payTo is an account with a valid identity credential
//   expired          payTo's identity credential has expired
//   not-read         nothing could be read (node or registry unreachable): never counted as a pass or a fail
// with `agent` ({ outcome, tokenAddress, tokenId, status, agentWallet, reason }) when the seller shows a badge.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const REGISTRY = 'https://agent-registry-mcp.concordium.com/mcp';
const NET_ID = { 'ccd:9dd9ca4d19e9393877d2c44b70f89acb': 'mainnet', 'ccd:4221332d34e1694168c2a0c0b3fd0f27': 'testnet' };
const REGISTRY_INDEX = { mainnet: 10082, testnet: 12802 }; // the official CIS-8004 contracts
const BADGE_EXTENSION = 'concordium-badge/v1';
const MAX_BYTES = 64 * 1024;

const sha256Hex = (text) => crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  let n = 0n;
  for (const ch of String(s)) { const i = ALPHABET.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of String(s)) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
// The registry a CIS-2 token address (badge) belongs to: version byte 2, then the contract index as LEB128.
export function badgeNetwork(tokenAddress) {
  const b = base58Decode(tokenAddress);
  if (!b || b.length < 7 || b[0] !== 2) return null;
  let index = 0, shift = 0;
  for (let i = 1; i < b.length - 4 && i < 10; i += 1) {
    index += (b[i] & 0x7f) * 2 ** shift; shift += 7;
    if (!(b[i] & 0x80)) return Object.keys(REGISTRY_INDEX).find((k) => REGISTRY_INDEX[k] === index) ?? null;
  }
  return null;
}
export function cardBadge(card) {
  const ext = (card?.capabilities?.extensions || []).find((e) => typeof e?.uri === 'string' && e.uri.includes(BADGE_EXTENSION));
  const p = ext?.params || card?.concordium || null;
  if (!p || typeof p !== 'object') return null;
  const raw = p.tokenAddress || p.token_address || p.badge || p.id || null;
  const short = typeof raw === 'string' && raw.includes('/cis-2:') ? raw.split('/cis-2:')[1] : raw;
  return typeof short === 'string' && /^[1-9A-HJ-NP-Za-km-z]{8,40}$/.test(short) ? short : null;
}
export function cardOrigins(card) {
  const urls = [card?.url, ...(card?.supportedInterfaces || []).map((i) => i?.url), ...(card?.services || []).map((s) => s?.endpoint), ...(card?.endpoints || []).map((s) => s?.endpoint)];
  const out = new Set();
  for (const u of urls) { try { const x = new URL(u); if (x.protocol === 'https:') out.add(x.origin.toLowerCase()); } catch { /* not a URL */ } }
  return out;
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivateIp(v.slice(7));
}

// A small, careful GET for URLs a caller names (the seller's origin, its agent_uri): https only, a public host,
// no redirects, at most 64 KB, a few seconds.
export function createSafeGet({ fetch = globalThis.fetch, lookup = (h) => dns.lookup(h, { all: true }), timeoutMs = 5000, allowPrivate = false } = {}) {
  return async function get(url) {
    const u = new URL(url);
    if (!allowPrivate) {
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error('not a public https URL');
      const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname);
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('not a public host');
    }
    const res = await fetch(u.href, { headers: { accept: 'application/json', 'user-agent': 'concordium-x402-facilitator' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('too large');
    return text;
  };
}

async function registryCall(tool, args, { fetch, url }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'concordium-x402-facilitator' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  let text = await res.text();
  if (/^\s*(event|data):/.test(text)) text = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  const body = JSON.parse(text);
  if (body.error || body.result?.isError) throw new Error('registry error');
  const out = (body.result?.content || []).map((c) => c.text || '').join('');
  return out && out !== 'null' ? JSON.parse(out) : null;
}

// The payTo account's identity credential, from its account info (node.accountInfo).
export function credentialOf(info, providers = new Map(), now = Date.now()) {
  const creds = Object.values(info?.accountCredentials || {}).map((c) => c?.value?.contents ?? c?.contents).filter(Boolean);
  if (!creds.length) return null;
  const c = creds[0];
  const validTo = String(c.policy?.validTo ?? '');
  const m = /^(\d{4})(\d{2})$/.exec(validTo);
  // Valid through the end of its validTo month.
  const expired = m ? now >= Date.UTC(Number(m[1]), Number(m[2]), 1) : false;
  return {
    provider: providers.get(c.ipIdentity) ?? `identity provider ${c.ipIdentity}`,
    validTo: m ? `${m[1]}-${m[2]}` : null,
    expired,
    revealed: Object.keys(c.policy?.revealedAttributes || {}).length ? c.policy.revealedAttributes : null,
  };
}

export function createIdentity({ network, node, fetch = globalThis.fetch, get = createSafeGet({ fetch }), registry = REGISTRY, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const netId = NET_ID[network];
  const cache = new Map();
  let providers = null;
  async function providerNames() {
    if (providers) return providers;
    const m = new Map();
    try { for await (const ip of node.identityProviders()) m.set(ip.ipIdentity, ip.ipDescription?.name || `identity provider ${ip.ipIdentity}`); } catch { return m; }
    providers = m;
    return m;
  }

  async function agentOf(resourceUrl, payTo) {
    let origin;
    try { origin = new URL(resourceUrl).origin.toLowerCase(); } catch { return null; }
    let card;
    try { card = JSON.parse(await get(`${origin}/.well-known/agent-card.json`)); } catch { return null; }
    const badge = cardBadge(card);
    if (!badge) return null;
    const out = { tokenAddress: badge };
    if (badgeNetwork(badge) !== netId) return { ...out, outcome: 'other-network', reason: `the badge is not an agent of the ${netId} registry` };
    let a;
    try { a = await registryCall('agent_by_token_address', { token_address: badge, network: netId }, { fetch, url: registry }); } catch (err) { return { ...out, outcome: 'not-read', reason: err.message }; }
    if (!a) return { ...out, outcome: 'not-read', reason: 'no such agent in the registry' };
    Object.assign(out, { tokenId: a.token_id ?? null, status: a.status ?? null, agentWallet: a.agent_wallet ?? null });
    if (a.status !== 'Active') return { ...out, outcome: 'revoked', reason: `registry status ${a.status}` };
    let anchored = null;
    try {
      const text = await get(a.agent_uri);
      if (sha256Hex(text) !== String(a.metadata_hash_hex || '').toLowerCase()) return { ...out, outcome: 'card-mismatch', reason: 'the card at agent_uri does not hash to the metadata_hash on chain' };
      anchored = JSON.parse(text);
    } catch { return { ...out, outcome: 'not-read', reason: 'the anchored card could not be read' }; }
    let uriOrigin = null;
    try { uriOrigin = new URL(a.agent_uri).origin.toLowerCase(); } catch { /* none */ }
    if (uriOrigin !== origin && !cardOrigins(anchored).has(origin)) return { ...out, outcome: 'endpoint-unlisted', reason: `the agent's card does not list ${origin}` };
    if (a.agent_wallet && a.agent_wallet === payTo) return { ...out, outcome: 'verified-wallet' };
    if (!a.agent_wallet && a.owner_account === payTo) return { ...out, outcome: 'owner-only', reason: 'payTo is the agent\'s owner; no agent wallet is set' };
    return { ...out, outcome: 'mismatch', reason: 'payTo is not the agent\'s registered wallet' };
  }

  return {
    // What Concordium says about the seller of `resourceUrl` paid at `payTo`. Cached per (origin, payTo).
    async check({ resourceUrl, payTo }) {
      let origin = '';
      try { origin = new URL(resourceUrl).origin; } catch { /* none */ }
      const key = `${origin}|${payTo}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const [info, names] = await Promise.all([node.accountInfo(payTo).catch(() => null), providerNames()]);
      const credential = credentialOf(info, names, now());
      const agent = resourceUrl ? await agentOf(resourceUrl, payTo).catch(() => null) : null;
      const outcome = agent?.outcome === 'verified-wallet' ? 'verified-agent'
        : credential?.expired ? 'expired'
          : credential ? 'identity-backed' : 'not-read';
      const value = { outcome, ...(credential ? { credential } : {}), ...(agent ? { agent } : {}) };
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), value });
      return value;
    },
  };
}
