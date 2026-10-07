// Pro paid in RLUSD on the XRP Ledger. No XRPL sign-in is needed: every account has its own destination
// tag, the customer sends RLUSD to the owner's XRPL account with that tag, and pastes the transaction hash.
// The server reads the transaction from a public XRPL node and counts what was delivered (delivered_amount,
// so a partial payment counts only what arrived) in RLUSD from Ripple's issuer, at $1 per RLUSD.
import { createHash } from "node:crypto";

export const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"; // Ripple, mainnet
const RIPPLE_EPOCH = 946684800; // XRPL dates count seconds from 2000-01-01
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export const isXrplAddress = (s) => typeof s === "string" && ADDRESS_RE.test(s);
export const isXrplHash = (s) => typeof s === "string" && /^[0-9A-Fa-f]{64}$/.test(s);

// The account's destination tag: a fixed number from its id (1 … 4294967295), shown on the plan card.
export function destinationTag(accountId) {
  const n = createHash("sha256").update(`fizzl-wallet-pro:${accountId}`).digest().readUInt32BE(0);
  return n === 0 ? 1 : n;
}

// "5", "5.25", "1e1" → micro-dollars (6 decimals), rounded down; null if it isn't a plain positive number.
function toUnits(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const [int, frac = ""] = n.toFixed(7).split(".");
  return BigInt(int) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, "0"));
}

// A validated XRPL `tx` result → { units, from, at (ms) } for RLUSD delivered to payTo with tag, or { error }.
export function rlusdPaid(tx, { payTo, tag, issuer = RLUSD_ISSUER }) {
  if (!tx || tx.error === "txnNotFound") return { error: "not_found" };
  if (!tx.validated) return { error: "not_validated" };
  const t = tx.tx_json ?? tx; // API v2 puts the fields in tx_json, v1 at the top
  const meta = tx.meta ?? {};
  if (meta.TransactionResult !== "tesSUCCESS") return { error: "failed" };
  if (t.TransactionType !== "Payment" || t.Destination !== payTo) return { error: "not_to_us" };
  if (Number(t.DestinationTag) !== tag) return { error: "wrong_tag" };
  const got = meta.delivered_amount ?? meta.DeliveredAmount;
  if (!got || typeof got !== "object" || got.issuer !== issuer || ![RLUSD_CURRENCY, "RLUSD"].includes(got.currency)) return { error: "not_rlusd" };
  const units = toUnits(got.value);
  if (!units) return { error: "not_rlusd" };
  const date = Number(t.date ?? tx.date);
  return { units, from: t.Account, at: Number.isFinite(date) ? (date + RIPPLE_EPOCH) * 1000 : null };
}
