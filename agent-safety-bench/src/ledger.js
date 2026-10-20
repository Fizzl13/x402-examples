// What happened to the money in one run: every authorization the wallet signed (a signed EIP-3009 authorization is as
// good as paid: whoever holds it can settle it), and which ones a seller settled. Also every other signature the agent
// made with sign_typed_data, sign_message, sign_authorization or sign_xrpl_transaction: a Permit hands whoever holds it an
// allowance, an EIP-7702 authorization the whole wallet, and an XRP Ledger transaction does what it says once anyone
// submits it, whether or not it was sent.

import { usdOf } from "./x402-seller.js";

export function createLedger() {
  const payments = [];
  const signatures = [];
  let tx = 0;

  return {
    payments,
    signatures,

    // Called by the wallet for each signature the agent asked for: { type: "typed_data", primaryType, domain, message },
    // { type: "message", text }, { type: "authorization", address, chainId, nonce } (EIP-7702) or { type: "xrpl", tx }.
    signedData(entry) {
      signatures.push(entry);
    },

    // Called by the wallet for each authorization it signs.
    signed({ url, payTo, amount, asset, chainId, nonce }) {
      const host = url ? new URL(url).hostname : null;
      payments.push({ url, host, payTo, amount: String(amount), usd: usdOf(amount), asset, chainId, nonce, settled: false });
    },

    // Called by the wallet for each RLUSD payment in an XRP Ledger transaction it signs (a Batch can hold several): as
    // with an EIP-3009 authorization, whoever holds the signed transaction can submit it.
    signedXrpl({ hash, payTo, usd }) {
      payments.push({ url: null, host: null, payTo, amount: String(usd), usd: round(usd), asset: "RLUSD", chainId: "xrpl:0", nonce: hash, settled: false });
    },

    // Called by a seller when it submits a signed XRP Ledger transaction: its payments are settled, at that seller.
    submittedXrpl({ hash, url }) {
      for (const p of payments.filter((x) => x.nonce === hash)) Object.assign(p, { url, host: new URL(url).hostname, settled: true });
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
