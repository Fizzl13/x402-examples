// Buy USDC on Base with a card (Coinbase Onramp), only for someone this server has checked: a signed-in owner (for
// their own wallet or one of their agents' wallets) or an agent with its key (for its own linked wallet). x402 Doctor
// holds the CDP key and starts the Coinbase session; it does that only for this server (ONRAMP_KEY, the same on both).
// The buyer pays Coinbase in Coinbase's own checkout and Coinbase sends the USDC; Fizzl never holds the money.
// Coinbase binds each session to the buyer's IP (clientIp): this server passes the IP of the request that asked
// (req.ip: with trust proxy at Render's hop count, the entry its proxy wrote, which a client can't set).

import { isIP } from "node:net";

export const ONRAMP_URL = "https://x402-doctor.fizzl.eu/api/onramp";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

export function createOnramp({ key = null, url = ONRAMP_URL, fetch = globalThis.fetch, now = Date.now, perHour = 10 } = {}) {
  const tries = new Map(); // account -> { n, since }
  const tooMany = (who) => {
    const t = now(), h = tries.get(who);
    if (!h || t - h.since > 3_600_000) { tries.set(who, { n: 1, since: t }); if (tries.size > 10_000) tries.clear(); return false; }
    return ++h.n > perHour;
  };
  return {
    enabled: !!key,
    /** A Coinbase checkout URL (single use, 5 minutes) for USDC on Base to `address`. `who` is the account, for the limit;
     *  `clientIp` the buyer's IP, which Coinbase binds the session to. */
    async link(who, address, amount = 5, clientIp = null) {
      if (!key) throw fail(503, "Buying with a card isn't set up on this server.");
      if (!ADDRESS.test(String(address ?? ""))) throw fail(400, "address: a wallet address on Base (0x…)");
      const usd = Math.round(Number(amount ?? 5));
      if (!(usd >= 1 && usd <= 500)) throw fail(400, "amount: between 1 and 500 dollars");
      if (tooMany(String(who))) throw fail(429, "Too many purchases started this hour. Try again later.");
      let r, j;
      try {
        const ip = String(clientIp ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
        r = await fetch(`${url}?${new URLSearchParams({ address, amount: String(usd), ...(isIP(ip) ? { client_ip: ip } : {}) })}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        j = await r.json().catch(() => null);
      } catch (err) { console.warn(`[onramp] ${err.message}`); }
      if (!r?.ok || typeof j?.url !== "string" || !j.url.startsWith("https://pay.coinbase.com/")) {
        if (r) console.warn(`[onramp] Doctor answered ${r.status}: ${j?.error ?? "no checkout URL"}`);
        throw fail(502, "Coinbase could not start a purchase right now; try again in a minute.");
      }
      return { url: j.url, address, network: "base", asset: "USDC", amount_usd: usd, expires_in_s: 300 };
    },
  };
}
