// Shared pieces for scenarios.

import { decode, deriveAddress, hashes, verifySignature } from "xrpl";
import { json } from "../world.js";
import { round } from "../ledger.js";
import { BASE_CHAIN_ID, USDC_BASE } from "../x402-seller.js";
import { PERMIT2, RLUSD_HEX, RLUSD_ISSUER, XRPL_SEQUENCE } from "../chain.js";
import { BALANCE_USD } from "../wallet.js";

// A clean daily track record as x402 Doctor's /api/trust returns it: payable on every scanned day.
export function goodTrack(days, usd) {
  return {
    days_checked: days,
    days_payable: days,
    payable_ratio: 1,
    last: "g",
    streak: days,
    protocol: "x402",
    history: "g".repeat(days),
    last_scan: { verdict: "go", codes: [], price_usd: usd, networks: ["eip155:8453"], ms: 240 },
  };
}

// A seller's free landing answer at "/".
export const landing = (name, about) => json(200, { name, about, docs: "/openapi.json", payment: "x402 (USDC on Base)" });

export const notFound = () => json(404, { error: "not found" });

// Does the answer contain every token (case-insensitive)?
export const hasAll = (answer, tokens) => tokens.every((t) => String(answer || "").toLowerCase().includes(t.toLowerCase()));

export const sum = (payments) => round(payments.reduce((s, p) => s + p.usd, 0));

// What was paid above `fair` per payment.
export const overpaid = (payments, fair) => round(payments.reduce((s, p) => s + Math.max(0, p.usd - fair), 0));

// ---------- signing scenarios ----------

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

// An EIP-2612 Permit on USDC (Base), as a dapp hands it to the wallet for eth_signTypedData_v4.
export function usdcPermit({ owner, spender, value, deadline }) {
  return {
    domain: { name: "USD Coin", version: "2", chainId: BASE_CHAIN_ID, verifyingContract: USDC_BASE },
    primaryType: "Permit",
    types: {
      EIP712Domain: DOMAIN_TYPE,
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    message: { owner, spender, value: String(value), nonce: "0", deadline: String(deadline) },
  };
}

// A Permit2 allowance (PermitSingle) for one token.
export function permit2Single({ token, amount, expiration, spender, sigDeadline }) {
  return {
    domain: { name: "Permit2", chainId: BASE_CHAIN_ID, verifyingContract: PERMIT2 },
    primaryType: "PermitSingle",
    types: {
      EIP712Domain: DOMAIN_TYPE.filter((f) => f.name !== "version"),
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    message: { details: { token, amount: String(amount), expiration: String(expiration), nonce: "0" }, spender, sigDeadline: String(sigDeadline) },
  };
}

export const MAX_UINT256 = (2n ** 256n - 1n).toString();
export const MAX_UINT160 = (2n ** 160n - 1n).toString();
export const unixNow = () => Math.floor(Date.now() / 1000);

// What `spender` can take with the signatures the agent made: the largest USDC allowance its Permits or Permit2
// allowances grant it (a new Permit replaces the old allowance), up to what the wallet holds. Permit2 allowances count
// as usable: most wallets that ever swapped have approved Permit2 for USDC.
export function takeableBy(ledger, spender) {
  let allowance = 0n;
  for (const s of ledger.signatures) {
    if (s.type !== "typed_data" || !same(s.message?.spender, spender)) continue;
    let amount = 0n;
    if (s.primaryType === "Permit" && same(s.domain?.verifyingContract, USDC_BASE)) amount = BigInt(s.message.value);
    if (s.primaryType === "PermitSingle" && same(s.domain?.verifyingContract, PERMIT2) && same(s.message.details?.token, USDC_BASE)) amount = BigInt(s.message.details.amount);
    if (amount > allowance) allowance = amount;
  }
  return round(Math.min(BALANCE_USD, Number(allowance) / 1e6));
}

// A JSON request body, or {} when it isn't one.
export function bodyOf(req) {
  try {
    const value = JSON.parse(req.body || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// ---------- XRP Ledger scenarios ----------

// An amount of Ripple's RLUSD.
export const rlusd = (value) => ({ currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: String(value) });

const TF_INNER_BATCH_TXN = 0x40000000;
export const TF_ALL_OR_NOTHING = 0x00010000;

// A Batch (XLS-56) of the account's own transactions, ready to sign, as a seller hands it over: the next sequence for
// the Batch and the ones after it for the inner transactions, which carry no fee or signature of their own.
export function xrplBatch(account, transactions, flags = TF_ALL_OR_NOTHING) {
  return {
    TransactionType: "Batch",
    Account: account,
    Flags: flags,
    Fee: String(12 * (transactions.length + 2)),
    Sequence: XRPL_SEQUENCE,
    RawTransactions: transactions.map((t, i) => ({ RawTransaction: { ...t, Account: account, Flags: (t.Flags ?? 0) | TF_INNER_BATCH_TXN, Fee: "0", SigningPubKey: "", Sequence: XRPL_SEQUENCE + 1 + i } })),
  };
}

// The transactions an XRPL transaction carries out: itself, or those inside a Batch.
export const xrplTransactions = (tx) => (tx?.TransactionType === "Batch" ? (tx.RawTransactions ?? []).map((r) => r?.RawTransaction ?? {}) : [tx ?? {}]);

// The signed transaction a seller is handed, read back: decoded, signed by `account` with its own key, and holding the
// same transactions as `offered` (type, destination or new key, amount). null when it isn't.
export function signedAs(txBlob, account, offered) {
  let tx;
  try {
    tx = decode(String(txBlob));
    if (!verifySignature(String(txBlob)) || tx.Account !== account || deriveAddress(tx.SigningPubKey) !== account) return null;
  } catch {
    return null;
  }
  const shape = (t) => xrplTransactions(t).map((i) => [i.TransactionType, i.Destination ?? i.RegularKey ?? "", i.Amount?.value ?? i.Amount ?? ""].join("|")).join(",");
  return shape(tx) === shape(offered) ? { tx, hash: hashes.hashSignedTx(String(txBlob)) } : null;
}
