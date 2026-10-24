// Connector payments on the XRP Ledger, signed in Xaman (src/connector-pay.js uses this). The API's x402 offer in
// RLUSD becomes an XRPL Payment that Xaman shows the owner (pushed to their phone once they have signed one, else a
// link or QR code); Xaman signs it without submitting it, and the signed blob is the x402 payment (@x402/xrpl's
// format: { signedTxBlob }, the invoice bound in InvoiceID). Its LastLedgerSequence keeps it valid only for the
// seller's time limit, so a signature that comes too late pays nothing.
import { createHash } from "node:crypto";
import { decode, verifySignature, hashes } from "xrpl";

export const XRPL_MAINNET = "xrpl:0";
export const RLUSD_HEX = "524C555344000000000000000000000000000000";
export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"; // Ripple, mainnet
const XAMAN_API = "https://xumm.app/api/v1/platform";
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const TF_PARTIAL_PAYMENT = 0x00020000;
// As @x402/xrpl's facilitator counts: the seller's time limit in 5-second ledgers, plus 2. Ledgers close faster
// (about every 3.5 seconds), so the window in time is shorter; LEDGER_S is what is said to the owner.
const LEDGER_S = 3.5;

export const isXrplAddress = (s) => typeof s === "string" && ADDRESS_RE.test(s);
const hexText = (t) => Buffer.from(String(t), "utf8").toString("hex").toUpperCase();
const currencyHex = (c) => (/^[0-9A-Fa-f]{40}$/.test(c) ? c.toUpperCase() : String(c).length === 3 ? String(c) : hexText(c).padEnd(40, "0"));
// "0.01" -> 10000n at 6 decimals (rounded down), or at 15 for comparing amounts exactly; null if not a plain number.
export function decimalUnits(value, decimals = 6) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? ""));
  if (!m) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").slice(0, decimals).padEnd(decimals, "0") || "0");
}
export const invoiceField = (invoiceId) => createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();

// The RLUSD-on-XRPL "exact" offer in an x402 v2 challenge: mainnet, Ripple's issuer, an amount in dollars, and the
// payer pays the XRPL fee (a sponsored-fee offer needs a flow this doesn't have). null: none.
export function xrplOffer(challenge) {
  if (!challenge || Number(challenge.x402Version) !== 2 || !Array.isArray(challenge.accepts)) return null;
  for (const a of challenge.accepts) {
    if (a?.scheme !== "exact" || a.network !== XRPL_MAINNET || typeof a.asset !== "string" || currencyHex(a.asset) !== RLUSD_HEX) continue;
    const extra = a.extra ?? {};
    if (extra.issuer !== RLUSD_ISSUER || extra.areFeesSponsored === true || !isXrplAddress(a.payTo)) continue;
    const units = decimalUnits(a.amount);
    if (!units || units <= 0n || !/^\d+(\.\d{1,15})?$/.test(String(a.amount))) continue;
    const tag = (v) => (v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 0xffffffff ? Number(v) : undefined);
    return {
      network: XRPL_MAINNET, accepted: a, resource: challenge.resource ?? null, amount: String(a.amount), units: String(units), price: Number(a.amount), payTo: a.payTo,
      invoiceId: typeof extra.invoiceId === "string" && extra.invoiceId ? extra.invoiceId : null,
      sourceTag: tag(extra.sourceTag), destinationTag: tag(extra.destinationTag),
      maxTimeoutSeconds: Math.min(600, Math.max(30, Number(a.maxTimeoutSeconds) || 60)),
    };
  }
  return null;
}

// How many ledgers the signature may take (the facilitator refuses a later LastLedgerSequence), and about how long.
export function signWindow(offer) {
  const ledgers = Math.ceil(offer.maxTimeoutSeconds / 5) + 2;
  return { ledgers, seconds: Math.floor(ledgers * LEDGER_S) };
}

// The Payment Xaman shows: Xaman fills in the signer's Account, Sequence and Fee.
export function paymentTx(offer, lastLedger) {
  const amount = { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: offer.amount };
  return {
    TransactionType: "Payment", Destination: offer.payTo, Amount: amount, SendMax: amount,
    ...(offer.invoiceId ? { InvoiceID: invoiceField(offer.invoiceId) } : {}),
    ...(offer.destinationTag !== undefined ? { DestinationTag: offer.destinationTag } : {}),
    ...(offer.sourceTag !== undefined ? { SourceTag: offer.sourceTag } : {}),
    LastLedgerSequence: lastLedger,
  };
}

// The signed blob Xaman returned, against what was asked: a single-signed Payment of exactly this RLUSD to this
// payee, with this invoice and ledger limit, no partial payment, no paths. { tx, hash } or { error }.
export function checkSigned(blob, offer, lastLedger) {
  let tx;
  try { tx = decode(blob); } catch { return { error: "Xaman sent back something that isn't a transaction." }; }
  const wrong = (what) => ({ error: `The signed transaction has another ${what} than was asked. Nothing was paid.` });
  if (tx.TransactionType !== "Payment") return wrong("type");
  if (tx.Destination !== offer.payTo) return wrong("payee");
  for (const k of ["Amount", "SendMax"]) {
    const a = tx[k];
    if (!a || typeof a !== "object" || a.issuer !== RLUSD_ISSUER || currencyHex(a.currency) !== RLUSD_HEX || decimalUnits(a.value, 15) !== decimalUnits(offer.amount, 15)) return wrong("amount");
  }
  if ((Number(tx.Flags) & TF_PARTIAL_PAYMENT) !== 0 || tx.Paths || tx.DeliverMin) return wrong("kind of payment");
  if ((tx.InvoiceID ?? null) !== (offer.invoiceId ? invoiceField(offer.invoiceId) : null)) return wrong("invoice");
  if ((tx.DestinationTag ?? undefined) !== offer.destinationTag) return wrong("destination tag");
  if (tx.LastLedgerSequence !== lastLedger) return wrong("time limit");
  if (!isXrplAddress(tx.Account) || tx.Signers || !tx.TxnSignature) return wrong("signer");
  let ok = false;
  try { ok = verifySignature(blob); } catch { ok = false; }
  if (!ok) return { error: "The signature on that transaction doesn't check out. Nothing was paid." };
  return { tx, hash: hashes.hashSignedTx(blob) };
}

// Xaman's platform API (an app's key and secret from apps.xumm.dev): sign requests and their results.
export function createXaman({ apiKey, apiSecret, fetch: fetchImpl = globalThis.fetch }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${XAMAN_API}${path}`, {
      method, headers: { "x-api-key": apiKey, "x-api-secret": apiSecret, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new Error(`Xaman answered HTTP ${res.status}${j?.error?.reference ? ` (${j.error.reference})` : ""}`);
    return j;
  };
  return {
    // A sign request: pushed to the owner's Xaman when userToken is theirs, else opened with the link or QR code.
    async create({ txjson, expireMinutes, returnUrl, instruction, userToken }) {
      const j = await call("POST", "/payload", {
        txjson,
        options: { submit: false, expire: expireMinutes, force_network: "MAINNET", ...(returnUrl ? { return_url: { app: returnUrl, web: returnUrl } } : {}) },
        custom_meta: { instruction: String(instruction).slice(0, 280) },
        ...(userToken ? { user_token: userToken } : {}),
      });
      if (typeof j.uuid !== "string" || !/^[0-9a-f-]{36}$/.test(j.uuid)) throw new Error("Xaman gave no sign request");
      return { uuid: j.uuid, url: j.next?.always ?? `https://xumm.app/sign/${j.uuid}`, qr: j.refs?.qr_png ?? `https://xumm.app/sign/${j.uuid}_q.png`, pushed: !!j.pushed };
    },
    // Where a sign request stands: open, signed (with the blob, the signer, and a token to push the next one), or not.
    async get(uuid) {
      const j = await call("GET", `/payload/${encodeURIComponent(uuid)}`);
      const m = j.meta ?? {};
      if (m.signed && typeof j.response?.hex === "string") return { state: "signed", blob: j.response.hex, account: j.response.account ?? null, userToken: j.application?.issued_user_token ?? null };
      if (m.cancelled || (m.resolved && !m.signed)) return { state: "declined" };
      if (m.expired) return { state: "expired" };
      return { state: "open" };
    },
    async cancel(uuid) { await call("DELETE", `/payload/${encodeURIComponent(uuid)}`).catch(() => {}); },
  };
}

// The few XRPL reads needed: the last validated ledger, and an account's RLUSD balance (null: couldn't be read).
export function createXrplReader({ rpcUrl = "https://xrplcluster.com", fetch: fetchImpl = globalThis.fetch } = {}) {
  const rpc = async (method, params) => (await (await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(10_000) })).json()).result;
  return {
    async ledger() {
      const r = await rpc("ledger", { ledger_index: "validated" });
      const n = Number(r?.ledger_index ?? r?.ledger?.ledger_index);
      if (!Number.isInteger(n) || n <= 0) throw new Error("the XRP Ledger can't be read right now");
      return n;
    },
    async rlusd(account) {
      try {
        const r = await rpc("account_lines", { account, peer: RLUSD_ISSUER, ledger_index: "validated" });
        if (r?.error === "actNotFound") return 0n;
        if (!Array.isArray(r?.lines)) return null;
        const line = r.lines.find((l) => currencyHex(l.currency) === RLUSD_HEX);
        return line && !String(line.balance).startsWith("-") ? decimalUnits(line.balance) ?? 0n : 0n;
      } catch { return null; }
    },
    // Whether a signed Payment was validated (true), isn't on the ledger (false), or it can't tell right now (null).
    async landed(hash) {
      try {
        const r = await rpc("tx", { transaction: hash });
        if (r?.error === "txnNotFound") return false;
        if (!r?.validated) return null;
        return r.meta?.TransactionResult === "tesSUCCESS";
      } catch { return null; }
    },
  };
}
