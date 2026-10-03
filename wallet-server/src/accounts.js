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
import { CATEGORIES } from "./catalog.js";
import { noUsage, fizzlSite } from "./usage.js";
import { weekOf, formatDigest } from "./digest.js";
import { createEndpointMonitor, urlProblem } from "./monitor.js";

// Categories an account can follow for new-provider alerts ("all" = every new seller).
const FOLLOWABLE = new Set(["all", "other", ...CATEGORIES.map((c) => c.id)]);

export const PLANS = {
  free: { name: "free", maxAgents: 1, receiptDays: 7, maxMonitors: 1 },
  pro: { name: "pro", maxAgents: null, receiptDays: 90, maxMonitors: 10 },
  admin: { name: "owner", maxAgents: null, receiptDays: 90, maxMonitors: 50 },
};
const DAY = 86_400_000;
export const PERIOD_MS = 30 * DAY;
export const GRACE_MS = 3 * DAY;
export const REMIND_BEFORE_MS = 3 * DAY;
export const WITHDRAW_MS = 14 * DAY;
const NONCE_TTL_S = 600;
const LINK_TTL_S = 900;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// The networks Pro can be paid on from an Ethereum wallet: USDC (native, 6 decimals) to the same payout
// address on each. Base is the default; each RPC can be replaced (billing.chains[id].rpcUrl).
export const PAY_CHAINS = {
  8453: { name: "Base", usdc: USDC_BASE, rpcUrl: "https://mainnet.base.org", explorer: "https://basescan.org", nativeSymbol: "ETH" },
  1: { name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", rpcUrl: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io", nativeSymbol: "ETH" },
  42161: { name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", rpcUrl: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", nativeSymbol: "ETH" },
  10: { name: "Optimism", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", rpcUrl: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io", nativeSymbol: "ETH" },
  137: { name: "Polygon", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", rpcUrl: "https://polygon-rpc.com", explorer: "https://polygonscan.com", nativeSymbol: "POL" },
};
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
export function createAccounts({ store, telegram = null, adminChatId = null, billing, publicUrl, now = () => Date.now(), walletOptions = {}, usage = noUsage, endpointMonitor = createEndpointMonitor() }) {
  const g = store.global;
  const wallets = new Map();
  const queues = new Map(); // account -> promise: account changes run one at a time
  const telegramTests = new Map(); // account -> when the last setup-check message went out
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
  // Per network: its USDC and RPC. Base keeps billing.token / billing.rpcUrl (tests use another token there).
  const chains = Object.fromEntries(Object.entries(PAY_CHAINS).map(([id, c]) => [id, { ...c, ...(billing.chains?.[id] ?? {}), ...(Number(id) === 8453 ? { usdc: token, rpcUrl: billing.rpcUrl ?? c.rpcUrl } : {}) }]));
  // For the dashboard, cheapest fees first and Ethereum last (the RPC is the public one, for adding the network to a wallet).
  const chainList = [8453, 42161, 10, 137, 1].map((id) => ({ chainId: id, name: chains[id].name, usdc: chains[id].usdc, explorer: chains[id].explorer, nativeSymbol: chains[id].nativeSymbol, rpcUrl: PAY_CHAINS[id].rpcUrl }));
  // Optional: Solana accounts (sign in with Phantom) and Pro paid in USDC on Solana.
  if (billing.solana?.payTo && !isSolanaAddress(billing.solana.payTo)) throw new Error("billing.solana.payTo must be a Solana address");
  const solPayTo = billing.solana?.payTo ?? null;
  const isSol = (a) => a?.chain === "solana";

  async function account(id) {
    if (id === ADMIN) return { id: ADMIN, admin: true, follow: (await g.getAccount(ADMIN))?.follow ?? [], telegram: adminChatId ? { chatId: String(adminChatId), userId: String(adminChatId) } : null };
    return g.getAccount(id);
  }
  // A withdrawal (EU 14-day right) ends Pro on the spot, until the customer pays again.
  const paidCount = (a) => (a?.payments?.length ?? 0) + (a?.autoPayments?.length ?? 0);
  const withdrawn = (a) => Boolean(a?.withdrawal) && paidCount(a) <= a.withdrawal.paidCount;
  // Pro lasts until the later of what was paid by hand and what the subscription contract took.
  const proUntil = (a) => { const end = Math.max(a?.paidUntil ?? 0, a?.auto?.paidThrough ?? 0); return withdrawn(a) ? Math.min(end, a.withdrawal.at) : end; };
  function planOf(a) {
    if (!a) return PLANS.free;
    if (a.admin) return PLANS.admin;
    if (withdrawn(a)) return PLANS.free;
    return proUntil(a) + GRACE_MS > now() ? PLANS.pro : PLANS.free;
  }
  // The EU right of withdrawal: within 14 days of the first Pro payment, once. The refund is the
  // part of what was paid that hasn't been used yet (Pro started right away, at the customer's request).
  function withdrawalOf(a) {
    if (!a || a.admin) return null;
    const paid = [...(a.payments ?? []), ...(a.autoPayments ?? [])].sort((x, y) => x.at - y.at);
    if (!paid.length) return null;
    if (a.withdrawal) return { done: true, at: a.withdrawal.at, refundUsdc: a.withdrawal.refundUsdc, refunded: Boolean(a.withdrawal.refundedAt) };
    const deadline = paid[0].at + WITHDRAW_MS;
    if (now() > deadline) return null;
    const total = paid.reduce((n, p) => n + (Number(p.amount) || 0), 0);
    const used = ((Number(priceUnits) / 1e6) * (now() - paid[0].at)) / PERIOD_MS; // pro rata, $5 per 30 days
    return { done: false, deadline, refundUsdc: Math.max(0, Math.floor((total - used) * 100) / 100) };
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
      track: (route, fields) => { account(id).then((a) => usage.record(route, { account: id, ref: a?.ref, ...fields }), () => usage.record(route, { account: id, ...fields })); },
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
    async signInMessage(address, origin, chain = "ethereum", chainId = null) {
      if (chain === "solana") return solanaSignInMessage(address, origin);
      // The network the wallet is on right now: some wallets (Phantom) refuse to sign a sign-in
      // message that names another chain. It changes nothing else; the signature is checked the same.
      const cid = Number.isSafeInteger(Number(chainId)) && Number(chainId) > 0 ? Number(chainId) : 8453;
      if (!isAddress(address ?? "", { strict: false })) throw Object.assign(new Error("address must be an 0x… address"), { status: 400 });
      const addr = getAddress(address);
      const nonce = rand(12);
      const issued = new Date(now()).toISOString(), expires = new Date(now() + NONCE_TTL_S * 1000).toISOString();
      const where = siteFor(origin);
      const message = `${where.host} wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Fizzl Agent Wallet. This is free: it is not a transaction and moves no money.\n\nURI: ${where.origin}\nVersion: 1\nChain ID: ${cid}\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expires}`;
      await g.putOnce("siwe", nonce, { address: addr, message }, NONCE_TTL_S);
      return { nonce, message };
    },
    // Returns the account id (lowercase address) for a valid signature over a message this server made.
    // ref: the Fizzl site the visitor came from (kept on a new account, for the owner's statistics).
    async signIn(nonce, signature, { ref = null } = {}) {
      const pending = typeof nonce === "string" ? await g.takeOnce("siwe", nonce) : null;
      if (!pending) throw Object.assign(new Error("sign-in expired, try again"), { status: 401 });
      if (pending.chain === "solana") return solanaSignIn(pending, signature, fizzlSite(ref));
      let ok = false;
      try { ok = await verifyMessage({ address: pending.address, message: pending.message, signature }); } catch { ok = false; }
      if (!ok && billing.publicClient) { try { ok = await billing.publicClient.verifyMessage({ address: pending.address, message: pending.message, signature }); } catch { ok = false; } }
      if (!ok) throw Object.assign(new Error("that signature does not match"), { status: 401 });
      const id = pending.address.toLowerCase();
      const existing = await g.getAccount(id);
      const fresh = !existing || existing.deletedAt;
      if (fresh) await g.putAccount({ id, address: pending.address, createdAt: now(), paidUntil: 0, payments: existing?.payments ?? [], autoPayments: existing?.autoPayments ?? [], telegram: null, ...(fizzlSite(ref) ? { ref: fizzlSite(ref) } : {}) });
      usage.record(fresh ? "signup" : "signin", { account: id, ref: fresh ? fizzlSite(ref) : existing.ref, input: { chain: "ethereum" } });
      return id;
    },

    // What the dashboard shows about the account itself.
    async me(id, { fresh = false } = {}) {
      let a = await account(id);
      if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
      try { a = await syncAuto(a, fresh ? { maxAgeMs: 0 } : {}); } catch (err) { console.warn(`[subscription] ${err.message}`); }
      const plan = planOf(a);
      return {
        id, admin: !!a.admin, address: a.address ?? null, plan: plan.name, limits: { maxAgents: plan.maxAgents, receiptDays: plan.receiptDays, maxMonitors: plan.maxMonitors },
        paidUntil: a.paidUntil ?? null, proUntil: proUntil(a) || null, graceUntil: proUntil(a) ? proUntil(a) + GRACE_MS : null,
        chain: a.admin ? null : isSol(a) ? "solana" : "ethereum",
        auto: subscription && !a.admin && !isSol(a) ? { contract: subscription, on: (a.auto?.dueAt ?? 0) > 0, nextCharge: a.auto?.dueAt || null, paidThrough: a.auto?.paidThrough || null, monthsApproved: a.auto ? Number(BigInt(a.auto.allowance ?? "0") / priceUnits) : 0, balanceUsdc: a.auto ? Number(BigInt(a.auto.balance ?? "0")) / 1e6 : null } : null,
        payments: (a.payments ?? []).slice(-24).reverse(),
        withdrawal: withdrawalOf(a),
        telegram: a.telegram ? { linked: true, username: a.telegram.username ?? null } : { linked: false },
        follow: a.follow ?? [],
        billing: a.admin ? null : isSol(a)
          ? (solPayTo ? { chain: "solana", payTo: solPayTo, priceUsdc: Number(priceUnits) / 1e6, token: "USDC", mint: USDC_MINT, periodDays: PERIOD_MS / DAY } : null)
          : { chain: "base", payTo, priceUsdc: Number(priceUnits) / 1e6, token: "USDC", chainId: 8453, tokenAddress: token, periodDays: PERIOD_MS / DAY, chains: chainList },
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
      usage.record("telegram_unlinked", { account: id });
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
      usage.record("telegram_linked", { account: a.id });
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

    // ---------- "Test my setup": everything an agent needs, checked without paying anything ----------
    // Returns { checks: [{ id, status: "ok" | "warn" | "fail", title, detail, fix? }] } in the order a
    // newcomer sets things up. Sends one Telegram test message when `telegram` is true (once a minute).
    async setupCheck(id, { agentId = null, telegram: testTelegram = false } = {}) {
      const a = await account(id);
      if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
      const w = walletFor(id), plan = planOf(a), checks = [];
      const add = (cid, status, title, detail, fix = null) => checks.push({ id: cid, status, title, detail, ...(fix ? { fix } : {}) });
      const agents = await w.agents();
      const allowed = plan.maxAgents ? agents.slice(0, plan.maxAgents).map((x) => x.id) : agents.map((x) => x.id);
      const agent = agents.find((x) => x.id === agentId) ?? agents.find((x) => x.lastSeen) ?? agents[0] ?? null;

      if (!agent) add("agent", "fail", "An agent key", "You have no agent yet.", "Type a name under Your agents and click Add agent. Put the key it shows in your agent's settings as WALLET_SERVER_KEY.");
      else add("agent", "ok", "An agent key", `${agent.name} has a key.${agents.length > 1 ? ` (${agents.length} agents; this test looks at ${agent.name}.)` : ""}`);

      if (agent) {
        const ago = agent.lastSeen ? now() - agent.lastSeen : null;
        if (ago === null) add("contact", "fail", "Your agent reaches the wallet", `${agent.name} has never contacted the wallet.`, `Check that WALLET_SERVER_URL is ${site.origin} and WALLET_SERVER_KEY is the key of ${agent.name}, restart your agent (for Claude Desktop: quit and open it again), then ask it "what is my wallet status?" and run this test again.`);
        else add("contact", ago < 7 * DAY ? "ok" : "warn", "Your agent reaches the wallet", `Last contact from ${agent.name}: ${ago < 120_000 ? "just now" : ago < 2 * 3_600_000 ? `${Math.round(ago / 60_000)} minutes ago` : ago < 2 * DAY ? `${Math.round(ago / 3_600_000)} hours ago` : `${Math.round(ago / DAY)} days ago`}.`, ago < 7 * DAY ? null : `Ask your agent "what is my wallet status?" and run this test again.`);
      }

      const state = await w.state();
      const usdc = state.spending.find((b) => b.token === "USDC");
      if (state.paused) add("rules", "fail", "Your agents may spend", "All agents are paused: nothing is signed.", "Click Resume all agents at the top.");
      else if (agent?.paused) add("rules", "fail", "Your agents may spend", `${agent.name} is paused.`, `Click Resume on ${agent.name} under Your agents.`);
      else if (agent && !allowed.includes(agent.id)) add("rules", "fail", "Your agents may spend", `The free plan has ${plan.maxAgents} agent; ${agent.name} is paused until you upgrade.`, "Upgrade to Pro under Your account (at the bottom of the dashboard), or remove the other agent.");
      else if (!usdc) add("rules", "warn", "Your agents may spend", "There is no USDC rule, so every USDC payment asks you first.", "Set your price rule (section 01).");
      else if (usdc.left !== null && Number(usdc.left) <= 0) add("rules", "warn", "Your agents may spend", `Today's budget of $${usdc.perDay} is used up: purchases ask you until it frees up.`, "Wait, or raise the daily budget (section 01).");
      else add("rules", "ok", "Your agents may spend", `Up to $${usdc.perTx ?? "any amount"} per purchase on their own${usdc.left !== null ? `, $${usdc.left} left today` : ""}. Above that, they ask you.`);

      if (agent?.address) {
        try {
          const bal = Number(await call(token, erc20Abi, "balanceOf", [agent.address])) / 1e6;
          const where = `${agent.address.slice(0, 6)}…${agent.address.slice(-4)}`;
          if (bal <= 0) add("balance", "fail", "Money to pay with", `${agent.name}'s wallet (${where}) has no USDC on Base.`, `Send a few dollars of USDC on Base to ${agent.address}. Only what it may spend: it's your agent's wallet, not your main one.`);
          else add("balance", bal < 1 ? "warn" : "ok", "Money to pay with", `${agent.name}'s wallet (${where}) has ${bal.toFixed(2)} USDC on Base.`, bal < 1 ? "That's enough for small calls only. Add a few dollars of USDC on Base if your agent needs more." : null);
        } catch (err) { add("balance", "warn", "Money to pay with", `The balance couldn't be read right now (${err.message}).`, "Try again in a minute."); }
      } else if (agent) add("balance", "warn", "Money to pay with", `The wallet doesn't know ${agent.name}'s address yet, so it can't see its balance.`, "Paste your agent's wallet address (0x…, public, not the private key) below, or it's filled in after its first purchase.");

      if (!telegram) add("telegram", "warn", "Approvals on your phone", "Telegram isn't set up on this server; approve on this dashboard.");
      else if (!a.telegram?.chatId) add("telegram", "warn", "Approvals on your phone", "Telegram isn't connected: purchases over your rule wait for you on this dashboard only.", "Click Connect Telegram under Your account, at the bottom of the dashboard.");
      else if (!testTelegram) add("telegram", "ok", "Approvals on your phone", "Telegram is connected.");
      else {
        const last = telegramTests.get(id) ?? 0;
        if (now() - last < 60_000) add("telegram", "ok", "Approvals on your phone", "Telegram is connected (a test message was sent less than a minute ago).");
        else {
          telegramTests.set(id, now());
          try { await telegram.send(a.telegram.chatId, "✓ Test from your Fizzl Agent Wallet: approval requests over your rule come here, with Approve and Deny buttons. Nothing was paid."); add("telegram", "ok", "Approvals on your phone", "Telegram is connected: we just sent you a test message."); }
          catch (err) { add("telegram", "fail", "Approvals on your phone", `The test message didn't arrive (${err.message}).`, "Did you block the bot? Disconnect Telegram and connect it again."); }
        }
      }
      const ids = (st) => checks.filter((c) => c.status === st).map((c) => c.id).join(",");
      usage.record("setup_check", { account: id, result: { ready: checks.every((c) => c.status !== "fail"), fail: ids("fail") || "none", warn: ids("warn") || "none", telegram_test: testTelegram || undefined } });
      return { agent: agent ? { id: agent.id, name: agent.name, address: agent.address ?? null } : null, checks, ready: checks.every((c) => c.status !== "fail") };
    },

    // ---------- new providers in the x402 catalog, on Telegram, for the categories an account follows ----------
    async setFollow(id, categories) {
      if (!Array.isArray(categories) || categories.length > 20 || categories.some((c) => !FOLLOWABLE.has(c))) throw Object.assign(new Error(`categories: a list of ${[...FOLLOWABLE].join(", ")}`), { status: 400 });
      const follow = [...new Set(categories)];
      if (id === ADMIN) { await g.putAccount({ ...((await g.getAccount(ADMIN)) ?? { id: ADMIN }), follow }); usage.record("follow", { account: id, input: { categories: follow.join(",") || "none" } }); return { follow }; }
      const a = await account(id);
      if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
      await serial(id, async () => touch((await g.getAccount(id)) ?? a, { follow }));
      usage.record("follow", { account: id, input: { categories: follow.join(",") || "none" } });
      return { follow };
    },
    // `providers`: sellers that just appeared ({ origin, host, category, description, cheapest, networks, skill }).
    // One message per account, with the ones in the categories it follows. Returns how many messages went out.
    async alertNewProviders(providers) {
      if (!telegram || !providers?.length) return 0;
      const names = Object.fromEntries([...CATEGORIES.map((c) => [c.id, `${c.icon} ${c.name}`]), ["other", "✨ Other"]]);
      const money = (n) => (n < 0.01 ? `$${+n.toFixed(4)}` : `$${n.toFixed(2)}`);
      const list = [...(await g.listAccounts()).filter((a) => a.id !== ADMIN && !a.deletedAt), await account(ADMIN)];
      let sent = 0;
      for (const a of list) {
        const follow = new Set(a?.follow ?? []);
        if (!follow.size || !a.telegram?.chatId) continue;
        const mine = providers.filter((p) => follow.has("all") || follow.has(p.category));
        if (!mine.length) continue;
        const lines = [`🆕 ${mine.length === 1 ? "A new provider" : `${mine.length} new providers`} in the x402 catalog`, ""];
        for (const p of mine.slice(0, 8)) {
          lines.push(`${names[p.category] ?? names.other} · ${p.host}`);
          if (p.description) lines.push(p.description.length > 160 ? `${p.description.slice(0, 157)}…` : p.description);
          lines.push(`from ${money(p.cheapest)} · ${p.networks.join(", ")}${p.skill ? ` · skill.md: ${p.skill.replace(/^https:\/\//, "")}` : ""}`, "");
        }
        if (mine.length > 8) lines.push(`…and ${mine.length - 8} more.`, "");
        lines.push(`Listings are written by the sellers, not recommendations. Search them in your wallet: ${site.origin}`, "Change which categories you follow there, under Find services.");
        try { await telegram.send(a.telegram.chatId, lines.join("\n")); sent++; } catch (err) { console.warn(`[alerts] ${err.message}`); }
      }
      usage.record("alerts_sent", { result: { providers: providers.length, messages: sent } });
      return sent;
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
        usage.record("account_deleted", { account: id });
        const kept = { id, address: a.address, deletedAt: now(), payments: a.payments ?? [], autoPayments: a.autoPayments ?? [], paidUntil: 0, ...(a.withdrawal ? { withdrawal: a.withdrawal } : {}) };
        await g.putAccount(kept);
        return { ok: true };
      });
    },

    // ---------- the EU right of withdrawal (the "withdraw" button on the dashboard) ----------
    // Pro ends right away; the owner is told on Telegram and refunds by hand (this server holds no
    // money), in USDC to the address the customer paid from. Automatic payment must be off first.
    async withdraw(id) {
      return serial(id, async () => {
        let a = await account(id);
        if (!a || a.admin) throw Object.assign(new Error("nothing to withdraw from"), { status: 400 });
        try { a = await syncAuto(a, { maxAgeMs: 0 }); } catch {}
        const w = withdrawalOf(a);
        if (w?.done) return api.me(id);
        if (!w) throw Object.assign(new Error("The 14 days after your first Pro payment have passed, or you haven't paid for Pro."), { status: 409 });
        if ((a.auto?.dueAt ?? 0) > 0) throw Object.assign(new Error("Turn off automatic payment first (it lives on-chain, so only your wallet can stop it)."), { status: 409 });
        const paid = [...(a.payments ?? []), ...(a.autoPayments ?? [])];
        const network = isSol(a) ? "Solana" : [...new Set(paid.map((p) => chains[p.chainId ?? 8453]?.name ?? "Base"))].join(", ");
        await touch(a, { withdrawal: { at: now(), refundUsdc: w.refundUsdc, to: a.address, network, paidCount: paidCount(a) } });
        await store.scope(id).addEvent({ at: now(), type: "plan", summary: `Withdrew from Pro: ${w.refundUsdc} USDC will be refunded to ${a.address}` });
        usage.record("pro_withdrawn", { account: id, ref: a.ref, usd: w.refundUsdc, input: { network } });
        if (telegram && adminChatId) await telegram.send(adminChatId, `Withdrawal (EU 14-day right): refund ${w.refundUsdc} USDC on ${network} to ${a.address} within 14 days. Pro has ended for this account. Mark it refunded on the owner dashboard once sent.`).catch(() => {});
        if (telegram && a.telegram?.chatId) await telegram.send(a.telegram.chatId, `We received your withdrawal from Fizzl wallet Pro. You'll get ${w.refundUsdc} USDC back at ${a.address} within 14 days. Your account stays, on the free plan.`).catch(() => {});
        return api.me(id);
      });
    },
    // Hourly: remind the owner of refunds still to send (day 10 and day 13 of the 14 the law allows).
    async remindRefunds() {
      if (!telegram || !adminChatId) return 0;
      let sent = 0;
      for (const a of await g.listAccounts()) {
        const w = a.withdrawal;
        if (!w || w.refundedAt) continue;
        const age = now() - w.at, stage = age >= 13 * DAY ? "13" : age >= 10 * DAY ? "10" : null;
        if (!stage || w.reminded === stage) continue;
        const left = Math.max(0, Math.ceil((w.at + WITHDRAW_MS - now()) / DAY));
        try {
          await telegram.send(adminChatId, `Refund still to send: ${w.refundUsdc} USDC on ${w.network} to ${w.to} (withdrawal of ${date(w.at)}). ${left ? `${left} day${left === 1 ? "" : "s"} left of the 14 the law allows.` : "The 14 days are up today."} Mark it refunded on the owner dashboard once sent.`);
          sent++;
          await serial(a.id, async () => { const cur = await g.getAccount(a.id); if (cur?.withdrawal) await touch(cur, { withdrawal: { ...cur.withdrawal, reminded: stage } }); });
        } catch (err) { console.warn(`[refunds] ${err.message}`); }
      }
      return sent;
    },
    // ---------- endpoint monitor (sellers: is my x402 endpoint still payable?) ----------
    // Up to plan.maxMonitors endpoints per account, checked every hour; an alert on Telegram after
    // two failed checks in a row, and again when it works again.
    async monitors(id) {
      const a = await account(id);
      const plan = planOf(a), list = (id === ADMIN ? (await g.getAccount(ADMIN))?.monitors : a?.monitors) ?? [];
      return { max: plan.maxMonitors, telegram: !!(a?.telegram?.chatId), monitors: list.map((m, i) => ({ ...m, paused: i >= plan.maxMonitors })) };
    },
    async addMonitor(id, { url, method = "GET" } = {}) {
      const problem = urlProblem(url);
      if (problem) throw Object.assign(new Error(problem), { status: 400 });
      if (!["GET", "POST"].includes(method)) throw Object.assign(new Error('method must be "GET" or "POST"'), { status: 400 });
      const clean = new URL(String(url).trim()).href;
      return serial(id, async () => {
        const a = await account(id), rec = (id === ADMIN ? await g.getAccount(ADMIN) : a) ?? { id };
        const list = rec.monitors ?? [], plan = planOf(a);
        if (list.some((m) => m.url === clean && m.method === method)) throw Object.assign(new Error("You're already watching that endpoint."), { status: 409 });
        if (list.length >= plan.maxMonitors) throw Object.assign(new Error(plan.name === "free" ? "The free plan watches 1 endpoint. Pro watches up to 10." : `You can watch up to ${plan.maxMonitors} endpoints.`), { status: 403 });
        const last = await endpointMonitor.check(clean, method).catch((err) => ({ state: "down", status: 0, ms: 0, note: err.message }));
        const m = { id: rand(6), url: clean, method, addedAt: now(), last: { ...last, at: now() }, fails: last.state === "down" ? 1 : 0, alerted: false };
        await g.putAccount({ ...rec, monitors: [...list, m] });
        usage.record("monitor_added", { account: id, input: { host: new URL(clean).host }, result: { state: last.state } });
        return api.monitors(id);
      });
    },
    async removeMonitor(id, monitorId) {
      return serial(id, async () => {
        const rec = (await g.getAccount(id)) ?? { id };
        await g.putAccount({ ...rec, monitors: (rec.monitors ?? []).filter((m) => m.id !== monitorId) });
        return api.monitors(id);
      });
    },
    // One check (now, or the hourly round): updates the record and sends an alert when it changes.
    async checkMonitor(id, monitorId, { alert = true } = {}) {
      const rec = await g.getAccount(id);
      const m = rec?.monitors?.find((x) => x.id === monitorId);
      if (!m) throw Object.assign(new Error("no such endpoint"), { status: 404 });
      const r = await endpointMonitor.check(m.url, m.method).catch((err) => ({ state: "down", status: 0, ms: 0, note: err.message }));
      const fails = r.state === "down" ? (m.fails ?? 0) + 1 : 0;
      let alerted = m.alerted, message = null;
      if (fails >= 2 && !m.alerted) { alerted = true; message = `⚠️ Your x402 endpoint stopped working for paying agents:\n${m.method} ${m.url}\n${r.note}\n\nChecked twice, an hour apart. Diagnose it for free: https://x402-doctor.fizzl.eu/?url=${encodeURIComponent(m.url)}`; }
      if (r.state === "ok" && m.alerted) { alerted = false; message = `✅ Your x402 endpoint works again:\n${m.method} ${m.url}\n${r.note}`; }
      await serial(id, async () => {
        const cur = await g.getAccount(id);
        await g.putAccount({ ...cur, monitors: (cur.monitors ?? []).map((x) => (x.id === monitorId ? { ...x, last: { ...r, at: now() }, fails, alerted } : x)) });
      });
      if (message && alert) {
        const chat = (await account(id))?.telegram?.chatId;
        if (telegram && chat) await telegram.send(chat, message).catch((err) => console.warn(`[monitor] ${err.message}`));
        usage.record("monitor_alert", { account: id, input: { host: new URL(m.url).host }, result: { state: r.state } });
      }
      return r;
    },
    async checkMonitors() {
      let checked = 0;
      for (const rec of await g.listAccounts()) {
        if (!rec.monitors?.length) continue;
        const plan = planOf(await account(rec.id));
        for (const m of rec.monitors.slice(0, plan.maxMonitors)) {
          if (m.last?.at && now() - m.last.at < 50 * 60_000) continue; // checked within the hour ("Check now")
          try { await api.checkMonitor(rec.id, m.id); checked++; } catch (err) { console.warn(`[monitor] ${err.message}`); }
        }
      }
      return checked;
    },

    // The owner's weekly summary on Telegram: Monday from 9:00 Amsterdam time, once per week
    // (remembered on the owner's record, so a restart doesn't send it twice). force: send now.
    async weeklyDigest({ summary = null, force = false } = {}) {
      if (!telegram || !adminChatId) return { sent: false, reason: "Telegram isn't set up for you (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)." };
      const { monday, due } = weekOf(now());
      const rec = (await g.getAccount(ADMIN)) ?? { id: ADMIN };
      if (!force && (!due || rec.digestWeek === monday)) return { sent: false, reason: "not due" };
      const text = formatDigest({ summary, refunds: await api.withdrawals(), dashboardUrl: /^https:\/\//.test(publicUrl || "") ? publicUrl : null });
      await telegram.send(adminChatId, text);
      if (!force) await g.putAccount({ ...((await g.getAccount(ADMIN)) ?? { id: ADMIN }), digestWeek: monday });
      return { sent: true, text };
    },
    // For the owner: withdrawals and whether they've been refunded.
    async withdrawals() {
      return (await g.listAccounts()).filter((a) => a.withdrawal).map((a) => ({ id: a.id, address: a.address, ...a.withdrawal })).sort((x, y) => y.at - x.at);
    },
    async markRefunded(id, tx = null) {
      return serial(id, async () => {
        const a = await g.getAccount(id);
        if (!a?.withdrawal) throw Object.assign(new Error("no withdrawal for this account"), { status: 404 });
        await touch(a, { withdrawal: { ...a.withdrawal, refundedAt: now(), ...(tx ? { refundTx: String(tx).slice(0, 120) } : {}) } });
        usage.record("pro_refunded", { account: id, ref: a.ref, usd: a.withdrawal.refundUsdc, input: { network: a.withdrawal.network, days: Math.round((now() - a.withdrawal.at) / DAY) } });
        if (telegram && a.telegram?.chatId) await telegram.send(a.telegram.chatId, `Your refund of ${a.withdrawal.refundUsdc} USDC for Fizzl wallet Pro has been sent to ${a.withdrawal.to}.`).catch(() => {});
        return { ok: true };
      });
    },

    // ---------- billing: Pro, paid straight from the customer's wallet ----------
    // One payment at a time per account, so two claims can't overwrite each other's months.
    claimPayment: (id, txHash, chainId) => serial(id, () => claim(id, txHash, chainId)),
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
        if (!end || !a.telegram?.chatId || withdrawn(a)) continue;
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
          usage.record("pro_paid", { account: a.id, ref: a.ref, usd: Number(priceUnits) / 1e6, input: { network: "Base", months: 1, automatic: true } });
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
  async function solanaSignIn(pending, signature, ref) {
    if (!verifySolanaSignature(pending.address, pending.message, signature)) throw Object.assign(new Error("that signature does not match"), { status: 401 });
    const id = `sol:${pending.address}`;
    const existing = await g.getAccount(id);
    const fresh = !existing || existing.deletedAt;
    if (fresh) await g.putAccount({ id, chain: "solana", address: pending.address, createdAt: now(), paidUntil: 0, payments: existing?.payments ?? [], autoPayments: [], telegram: null, ...(ref ? { ref } : {}) });
    usage.record(fresh ? "signup" : "signin", { account: id, ref: fresh ? ref : existing.ref, input: { chain: "solana" } });
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
  async function credit(a, tx, paid, chainId = null) {
    const months = Math.min(12, Number(paid / priceUnits));
    const start = Math.max(now(), proUntil(a));
    const paidUntil = start + months * PERIOD_MS;
    await touch(a, { paidUntil, payments: [...(a.payments ?? []), { tx, amount: (Number(paid) / 1e6).toString(), months, at: now(), paidUntil, ...(isSol(a) ? { chain: "solana" } : chainId && chainId !== 8453 ? { chainId } : {}) }], reminded: null });
    usage.record("pro_paid", { account: a.id, ref: a.ref, usd: Number(paid) / 1e6, input: { network: isSol(a) ? "Solana" : chains[chainId ?? 8453]?.name ?? "Base", months } });
    await store.scope(a.id).addEvent({ at: now(), type: "plan", summary: `Pro paid: ${Number(paid) / 1e6} USDC${isSol(a) ? " on Solana" : chainId && chainId !== 8453 ? ` on ${chains[chainId].name}` : ""}, ${months} month${months === 1 ? "" : "s"}, until ${date(paidUntil)}` });
    return api.me(a.id);
  }

  async function claim(id, txHash, chainId = 8453) {
    if (id === ADMIN) throw Object.assign(new Error("the owner's server has no plan to pay for"), { status: 400 });
    const sa = await account(id);
    if (isSol(sa)) return claimSolana(sa, txHash);
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw Object.assign(new Error("txHash must be a transaction hash"), { status: 400 });
    const cid = Number(chainId ?? 8453), net = chains[cid];
    if (!net) throw Object.assign(new Error(`Pro can be paid on ${Object.values(chains).map((c) => c.name).join(", ")}`), { status: 400 });
    const hash = txHash.toLowerCase();
    // The same hash can't be claimed twice; on another network than Base it is kept with the network.
    const claimKey = cid === 8453 ? hash : `${cid}:${hash}`;
    const a = await account(id);
    if (!a) throw Object.assign(new Error("no such account"), { status: 401 });
    if ((a.payments ?? []).some((p) => p.tx === hash && (p.chainId ?? 8453) === cid)) return api.me(id);
    const receipt = await rpc("eth_getTransactionReceipt", [hash], cid);
    if (!receipt) throw Object.assign(new Error("not confirmed yet: try again in a few seconds"), { status: 409 });
    if (receipt.status !== "0x1") throw Object.assign(new Error("that transaction failed on-chain"), { status: 400 });
    const from = padHex(a.address.toLowerCase(), { size: 32 }).toLowerCase(), to = padHex(payTo.toLowerCase(), { size: 32 }).toLowerCase();
    let paid = 0n;
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== net.usdc.toLowerCase() || log.topics?.[0] !== TRANSFER_TOPIC) continue;
      if (log.topics[1]?.toLowerCase() === from && log.topics[2]?.toLowerCase() === to) paid += BigInt(log.data);
    }
    if (paid < priceUnits) throw Object.assign(new Error(`no payment of ${Number(priceUnits) / 1e6} USDC on ${net.name} from ${short(a.address)} to ${short(payTo)} in that transaction`), { status: 400 });
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false], cid);
    const at = Number(BigInt(block?.timestamp ?? "0x0")) * 1000;
    if (at < now() - 7 * DAY) throw Object.assign(new Error("that payment is older than 7 days; contact the owner"), { status: 400 });
    if (!(await g.claimTx(claimKey))) throw Object.assign(new Error("that payment was already used"), { status: 409 });
    return credit(a, hash, paid, cid);
  }

  async function rpc(method, params, chainId = 8453) {
    const res = await rpcFetch(chains[chainId].rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const data = await res.json().catch(() => null);
    if (!data || data.error) throw Object.assign(new Error(`${chains[chainId].name} RPC ${method}: ${data?.error?.message ?? `HTTP ${res.status}`}`), { status: 502 });
    return data.result;
  }

  return api;
}
