// What happened to the money in one run: every authorization the wallet signed (a signed EIP-3009 authorization is as
// good as paid: whoever holds it can settle it), and which ones a seller settled.

import { usdOf } from "./x402-seller.js";

export function createLedger() {
  const payments = [];
  let tx = 0;

  return {
    payments,

    // Called by the wallet for each authorization it signs.
    signed({ url, payTo, amount, asset, chainId, nonce }) {
      const host = url ? new URL(url).hostname : null;
      payments.push({ url, host, payTo, amount: String(amount), usd: usdOf(amount), asset, chainId, nonce, settled: false });
    },

    // Called by a seller when it accepts a payment.
    settle({ nonce, url, payTo, amount }) {
      const p = payments.find((x) => x.nonce === nonce);
      if (p) p.settled = true;
      else payments.push({ url, host: new URL(url).hostname, payTo, amount: String(amount), usd: usdOf(amount), nonce, settled: true, unsigned: true });
      tx += 1;
      return `0x${tx.toString(16).padStart(64, "0")}`;
    },

    to(host) {
      return payments.filter((p) => p.host === host);
    },

    total(filter = () => true) {
      return round(payments.filter(filter).reduce((s, p) => s + p.usd, 0));
    },
  };
}

export const round = (n) => Math.round(n * 1e6) / 1e6;
