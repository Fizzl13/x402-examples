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
import { readFileSync } from "node:fs";
import { isSolanaAddress, isSolanaSignature, verifySolanaSignature, usdcTransferMessage, usdcPaid, USDC_MINT } from "./solana.js";
import { getAddress, isAddress, verifyMessage, padHex, encodeFunctionData, decodeFunctionResult, encodeDeployData, erc20Abi } from "viem";
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

// The subscription contract (../subscription): automatic Pro payments.
const SUBSCRIPTION = JSON.parse(readFileSync(new URL("./subscription-artifact.json", import.meta.url), "utf8"));
const rand = (n = 12) => randomBytes(n).toString("base64url").replace(/[-_]/g, "x");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const date = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {object} o.store  memoryStore() or redisStore(): .scope(account) and .global
 * @param {object} [o.telegram]  createTelegram(): sends to any chat
 * @param {string} [o.adminChatId]  the owner's Telegram chat (TELEGRAM_CHAT_ID)
 * @param {object} o.billing  { payTo, priceUsdc, rpcUrl, fetch, subscription?: contract address, charger?: { address, send(to, data) -> tx hash },
 *   solana?: { payTo: Solana address that receives Pro payments, rpcUrl } }
 * @param {string} o.publicUrl  e.g. https://wallet.fizzl.eu (the sign-in domain)
 */
export function createAccounts({ store, telegram = null, adminChatId = null, billing, publicUrl, now = () => Date.now(), walletOptions = {} }) {
  const g = store.global;
  const wallets = new Map();
  const queues = new Map(); // account -> promise: account changes run one at a time
  const serial = (id, fn) => { const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn); queues.set(id, run.catch(() => {})); return run; };
  const site = new URL(publicUrl || "http://localhost");
  // An origin from the request (scheme + Host), if it looks like one; otherwise PUBLIC_URL.
  const siteFor = (origin) => {
    try {
      const u = new URL(origin);
      if (/^https?:$/.test(u.protocol) && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(u.host) && u.pathname === "/" && !u.username) return u;
    } catch {}
    return site;
  };
  if (!billing?.payTo || !isAddress(billing.payTo)) throw new Error("billing.payTo must be the address that receives Pro payments");
  const payTo = getAddress(billing.payTo);
  const priceUnits = BigInt(Math.round(Number(billing.priceUsdc ?? 5) * 1e6));
  const token = billing.token ? getAddress(billing.token) : USDC_BASE; // USDC on Base (another token only in tests)
  const rpcFetch = billing.fetch ?? globalThis.fetch;
  // Optional: Solana accounts (sign in with Phantom) and Pro paid in USDC on Solana.
  if (billing.solana?.payTo && !isSolanaAddress(billing.solana.payTo)) throw new Error("billing.solana.payTo must be a Solana address");
  const solPayTo = billing.solana?.payTo ?? null;
  const isSol = (a) => a?.chain === "solana";

  async function account(id) {
    if (id === ADMIN) return { id: ADMIN, admin: true, telegram: adminChatId ? { chatId: String(adminChatId), userId: String(adminChatId) } : null };
    return g.getAccount(id);
  }
  // Pro lasts until the later of what was paid by hand and what the subscription contract took.
  const proUntil = (a) => Math.max(a?.paidUntil ?? 0, a?.auto?.paidThrough ?? 0);
  function planOf(a) {
    if (!a) return PLANS.free;
    if (a.admin) return PLANS.admin;
    return proUntil(a) + GRACE_MS > now() ? PLANS.pro : PLANS.free;
  }
  const subscription = billing.subscription && isAddress(billing.subscription) ? getAddress(billing.subscription) : null;

  // The account's state in the subscription contract (and what its approval still allows), cached on the account.
  async function syncAuto(a, { maxAgeMs = 60_000 } = {}) {
    if (!subscription || !a?.address || a.admin || isSol(a)) return a;
    if (a.auto?.checkedAt && now() - a.auto.checkedAt < maxAgeMs) return a;
    const [dueAt, paidThrough] = await Promise.all(["dueAt", "paidThrough"].map((fn) => call(subscription, SUBSCRIPTION.abi, fn, [a.address])));
    const [allowance, balance] = await Promise.all([call(token, erc20Abi, "allowance", [a.address, subscription]), call(token, erc20Abi, "balanceOf", [a.address])]);
    const auto = { ...(a.auto ?? {}), dueAt: Number(dueAt) * 1000, paidThrough: Number(paidThrough) * 1000, allowance: allowance.toString(), balance: balance.toString(), checkedAt: now() };
    return serial(a.id, async () => touch((await g.getAccount(a.id)) ?? a, { auto }));
  }
  async function call(to, abi, functionName, args, from) {
    const data = await rpc("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }), ...(from ? { from } : {}) }, "latest"]);
    return decodeFunctionResult({ abi, functionName, data });
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
    solanaEnabled: !!solPayTo,
    account,
    planOf,

    // ---------- sign-in with Ethereum (EIP-4361) ----------
    // The domain in the message is the one the visitor actually opened (wallet.fizzl.eu, or the
    // onrender.com address): wallets compare it with the address bar and warn when they differ.
    async signInMessage(address, origin, chain = "ethereum") {
      if (chain === "solana") return solanaSignInMessage(address, origin);
      if (!isAddress(address ?? "", { strict: false })) throw Object.assign(new Error("address must be an 0x… address"), { status: 400 });
      const addr = getAddress(address);
      const nonce = rand(12);
      const issued = new Date(now()).toISOString(), expires = new Date(now() + NONCE_TTL_S * 1000).toISOString();
      const where = siteFor(origin);
      const message = `${where.host} wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Fizzl Agent Wallet. This is free: it is not a transaction and moves no money.\n\nURI: ${where.origin}\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expires}`;
      await g.putOnce("siwe", nonce, { address: addr, message }, NONCE_TTL_S);
      return { nonce, message };
    },
    // Returns the account id (lowercase address) for a valid signature over a message this server made.
    async signIn(nonce, signature) {
      const pending = typeof nonce === "string" ? await g.takeOnce("siwe", nonce) : null;
      if (!pending) throw Object.assign(new Error("sign-in expired, try again"), { status: 401 });
      if (pending.chain === "solana") return solanaSignIn(pending, signature);
      let ok = false;
      try { ok = await verifyMessage({ address: pending.address, message: pending.message, signature }); } catch { ok = false; }
      if (!ok && billing.publicClient) { try { ok = await billing.publicClient.verifyMessage({ address: pending.address, message: pending.message, signature }); } catch { ok = false; } }
      if (!ok) throw Object.assign(new Error("that signature does not match"), { status: 401 });
      const id = pending.address.toLowerCase();
      const existing = await g.getAccount(id);
      if (!existing || existing.deletedAt) await g.putAccount({ id, address: pending.address, createdAt: now(), paidUntil: 0, payments: existing?.payments ?? [], autoPayments: existing?.autoPayments ?? [], telegram: null });
      return id;
    },

    // What the dashboard shows about the account itself.
    async me(id, { fresh = false } = {}) {
      let a = await account(id);
      if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
      try { a = await syncAuto(a, fresh ? { maxAgeMs: 0 } : {}); } catch (err) { console.warn(`[subscription] ${err.message}`); }
      const plan = planOf(a);
      return {
        id, admin: !!a.admin, address: a.address ?? null, plan: plan.name, limits: { maxAgents: plan.maxAgents, receiptDays: plan.receiptDays },
        paidUntil: a.paidUntil ?? null, proUntil: proUntil(a) || null, graceUntil: proUntil(a) ? proUntil(a) + GRACE_MS : null,
        chain: a.admin ? null : isSol(a) ? "solana" : "ethereum",
        auto: subscription && !a.admin && !isSol(a) ? { contract: subscription, on: (a.auto?.dueAt ?? 0) > 0, nextCharge: a.auto?.dueAt || null, paidThrough: a.auto?.paidThrough || null, monthsApproved: a.auto ? Number(BigInt(a.auto.allowance ?? "0") / priceUnits) : 0, balanceUsdc: a.auto ? Number(BigInt(a.auto.balance ?? "0")) / 1e6 : null } : null,
        payments: (a.payments ?? []).slice(-24).reverse(),
        telegram: a.telegram ? { linked: true, username: a.telegram.username ?? null } : { linked: false },
        billing: a.admin ? null : isSol(a)
          ? (solPayTo ? { chain: "solana", payTo: solPayTo, priceUsdc: Number(priceUnits) / 1e6, token: "USDC", mint: USDC_MINT, periodDays: PERIOD_MS / DAY } : null)
          : { chain: "base", payTo, priceUsdc: Number(priceUnits) / 1e6, token: "USDC", chainId: 8453, tokenAddress: token, periodDays: PERIOD_MS / DAY },
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

    // ---------- deleting an account (GDPR erasure) ----------
    // Everything goes: agents and their keys, rules, approvals, receipts, log, Telegram link.
    // Only the payment records stay (bookkeeping law: 7 years). Automatic payment must be off first,
    // because the subscription lives on-chain and only the customer can cancel it.
    async deleteAccount(id) {
      if (id === ADMIN) throw Object.assign(new Error("the owner's account can't be deleted here"), { status: 400 });
      const a = await syncAuto(await account(id), { maxAgeMs: 0 }).catch(() => null) ?? (await account(id));
      if (!a) return { ok: true };
      if ((a.auto?.dueAt ?? 0) > 0) throw Object.assign(new Error("Turn off automatic payment first (it lives on-chain, so only your wallet can stop it)."), { status: 409 });
      return serial(id, async () => {
        await store.wipe(id);
        wallets.delete(id);
        const kept = { id, address: a.address, deletedAt: now(), payments: a.payments ?? [], autoPayments: a.autoPayments ?? [], paidUntil: 0 };
        await g.putAccount(kept);
        return { ok: true };
      });
    },

    // ---------- billing: Pro, paid straight from the customer's wallet ----------
    // One payment at a time per account, so two claims can't overwrite each other's months.
    claimPayment: (id, txHash) => serial(id, () => claim(id, txHash)),
    // A Solana account paying for Pro: the transaction for its wallet to sign and send (USDC to the owner).
    async solanaPayment(id, months = 1) {
      const a = await account(id);
      if (!a || !isSol(a)) throw Object.assign(new Error("only for accounts signed in with a Solana wallet"), { status: 400 });
      if (!solPayTo) throw Object.assign(new Error("paying on Solana is not set up on this server"), { status: 503 });
      const m = Math.min(12, Math.max(1, Math.floor(Number(months) || 1)));
      const { value } = await solRpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
      return { message: usdcTransferMessage({ from: a.address, to: solPayTo, amount: priceUnits * BigInt(m), blockhash: value.blockhash }), amountUsdc: (Number(priceUnits) * m) / 1e6, months: m, payTo: solPayTo };
    },

    // Hourly: remind before Pro ends, and say so when it has ended. Each message once per period.
    async remind() {
      if (!telegram) return 0;
      let sent = 0;
      const usd = `$${Number(priceUnits) / 1e6}`;
      for (const a of await g.listAccounts()) {
        const end = proUntil(a);
        if (!end || !a.telegram?.chatId) continue;
        const left = end - now();
        const auto = (a.auto?.dueAt ?? 0) > 0;
        let kind = null, text = null;
        if (auto && left <= REMIND_BEFORE_MS && left > 0) {
          kind = "autosoon";
          const short = BigInt(a.auto.allowance ?? "0") < priceUnits ? " Your approval is used up: renew it on the dashboard, or it can't be paid." : BigInt(a.auto.balance ?? "0") < priceUnits ? ` Your wallet has less than ${usd} USDC on Base: top it up, or it can't be paid.` : "";
          text = `On ${date(a.auto.dueAt)}, ${usd} in USDC will be paid automatically from your wallet for Fizzl wallet Pro.${short} You can turn automatic payment off on the dashboard.`;
        }
        else if (left <= REMIND_BEFORE_MS && left > 0) { kind = "soon"; text = `Your Fizzl wallet Pro ends on ${date(end)}. Pay ${usd} on the dashboard (or turn on automatic payment) to keep unlimited agents and 90-day receipts.`; }
        else if (left <= 0 && left > -GRACE_MS) { kind = "grace"; text = `Your Fizzl wallet Pro has ended. Everything keeps working for 3 more days; pay on the dashboard to continue. After that you're on the free plan (1 agent); nothing is deleted.`; }
        else if (left <= -GRACE_MS && left > -GRACE_MS - 7 * DAY) { kind = "free"; text = "You're on the free plan now: one agent keeps working, the others are paused until you upgrade again."; }
        const tag = kind && `${kind}:${end}`;
        if (!tag || a.reminded === tag) continue;
        try { await telegram.send(a.telegram.chatId, text); sent++; await serial(a.id, async () => touch((await g.getAccount(a.id)) ?? a, { reminded: tag })); } catch (err) { console.warn(`[remind] ${err.message}`); }
      }
      return sent;
    },

    // Hourly: take the payments that are due through the subscription contract. A charge that
    // would fail (approval used up, not enough USDC) is not sent; the customer is told once.
    async chargeDue() {
      if (!subscription || !billing.charger) return { charged: 0, failed: 0 };
      let charged = 0, failed = 0;
      for (const listed of await g.listAccounts()) {
        if (!(listed.auto?.dueAt > 0) || listed.auto.dueAt > now()) continue;
        let a;
        try { a = await syncAuto(listed, { maxAgeMs: 0 }); } catch (err) { console.warn(`[charge] ${err.message}`); continue; }
        if (!(a.auto.dueAt > 0) || a.auto.dueAt > now()) continue;
        const data = encodeFunctionData({ abi: SUBSCRIPTION.abi, functionName: "charge", args: [a.address] });
        let why = null;
        try { await rpc("eth_call", [{ from: billing.charger.address, to: subscription, data }, "latest"]); } catch (err) { why = BigInt(a.auto.allowance ?? "0") < priceUnits ? "your approval is used up" : BigInt(a.auto.balance ?? "0") < priceUnits ? "there isn't enough USDC on Base in your wallet" : err.message; }
        if (why) {
          failed++;
          const tag = `fail:${a.auto.dueAt}`;
          if (a.chargeNotice !== tag && telegram && a.telegram?.chatId) {
            await telegram.send(a.telegram.chatId, `Automatic payment for Fizzl wallet Pro didn't go through: ${why}. Renew the approval or pay on the dashboard; Pro keeps working for 3 days.`).catch(() => {});
            await serial(a.id, async () => touch((await g.getAccount(a.id)) ?? a, { chargeNotice: tag }));
          }
          continue;
        }
        try {
          const tx = await billing.charger.send(subscription, data);
          for (let i = 0; i < 30; i++) { const r = await rpc("eth_getTransactionReceipt", [tx]); if (r) break; await new Promise((ok) => setTimeout(ok, billing.pollMs ?? 2000)); }
          const after = await syncAuto(a, { maxAgeMs: 0 });
          charged++;
          await store.scope(a.id).addEvent({ at: now(), type: "plan", summary: `Pro paid automatically: ${Number(priceUnits) / 1e6} USDC, until ${date(after.auto.paidThrough)}` });
          await serial(a.id, async () => touch((await g.getAccount(a.id)) ?? after, { autoPayments: [...((await g.getAccount(a.id))?.autoPayments ?? []), { tx, amount: (Number(priceUnits) / 1e6).toString(), at: now(), paidThrough: after.auto.paidThrough }] }));
          if (telegram && a.telegram?.chatId) await telegram.send(a.telegram.chatId, `Paid automatically: ${Number(priceUnits) / 1e6} USDC for Fizzl wallet Pro, until ${date(after.auto.paidThrough)}. Thank you!`).catch(() => {});
        } catch (err) { failed++; console.warn(`[charge] ${a.address}: ${err.message}`); }
      }
      return { charged, failed };
    },

    async refreshAuto(id) { return api.me(id, { fresh: true }); },

    // For the owner: the transaction that deploys the subscription contract, and the charger's state.
    async subscriptionSetup() {
      const args = [token, payTo, priceUnits, BigInt(PERIOD_MS / 1000)];
      const charger = billing.charger ? { address: billing.charger.address, balanceEth: Number(BigInt(await rpc("eth_getBalance", [billing.charger.address, "latest"]).catch(() => "0x0"))) / 1e18 } : null;
      return { contract: subscription, deployData: encodeDeployData({ abi: SUBSCRIPTION.abi, bytecode: SUBSCRIPTION.bytecode, args }), args: { token: token, payee: payTo, priceUsdc: Number(priceUnits) / 1e6, periodDays: PERIOD_MS / DAY }, charger, compiler: SUBSCRIPTION.compiler };
    },

    // Every Pro payment, for the owner's bookkeeping.
    async allPayments() {
      const rows = [];
      for (const a of await g.listAccounts()) {
        for (const p of a.payments ?? []) rows.push({ account: a.address, ...p });
        for (const p of a.autoPayments ?? []) rows.push({ account: a.address, months: 1, paidUntil: p.paidThrough, auto: true, ...p });
      }
      return rows.sort((x, y) => x.at - y.at);
    },
  };

  // ---------- Solana: sign in (a message signed by the wallet) and Pro paid in USDC on Solana ----------
  async function solanaSignInMessage(address, origin) {
    if (!isSolanaAddress(address)) throw Object.assign(new Error("address must be a Solana address"), { status: 400 });
    const nonce = rand(12);
    const issued = new Date(now()).toISOString(), expires = new Date(now() + NONCE_TTL_S * 1000).toISOString();
    const where = siteFor(origin);
    const message = `${where.host} wants you to sign in with your Solana account:\n${address}\n\nSign in to Fizzl Agent Wallet. This is free: it is not a transaction and moves no money.\n\nURI: ${where.origin}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expires}`;
    await g.putOnce("siwe", nonce, { address, message, chain: "solana" }, NONCE_TTL_S);
    return { nonce, message };
  }
  async function solanaSignIn(pending, signature) {
    if (!verifySolanaSignature(pending.address, pending.message, signature)) throw Object.assign(new Error("that signature does not match"), { status: 401 });
    const id = `sol:${pending.address}`;
    const existing = await g.getAccount(id);
    if (!existing || existing.deletedAt) await g.putAccount({ id, chain: "solana", address: pending.address, createdAt: now(), paidUntil: 0, payments: existing?.payments ?? [], autoPayments: [], telegram: null });
    return id;
  }
  async function claimSolana(a, signature) {
    if (!solPayTo) throw Object.assign(new Error("paying on Solana is not set up on this server"), { status: 503 });
    if (!isSolanaSignature(signature)) throw Object.assign(new Error("that is not a Solana transaction signature"), { status: 400 });
    if ((a.payments ?? []).some((p) => p.tx === signature)) return api.me(a.id);
    const tx = await solRpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) throw Object.assign(new Error("not confirmed yet: try again in a few seconds"), { status: 409 });
    if (tx.meta?.err) throw Object.assign(new Error("that transaction failed on-chain"), { status: 400 });
    const paid = usdcPaid(tx, { payer: a.address, payee: solPayTo }) ?? 0n;
    if (paid < priceUnits) throw Object.assign(new Error(`no payment of ${Number(priceUnits) / 1e6} USDC from ${short(a.address)} to ${short(solPayTo)} in that transaction`), { status: 400 });
    if ((tx.blockTime ?? 0) * 1000 < now() - 7 * DAY) throw Object.assign(new Error("that payment is older than 7 days; contact the owner"), { status: 400 });
    if (!(await g.claimTx(`sol:${signature}`))) throw Object.assign(new Error("that payment was already used"), { status: 409 });
    return credit(a, signature, paid);
  }
  async function solRpc(method, params) {
    const res = await rpcFetch(billing.solana?.rpcUrl ?? "https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const data = await res.json().catch(() => null);
    if (!data || data.error) throw Object.assign(new Error(`Solana RPC ${method}: ${data?.error?.message ?? `HTTP ${res.status}`}`), { status: 502 });
    return data.result;
  }
  // Pro for what was paid (whole months, at most 12), after any time already paid for.
  async function credit(a, tx, paid) {
    const months = Math.min(12, Number(paid / priceUnits));
    const start = Math.max(now(), proUntil(a));
    const paidUntil = start + months * PERIOD_MS;
    await touch(a, { paidUntil, payments: [...(a.payments ?? []), { tx, amount: (Number(paid) / 1e6).toString(), months, at: now(), paidUntil, ...(isSol(a) ? { chain: "solana" } : {}) }], reminded: null });
    await store.scope(a.id).addEvent({ at: now(), type: "plan", summary: `Pro paid: ${Number(paid) / 1e6} USDC${isSol(a) ? " on Solana" : ""}, ${months} month${months === 1 ? "" : "s"}, until ${date(paidUntil)}` });
    return api.me(a.id);
  }

  async function claim(id, txHash) {
    if (id === ADMIN) throw Object.assign(new Error("the owner's server has no plan to pay for"), { status: 400 });
    const sa = await account(id);
    if (isSol(sa)) return claimSolana(sa, txHash);
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
      if (log.address?.toLowerCase() !== token.toLowerCase() || log.topics?.[0] !== TRANSFER_TOPIC) continue;
      if (log.topics[1]?.toLowerCase() === from && log.topics[2]?.toLowerCase() === to) paid += BigInt(log.data);
    }
    if (paid < priceUnits) throw Object.assign(new Error(`no payment of ${Number(priceUnits) / 1e6} USDC from ${short(a.address)} to ${short(payTo)} in that transaction`), { status: 400 });
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    const at = Number(BigInt(block?.timestamp ?? "0x0")) * 1000;
    if (at < now() - 7 * DAY) throw Object.assign(new Error("that payment is older than 7 days; contact the owner"), { status: 400 });
    if (!(await g.claimTx(hash))) throw Object.assign(new Error("that payment was already used"), { status: 409 });
    return credit(a, hash, paid);
  }

  async function rpc(method, params) {
    const res = await rpcFetch(billing.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const data = await res.json().catch(() => null);
    if (!data || data.error) throw Object.assign(new Error(`Base RPC ${method}: ${data?.error?.message ?? `HTTP ${res.status}`}`), { status: 502 });
    return data.result;
  }

  return api;
}
