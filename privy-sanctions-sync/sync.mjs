#!/usr/bin/env node
// Keeps Privy condition sets for EVM, Solana and the XRP Ledger in step with the OFAC SDN list.
// They are the denylists behind the policy in Privy's recipe "Sanctions screening for x402 payments"
// (https://docs.privy.io/recipes/agent-integrations/x402-sanctions-screening).
//
// The list is presign-guard's free open copy of the US Treasury's SDN digital currency addresses
// (GET https://presign-guard.fizzl.eu/v1/sanctions, re-checked every 6 hours). Each Solana address
// also carries its USDC and USDT token accounts: a Solana token transfer names that account, not the
// owner, so the recipe's TransferChecked.destination rule only matches those. XRPL addresses go in a
// third set for a Payment.Destination rule (Privy's XRPL policies, October 2026).
//
// Safe to run on a schedule:
// - Adds first, removes after. The set is never without an address that is still listed.
// - Leaves a set alone when the list is stale, or when it would remove more than a share of the set
//   (MAX_REMOVE_SHARE, default 0.1). Exits non-zero then, so a failed scheduled run alerts you.
// - Prints one JSON line per run for an audit trail: source, list date, hash, added and removed.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { generateAuthorizationSignature } from "@privy-io/node";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58, base58xrp } from "@scure/base";

export const DEFAULT_SOURCE = "https://presign-guard.fizzl.eu/v1/sanctions";
const PRIVY_API = "https://api.privy.io";
const BATCH = 100; // Privy's limit per POST
const EVM = /^0x[0-9a-fA-F]{40}$/;

// EIP-55 mixed-case checksum. The recipe's signing conditions compare EVM addresses case-insensitively,
// but the high-level transfer action compares exactly, so by default both forms go in the set.
export function checksumAddress(address) {
  const lower = address.toLowerCase().slice(2);
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString("hex");
  return "0x" + [...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

// Branch on the address format, not on the asset label (the recipe's advice): USDT and USDC appear
// on several chains, and one address can carry several labels.
function isSolanaAddress(address) {
  try { return base58.decode(address).length === 32; } catch { return false; }
}

// A classic XRPL r-address: base58 with Ripple's alphabet, version 0, a 20-byte account id and a
// double-SHA-256 checksum. Privy's condition sets hold these, not X-addresses.
function isXrplAddress(address) {
  if (typeof address !== "string" || !address.startsWith("r")) return false;
  let bytes;
  try { bytes = base58xrp.decode(address); } catch { return false; }
  if (bytes.length !== 25 || bytes[0] !== 0) return false;
  const sha = (b) => createHash("sha256").update(b).digest();
  return sha(sha(bytes.subarray(0, 21))).subarray(0, 4).equals(Buffer.from(bytes.subarray(21)));
}

// The open list → the values for each condition set, sorted and without duplicates.
// evmCasing: "both" (default), "lower" or "checksum".
export function setValues(list, { evmCasing = "both" } = {}) {
  const evm = new Set();
  const solana = new Set();
  const xrpl = new Set();
  for (const { address, tokenAccounts } of list.addresses) {
    if (EVM.test(address)) {
      if (evmCasing !== "checksum") evm.add(address.toLowerCase());
      if (evmCasing !== "lower") evm.add(checksumAddress(address));
    } else if (isSolanaAddress(address)) {
      solana.add(address);
      for (const account of Object.values(tokenAccounts ?? {})) solana.add(account);
    } else if (isXrplAddress(address)) {
      xrpl.add(address);
    }
  }
  return { evm: [...evm].sort(), solana: [...solana].sort(), xrpl: [...xrpl].sort() };
}

// Refuses a list that is stale or suspiciously short; the sets then keep their last good contents.
export function checkList(list, { now = Date.now(), maxAgeHours = 72, minAddresses = 100 } = {}) {
  if (!list || !Array.isArray(list.addresses)) throw new Error("not a sanctions list");
  if (list.addresses.length < minAddresses) throw new Error(`only ${list.addresses.length} addresses in the list`);
  const checked = Date.parse(list.checkedAt);
  if (!Number.isFinite(checked) || now - checked > maxAgeHours * 3600 * 1000) {
    throw new Error(`the list was last checked against the Treasury at ${list.checkedAt}, more than ${maxAgeHours} hours ago`);
  }
}

// The condition-set item endpoints, with Basic auth and the owner's authorization signature on writes.
export function privyClient({ appId, appSecret, authorizationKey, baseUrl = PRIVY_API, fetchImpl = fetch }) {
  const auth = "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64");
  async function call(method, path, body) {
    const url = `${baseUrl}${path}`;
    const headers = { authorization: auth, "privy-app-id": appId };
    if (method !== "GET") {
      headers["privy-authorization-signature"] = generateAuthorizationSignature({
        authorizationPrivateKey: authorizationKey,
        // A request without a body is signed with an empty body.
        input: { version: 1, method, url: url.split("?")[0], body: body ?? {}, headers: { "privy-app-id": appId } },
      });
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const items = (setId) => `/v1/condition_sets/${encodeURIComponent(setId)}/condition_set_items`;
  return {
    async list(setId) {
      const all = [];
      let cursor;
      do {
        const page = await call("GET", `${items(setId)}?limit=${BATCH}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        all.push(...(page.items ?? []));
        cursor = page.next_cursor;
      } while (cursor);
      return all;
    },
    add: (setId, values) => call("POST", items(setId), values.map((value) => ({ value }))),
    remove: (setId, itemId) => call("DELETE", `${items(setId)}/${encodeURIComponent(itemId)}`),
  };
}

// Brings one condition set to exactly `wanted`: adds the missing values in batches, then removes items
// whose value is no longer listed (and duplicates).
export async function syncSet(client, setId, wanted, { dryRun = false, maxRemoveShare = 0.1, force = false } = {}) {
  if (!wanted.length) throw new Error(`refusing to empty condition set ${setId}`);
  const current = await client.list(setId);
  const want = new Set(wanted);
  const seen = new Set();
  const stale = [];
  for (const item of current) {
    if (want.has(item.value) && !seen.has(item.value)) seen.add(item.value);
    else stale.push(item);
  }
  const missing = wanted.filter((value) => !seen.has(value));
  if (!force && current.length && stale.length > current.length * maxRemoveShare) {
    throw new Error(`condition set ${setId}: would remove ${stale.length} of ${current.length} items (more than ${maxRemoveShare * 100}%); run with FORCE=1 if that is expected`);
  }
  if (!dryRun) {
    for (let i = 0; i < missing.length; i += BATCH) await client.add(setId, missing.slice(i, i + BATCH));
    for (const item of stale) await client.remove(setId, item.id);
  }
  return { set: setId, before: current.length, added: missing.length, removed: stale.length, after: wanted.length };
}

// --print: only the values per set, as JSON, without touching Privy (no credentials needed).
export async function run(env = process.env, { fetchImpl = fetch, log = console.log, now = Date.now(), print = false } = {}) {
  const dryRun = env.DRY_RUN === "1";
  if (!print) {
    for (const name of ["PRIVY_APP_ID", "PRIVY_APP_SECRET", ...(dryRun ? [] : ["PRIVY_AUTHORIZATION_KEY"])]) {
      if (!env[name]) throw new Error(`${name} is not set`);
    }
  }
  const source = env.SANCTIONS_URL || DEFAULT_SOURCE;
  const res = await fetchImpl(source, { headers: { accept: "application/json", "user-agent": "privy-sanctions-sync/0.2" } });
  if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
  const list = await res.json();
  checkList(list, { now, maxAgeHours: Number(env.MAX_AGE_HOURS) || 72 });
  const values = setValues(list, { evmCasing: env.EVM_CASING || "both" });
  if (print) {
    const out = { source, published: list.published, checkedAt: list.checkedAt, ...values };
    log(JSON.stringify(out, null, 2));
    return out;
  }
  const options = { dryRun, force: env.FORCE === "1", maxRemoveShare: Number(env.MAX_REMOVE_SHARE) || 0.1 };
  const targets = [["evm", env.PRIVY_EVM_SET_ID], ["solana", env.PRIVY_SOLANA_SET_ID], ["xrpl", env.PRIVY_XRPL_SET_ID]].filter(([, id]) => id);
  if (!targets.length) throw new Error("set PRIVY_EVM_SET_ID, PRIVY_SOLANA_SET_ID and/or PRIVY_XRPL_SET_ID");
  const client = privyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, authorizationKey: env.PRIVY_AUTHORIZATION_KEY, baseUrl: env.PRIVY_API_URL || PRIVY_API, fetchImpl });
  const sets = {};
  for (const [family, setId] of targets) sets[family] = await syncSet(client, setId, values[family], options);
  const record = {
    at: new Date(now).toISOString(),
    source,
    list: list.list,
    published: list.published,
    checkedAt: list.checkedAt,
    sha256: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
    dryRun: options.dryRun,
    sets,
  };
  log(JSON.stringify(record));
  return record;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.env, { print: process.argv.includes("--print") }).catch((err) => {
    console.error(`privy-sanctions-sync: ${err.message}`);
    process.exit(1);
  });
}
