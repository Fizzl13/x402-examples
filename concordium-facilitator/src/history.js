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
