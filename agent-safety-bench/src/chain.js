// What the chain data services know about the addresses in a scenario, answered the way they answer: GoPlus's address,
// contract, token and phishing-site lookups, and the Base RPC's eth_getCode and eth_getStorageAt. presign-guard asks
// these while it checks a signature (src/guard.js). Only presign-guard's code calls them; the agent cannot reach them.
//
// A scenario describes its addresses in env.chain, keyed by address:
//   { contract: { name, verified, deployedDaysAgo, proxy, trustList, malicious }, flags: ["phishing_activities", …] }
// An address without `contract` is a plain wallet. An address that isn't listed is a plain wallet without any reports,
// as GoPlus answers for a fresh one. USDC and Permit2 on Base are always known.
//
// The XRP Ledger node presign-guard asks (xrplcluster.com, JSON-RPC) answers from the XRPL accounts in env.chain, keyed
// by r-address: { xrpl: { flags, rlusd } }, where rlusd means the account has a trust line for Ripple's RLUSD. An
// account that isn't listed doesn't exist. The agent's account and Ripple's RLUSD issuer (clawback on, as on mainnet)
// are always there. There are no credentials, MPTs, channels, order books or AMM pools.

import { USDC_BASE } from "./x402-seller.js";
import { createWorld, json } from "./world.js";
import { AGENT_XRPL_ADDRESS } from "./addresses.js";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const DAY = 86400;
const EIP1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const KNOWN = {
  [USDC_BASE]: { contract: { name: "FiatTokenProxy", verified: true, deployedDaysAgo: 1150, proxy: "0x2ce6311ddae708829bc0784c967b7d77d19fd779", trustList: true } },
  [PERMIT2]: { contract: { name: "Permit2", verified: true, deployedDaysAgo: 1150, trustList: true } },
};

// GoPlus token_security for USDC on Base, trimmed to the fields presign-guard reads.
const USDC_TOKEN = {
  token_name: "USD Coin", token_symbol: "USDC", is_open_source: "1", is_proxy: "1", is_mintable: "1", owner_change_balance: "0",
  hidden_owner: "0", selfdestruct: "0", can_take_back_ownership: "0", transfer_pausable: "1", is_blacklisted: "1", is_honeypot: "0",
  buy_tax: "0", sell_tax: "0", cannot_sell_all: "0", slippage_modifiable: "0", trading_cooldown: "0", trust_list: "1",
};

const ADDRESS_FIELDS = [
  "cybercrime", "money_laundering", "phishing_activities", "stealing_attack", "blackmail_activities", "sanctioned", "financial_crime",
  "darkweb_transactions", "honeypot_related_address", "fake_kyc", "malicious_mining_activities", "blacklist_doubt", "mixer",
];

export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const RLUSD_HEX = "524C555344000000000000000000000000000000";
// The agent's account's next sequence number, as account_info reports it.
export const XRPL_SEQUENCE = 5;
const LSF_ALLOW_CLAWBACK = 0x80000000;

const KNOWN_XRPL = {
  [RLUSD_ISSUER]: { xrpl: { flags: LSF_ALLOW_CLAWBACK } },
  [AGENT_XRPL_ADDRESS]: { xrpl: { rlusd: true, sequence: XRPL_SEQUENCE } },
};

const word = (hex = "") => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;

export function createChainData(chain = {}) {
  const now = Math.floor(Date.now() / 1000);
  const entries = new Map(Object.entries({ ...KNOWN, ...chain }).map(([address, info]) => [address.toLowerCase(), info]));
  const infoOf = (address) => entries.get(String(address).toLowerCase()) ?? {};

  function addressSecurity(address) {
    const { contract, flags = [] } = infoOf(address);
    const result = Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, flags.includes(f) ? "1" : "0"]));
    return { ...result, number_of_malicious_contracts_created: "0", contract_address: contract ? "1" : "0", data_source: flags.length ? "SlowMist" : "" };
  }

  function contractSecurity(address) {
    const { contract } = infoOf(address);
    if (!contract) return { is_contract: 0, is_open_source: 0, is_proxy: 0, malicious_behavior: [], doubt_list: 0, trust_list: 0 };
    return {
      contract_name: contract.name,
      is_contract: 1,
      is_open_source: contract.verified ? 1 : 0,
      is_proxy: contract.proxy ? 1 : 0,
      deployed_time: now - (contract.deployedDaysAgo ?? 365) * DAY,
      trust_list: contract.trustList ? 1 : 0,
      doubt_list: 0,
      malicious_behavior: contract.malicious ?? [],
      creator_address: "",
      tag: "",
    };
  }

  const world = createWorld();
  world.route("api.gopluslabs.io", async (req) => {
    const path = req.url.pathname;
    const ok = (result) => json(200, { code: 1, message: "OK", result });
    let m;
    if ((m = /^\/api\/v1\/address_security\/(0x[0-9a-fA-F]{40})$/.exec(path))) return ok(addressSecurity(m[1]));
    if (/^\/api\/v1\/approval_security\/\d+$/.test(path)) return ok(contractSecurity(req.url.searchParams.get("contract_addresses")));
    if (/^\/api\/v1\/token_security\/\d+$/.test(path)) {
      const token = String(req.url.searchParams.get("contract_addresses")).toLowerCase();
      return ok(token === USDC_BASE.toLowerCase() ? { [token]: USDC_TOKEN } : {});
    }
    if (path === "/api/v1/phishing_site") return ok({ phishing_site: 0, website_contract_security: [] });
    return json(404, { code: 4004, message: "not found" });
  });
  world.route("base-rpc.publicnode.com", async (req) => {
    let body;
    try {
      body = JSON.parse(req.body);
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const answer = ({ id, method, params = [] }) => {
      const { contract } = infoOf(params[0]?.to ?? params[0]);
      if (method === "eth_getCode") return { jsonrpc: "2.0", id, result: contract ? "0x608060405234801561001057600080fd5b50" : "0x" };
      if (method === "eth_getStorageAt") return { jsonrpc: "2.0", id, result: contract?.proxy && String(params[1]).toLowerCase() === EIP1967_SLOT ? word(contract.proxy) : word() };
      if (method === "eth_call") return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } };
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
    };
    return json(200, Array.isArray(body) ? body.map(answer) : answer(body));
  });

  const xrplAccounts = new Map(Object.entries({ ...KNOWN_XRPL, ...chain }).filter(([, info]) => info.xrpl).map(([address, info]) => [address, info.xrpl]));
  world.route("xrplcluster.com", async (req) => {
    let body;
    try {
      body = JSON.parse(req.body);
    } catch {
      return json(400, { result: { error: "invalidParams", status: "error" } });
    }
    const { method, params: [p = {}] = [] } = body;
    const result = (r) => json(200, { result: { ...r, validated: true } });
    const missing = (error) => json(200, { result: { error, status: "error" } });
    if (method === "account_info") {
      const a = xrplAccounts.get(p.account);
      if (!a) return missing("actNotFound");
      return result({ account_data: { Account: p.account, Balance: "25000000", Flags: a.flags ?? 0, OwnerCount: a.rlusd ? 1 : 0, Sequence: a.sequence ?? 1 } });
    }
    if (method === "account_lines") {
      const a = xrplAccounts.get(p.account);
      if (!a) return missing("actNotFound");
      const lines = a.rlusd && (!p.peer || p.peer === RLUSD_ISSUER) ? [{ account: RLUSD_ISSUER, currency: RLUSD_HEX, balance: "50", limit: "1000000" }] : [];
      return result({ account: p.account, lines });
    }
    if (method === "ledger_entry") return missing("entryNotFound");
    if (method === "book_offers") return result({ offers: [] });
    if (method === "amm_info") return missing("actNotFound");
    return missing("unknownCmd");
  });
  return world;
}
