// Accounts on a hosted wallet server: customers sign in with their wallet
// (Sign-In with Ethereum, a free signature, no password), each with their own
// agents, rules, receipts and log. One Telegram bot serves everyone; a
// customer links their chat with a one-time code. Plans: Free (1 agent,
// receipts kept 7 days) and Pro (paid in USDC on Base, straight from the
// customer's wallet to the owner's address; checked on-chain here, so nothing
// about a payment has to be trusted from the browser).
//
// The owner of the server signs in with ADMIN_PASSWORD as "admin": unlimited,
// with the Telegram chat from TELEGRAM_CHAT_ID. That is the original
// single-owner setup, unchanged.
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage, padHex } from "viem";
import { createWallet, hashKey } from "./wallet.js";
import { ADMIN } from "./store.js";

export const PLANS = {
  free: { name: "free", maxAgents: 1, receiptDays: 7 },
  pro: { name: "pro", maxAgents: null, receiptDays: 90 },
  admin: { name: "owner", maxAgents: null, receiptDays: 90 },
};
const DAY = 86_400_000;
export const PERIOD_MS = 30 * DAY;
export const GRACE_MS = 3 * DAY;
export const REMIND_BEFORE_MS = 3 * DAY;
const NONCE_TTL_S = 600;
const LINK_TTL_S = 900;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const rand = (n = 12) => randomBytes(n).toString("base64url").replace(/[-_]/g, "x");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const date = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {object} o.store  memoryStore() or redisStore(): .scope(account) and .global
 * @param {object} [o.telegram]  createTelegram(): sends to any chat
 * @param {string} [o.adminChatId]  the owner's Telegram chat (TELEGRAM_CHAT_ID)
 * @param {object} o.billing  { payTo, priceUsdc, rpcUrl, fetch }
 * @param {string} o.publicUrl  e.g. https://wallet.fizzl.eu (the sign-in domain)
 */
export function createAccounts({ store, telegram = null, adminChatId = null, billing, publicUrl, now = () => Date.now(), walletOptions = {} }) {
  const g = store.global;
  const wallets = new Map();
  const queues = new Map(); // account -> promise: account changes run one at a time
  const serial = (id, fn) => { const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn); queues.set(id, run.catch(() => {})); return run; };
  const site = new URL(publicUrl || "http://localhost");
  if (!billing?.payTo || !isAddress(billing.payTo)) throw new Error("billing.payTo must be the address that receives Pro payments");
  const payTo = getAddress(billing.payTo);
  const priceUnits = BigInt(Math.round(Number(billing.priceUsdc ?? 5) * 1e6));
  const rpcFetch = billing.fetch ?? globalThis.fetch;

  async function account(id) {
    if (id === ADMIN) return { id: ADMIN, admin: true, telegram: adminChatId ? { chatId: String(adminChatId), userId: String(adminChatId) } : null };
    return g.getAccount(id);
  }
  function planOf(a) {
    if (!a) return PLANS.free;
    if (a.admin) return PLANS.admin;
    return (a.paidUntil ?? 0) + GRACE_MS > now() ? PLANS.pro : PLANS.free;
  }

  function walletFor(id) {
    if (wallets.has(id)) return wallets.get(id);
    const w = createWallet({
      ...walletOptions,
      store: store.scope(id),
      now,
      plan: async () => planOf(await account(id)),
      notify: async (approval, spending) => {
        const a = await account(id);
        if (telegram && a?.telegram?.chatId) await telegram.notify(a.telegram.chatId, approval, spending);
      },
      onSettled: (approval) => telegram?.decided(approval),
    });
    wallets.set(id, w);
    return w;
  }

  async function touch(a, change) {
    const next = { ...a, ...change };
    await g.putAccount(next);
    return next;
  }

  const api = {
    walletFor,
    account,
    planOf,

    // ---------- sign-in with Ethereum (EIP-4361) ----------
    async signInMessage(address) {
      if (!isAddress(address ?? "", { strict: false })) throw Object.assign(new Error("address must be an 0x… address"), { status: 400 });
      const addr = getAddress(address);
      const nonce = rand(12);
      const issued = new Date(now()).toISOString(), expires = new Date(now() + NONCE_TTL_S * 1000).toISOString();
      const message = `${site.host} wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Fizzl Agent Wallet. This is free: it is not a transaction and moves no money.\n\nURI: ${site.origin}\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expires}`;
      await g.putOnce("siwe", nonce, { address: addr, message }, NONCE_TTL_S);
      return { nonce, message };
    },
    // Returns the account id (lowercase address) for a valid signature over a message this server made.
    async signIn(nonce, signature) {
      const pending = typeof nonce === "string" ? await g.takeOnce("siwe", nonce) : null;
      if (!pending) throw Object.assign(new Error("sign-in expired, try again"), { status: 401 });
      let ok = false;
      try { ok = await verifyMessage({ address: pending.address, message: pending.message, signature }); } catch { ok = false; }
      if (!ok && billing.publicClient) { try { ok = await billing.publicClient.verifyMessage({ address: pending.address, message: pending.message, signature }); } catch { ok = false; } }
      if (!ok) throw Object.assign(new Error("that signature does not match"), { status: 401 });
      const id = pending.address.toLowerCase();
      const existing = await g.getAccount(id);
      if (!existing) await g.putAccount({ id, address: pending.address, createdAt: now(), paidUntil: 0, payments: [], telegram: null });
      return id;
    },

    // What the dashboard shows about the account itself.
    async me(id) {
      const a = await account(id);
      if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
      const plan = planOf(a);
      return {
        id, admin: !!a.admin, address: a.address ?? null, plan: plan.name, limits: { maxAgents: plan.maxAgents, receiptDays: plan.receiptDays },
        paidUntil: a.paidUntil ?? null, graceUntil: a.paidUntil ? a.paidUntil + GRACE_MS : null,
        payments: (a.payments ?? []).slice(-24).reverse(),
        telegram: a.telegram ? { linked: true, username: a.telegram.username ?? null } : { linked: false },
        billing: a.admin ? null : { payTo, priceUsdc: Number(priceUnits) / 1e6, token: "USDC", chainId: 8453, tokenAddress: USDC_BASE, periodDays: PERIOD_MS / DAY },
      };
    },

    // ---------- agents (routing an agent key to its account) ----------
    async agentForKey(key) {
      if (typeof key !== "string" || !key.startsWith("awk_")) return null;
      const h = hashKey(key);
      const owner = (await g.getKeyOwner(h)) ?? ADMIN;
      const agent = await store.scope(owner).agentByKeyHash(h);
      return agent ? { account: owner, agent } : null;
    },

    // ---------- Telegram ----------
    async telegramLink(id) {
      if (!telegram?.username) throw Object.assign(new Error("Telegram is not set up on this server"), { status: 503 });
      if (id === ADMIN) throw Object.assign(new Error("the owner's Telegram chat is set with TELEGRAM_CHAT_ID"), { status: 400 });
      const code = rand(16);
      await g.putOnce("tg", code, { account: id }, LINK_TTL_S);
      return { url: `https://t.me/${telegram.username}?start=${code}`, expiresInS: LINK_TTL_S };
    },
    async telegramUnlink(id) {
      const a = await account(id);
      if (!a || a.admin) return { ok: true };
      await serial(id, async () => touch((await g.getAccount(id)) ?? a, { telegram: null }));
      return { ok: true };
    },
    // /start <code> from a private chat: link it. Returns the reply text.
    async telegramStart(code, chat, from) {
      if (!code) return "Hi! Open your Fizzl wallet dashboard and click “Connect Telegram” to get approvals here.";
      const pending = await g.takeOnce("tg", code);
      if (!pending) return "That link has expired. Click “Connect Telegram” on the dashboard again.";
      if (chat?.type !== "private") return "Please open the link in a private chat with me.";
      const a = await account(pending.account);
      if (!a) return "That account no longer exists.";
      await serial(a.id, async () => touch((await g.getAccount(a.id)) ?? a, { telegram: { chatId: String(chat.id), userId: String(from.id), username: from.username ?? null, linkedAt: now() } }));
      return `Connected ✓ Approval requests for ${short(a.address)} come here now. You can disconnect on the dashboard.`;
    },
    // A button tap: only the linked user of the account the approval belongs to may decide.
    async telegramDecide(approvalId, decision, from) {
      const owner = (await g.getApprovalOwner(approvalId)) ?? ADMIN;
      const a = await account(owner);
      if (!a?.telegram || String(from?.id) !== String(a.telegram.userId)) return { refused: true };
      const who = from.username ? `@${from.username}` : "Telegram";
      return walletFor(owner).decide(approvalId, decision, who);
    },

    // ---------- billing: Pro, paid straight from the customer's wallet ----------
    // One payment at a time per account, so two claims can't overwrite each other's months.
    claimPayment: (id, txHash) => serial(id, () => claim(id, txHash)),

    // Hourly: remind before Pro ends, and say so when it has ended. Each message once per period.
    async remind() {
      if (!telegram) return 0;
      let sent = 0;
      for (const a of await g.listAccounts()) {
        if (!a.paidUntil || !a.telegram?.chatId) continue;
        const left = a.paidUntil - now();
        let kind = null, text = null;
        if (left <= REMIND_BEFORE_MS && left > 0) { kind = "soon"; text = `Your Fizzl wallet Pro ends on ${date(a.paidUntil)}. Pay $${Number(priceUnits) / 1e6} on the dashboard to keep unlimited agents and 90-day receipts.`; }
        else if (left <= 0 && left > -GRACE_MS) { kind = "grace"; text = `Your Fizzl wallet Pro has ended. Everything keeps working for 3 more days; pay on the dashboard to continue. After that you're on the free plan (1 agent); nothing is deleted.`; }
        else if (left <= -GRACE_MS && left > -GRACE_MS - 7 * DAY) { kind = "free"; text = "You're on the free plan now: one agent keeps working, the others are paused until you upgrade again."; }
        const tag = kind && `${kind}:${a.paidUntil}`;
        if (!tag || a.reminded === tag) continue;
        try { await telegram.send(a.telegram.chatId, text); sent++; await serial(a.id, async () => touch((await g.getAccount(a.id)) ?? a, { reminded: tag })); } catch (err) { console.warn(`[remind] ${err.message}`); }
      }
      return sent;
    },

    // Every Pro payment, for the owner's bookkeeping.
    async allPayments() {
      const rows = [];
      for (const a of await g.listAccounts()) for (const p of a.payments ?? []) rows.push({ account: a.address, ...p });
      return rows.sort((x, y) => x.at - y.at);
    },
  };

  async function claim(id, txHash) {
    if (id === ADMIN) throw Object.assign(new Error("the owner's server has no plan to pay for"), { status: 400 });
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw Object.assign(new Error("txHash must be a transaction hash"), { status: 400 });
    const hash = txHash.toLowerCase();
    const a = await account(id);
    if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
    if ((a.payments ?? []).some((p) => p.tx === hash)) return api.me(id);
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) throw Object.assign(new Error("not confirmed yet: try again in a few seconds"), { status: 409 });
    if (receipt.status !== "0x1") throw Object.assign(new Error("that transaction failed on-chain"), { status: 400 });
    const from = padHex(a.address.toLowerCase(), { size: 32 }).toLowerCase(), to = padHex(payTo.toLowerCase(), { size: 32 }).toLowerCase();
    let paid = 0n;
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== USDC_BASE.toLowerCase() || log.topics?.[0] !== TRANSFER_TOPIC) continue;
      if (log.topics[1]?.toLowerCase() === from && log.topics[2]?.toLowerCase() === to) paid += BigInt(log.data);
    }
    if (paid < priceUnits) throw Object.assign(new Error(`no payment of ${Number(priceUnits) / 1e6} USDC from ${short(a.address)} to ${short(payTo)} in that transaction`), { status: 400 });
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    const at = Number(BigInt(block?.timestamp ?? "0x0")) * 1000;
    if (at < now() - 7 * DAY) throw Object.assign(new Error("that payment is older than 7 days; contact the owner"), { status: 400 });
    if (!(await g.claimTx(hash))) throw Object.assign(new Error("that payment was already used"), { status: 409 });
    const months = Math.min(12, Number(paid / priceUnits));
    const start = Math.max(now(), a.paidUntil ?? 0);
    const paidUntil = start + months * PERIOD_MS;
    await touch(a, { paidUntil, payments: [...(a.payments ?? []), { tx: hash, amount: (Number(paid) / 1e6).toString(), months, at: now(), paidUntil }], reminded: null });
    await store.scope(id).addEvent({ at: now(), type: "plan", summary: `Pro paid: ${Number(paid) / 1e6} USDC, ${months} month${months === 1 ? "" : "s"}, until ${date(paidUntil)}` });
    return api.me(id);
  }

  async function rpc(method, params) {
    const res = await rpcFetch(billing.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const data = await res.json().catch(() => null);
    if (!data || data.error) throw Object.assign(new Error(`Base RPC ${method}: ${data?.error?.message ?? `HTTP ${res.status}`}`), { status: 502 });
    return data.result;
  }

  return api;
}
