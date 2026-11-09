// The payments this facilitator sponsored, read from the chain (Concordium's wallet proxy lists, per account, the
// transactions it sponsored, with the fee it paid), so the page's numbers survive restarts and include every payment
// the sponsor account paid for, whichever process submitted it. Cached for ttlMs; a failed read keeps the last answer.
export const WALLET_PROXY = {
  'ccd:9dd9ca4d19e9393877d2c44b70f89acb': 'https://wallet-proxy.mainnet.concordium.software',
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': 'https://wallet-proxy.testnet.concordium.com',
};

// One wallet-proxy transaction, if this sponsor paid for it: what moved, between whom, and the fee.
export function sponsoredPayment(t, sponsor) {
  if (t?.sponsor?.sponsor !== sponsor || !t.transactionHash) return null;
  const d = t.details || {};
  const ccd = d.type === 'transfer' || d.type === 'transferWithMemo';
  const token = !ccd ? tokenTransfer(d) : null;
  return {
    tx: t.transactionHash,
    time: Number.isFinite(t.blockTime) ? new Date(t.blockTime * 1000).toISOString() : null,
    ok: d.outcome === 'success',
    from: d.transferSource ?? t.origin?.address ?? null,
    to: d.transferDestination ?? token?.to ?? null,
    asset: ccd ? 'CCD' : token?.asset ?? null,
    amount: ccd ? fromAtomic(d.transferAmount, 6) : token?.amount ?? null,
    fee_ccd: fromAtomic(t.sponsor.cost, 6),
  };
}

// A PLT transfer as the wallet proxy describes it ("Transferred 0.01 EURR from … to …"), when it does.
function tokenTransfer(d) {
  for (const e of d.events || []) {
    const m = /^Transferred ([\d.]+) ([A-Za-z0-9._-]+) from \S+ to (\S+)/.exec(String(e));
    if (m && m[2] !== 'CCD') return { amount: m[1], asset: m[2], to: m[3] };
  }
  return null;
}

function fromAtomic(v, decimals) {
  if (v === undefined || v === null || !/^-?\d+$/.test(String(v))) return null;
  const s = String(v).replace('-', '').padStart(decimals + 1, '0');
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '');
  return out || '0';
}

export function createHistory({ network, sponsor, url = WALLET_PROXY[network], fetch = globalThis.fetch, ttlMs = 60_000, now = () => Date.now(), limit = 100 } = {}) {
  let cached = null, at = 0, pending = null;
  async function load() {
    const res = await fetch(`${url}/v0/accTransactions/${encodeURIComponent(sponsor)}?limit=${limit}&order=descending`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`wallet proxy ${res.status}`);
    const body = await res.json();
    const payments = (body.transactions || []).map((t) => sponsoredPayment(t, sponsor)).filter(Boolean);
    const today = new Date(now()).toISOString().slice(0, 10);
    return {
      sponsored: payments.filter((p) => p.ok).length,
      sponsored_today: payments.filter((p) => p.ok && p.time?.startsWith(today)).length,
      fees_ccd: fromAtomic(String(payments.reduce((s, p) => s + Math.round(Number(p.fee_ccd || 0) * 1e6), 0)), 6),
      recent: payments.slice(0, 10),
      partial: (body.transactions || []).length >= limit, // only the latest `limit` transactions were read
    };
  }
  return {
    // The latest known history, or null when none could be read yet.
    async get() {
      if (!url || !sponsor) return null;
      if (cached && now() - at < ttlMs) return cached;
      pending ??= load().then((h) => { cached = h; at = now(); return h; }).catch(() => cached).finally(() => { pending = null; });
      return pending;
    },
  };
}

// Sums decimal strings exactly ("0.001" + "0.25" = "0.251").
function addDecimals(a, b) {
  const d = Math.max((a.split('.')[1] || '').length, (b.split('.')[1] || '').length);
  const scale = (s) => BigInt((s.split('.')[0] || '0') + (s.split('.')[1] || '').padEnd(d, '0'));
  return fromAtomic(String(scale(a) + scale(b)), d) ?? '0';
}

// An agent's statement: everything one paying account paid through this facilitator, read from that account's own
// history on chain (so it holds after restarts and needs no log of ours), and who each payee is, from the payee's
// identity credential (`identity`, src/identity.js). The owner of an agent, or anyone auditing it, sees what it paid,
// to whom, how much in all, and whether each payee is backed by a verified identity.
// statementOf(account) -> { account, network, sponsor, payments, totals, payees, partial }.
export function createStatement({ network, sponsor, url = WALLET_PROXY[network], fetch = globalThis.fetch, identity = null, ttlMs = 60_000, now = () => Date.now(), limit = 100, maxPayees = 20 } = {}) {
  const cache = new Map();
  async function load(account) {
    const res = await fetch(`${url}/v0/accTransactions/${encodeURIComponent(account)}?limit=${limit}&order=descending`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`wallet proxy ${res.status}`);
    const body = await res.json();
    // Only transfers this account sent and this facilitator sponsored.
    const payments = (body.transactions || []).map((t) => sponsoredPayment(t, sponsor)).filter((p) => p && p.from === account)
      .map(({ fee_ccd, from, ...p }) => ({ ...p, sponsor_fee_ccd: fee_ccd }));
    const paid = payments.filter((p) => p.ok && p.asset && p.amount !== null);
    const totals = new Map();
    for (const p of paid) {
      const t = totals.get(p.asset) ?? { asset: p.asset, amount: '0', count: 0 };
      totals.set(p.asset, { ...t, amount: addDecimals(t.amount, p.amount), count: t.count + 1 });
    }
    const byPayee = new Map();
    for (const p of paid) byPayee.set(p.to, (byPayee.get(p.to) ?? 0) + 1);
    const payees = await Promise.all([...byPayee].sort((a, b) => b[1] - a[1]).slice(0, maxPayees).map(async ([to, count]) => {
      const id = identity ? await identity.check({ resourceUrl: null, payTo: to }).catch(() => null) : null;
      return { account: to, payments: count, identity: id?.outcome ?? 'not-read', ...(id?.credential ? { provider: id.credential.provider, validTo: id.credential.validTo, expired: id.credential.expired } : {}) };
    }));
    return { account, network, sponsor, payments, totals: [...totals.values()], payees, partial: (body.transactions || []).length >= limit };
  }
  return async function statementOf(account) {
    const hit = cache.get(account);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load(account);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(account, { at: now(), value });
    return value;
  };
}
