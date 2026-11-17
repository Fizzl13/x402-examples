// Swap requests from the connector (src/connector.js: swap_tokens, swap_status). The agent asks; the server quotes
// Uniswap on Base, applies the owner's swap limits, has presign-guard check every transaction with a verdict bound to
// it (src/swap.js), and sends the owner a link. On that page (public/swap.html) the owner's own wallet sends the
// transactions: an approval of exactly the amount when needed, then the swap. Fizzl never holds a key.
//
// After the wallet sends a transaction, the page reports its hash. The server reads it back from Base and compares it
// with the transaction presign-guard checked (checkBinding): a transaction that differs (another recipient, a lower
// minimum, a bigger approval) is reported to the owner as changed. The swap counts toward the day's limit once it
// is confirmed.
import express from "express";
import { randomBytes } from "node:crypto";
import { normaliseTx } from "presign-guard-wallet/binding";
import { createSwaps, parseSwap, cleanSwapSettings, presignClient, rpcClient } from "./swap.js";

const KEEP_TTL_S = 3600;
const STATUS_WAIT_MS = 25_000;
const ASKS_PER_HOUR = 20;
const OPEN = new Set(["waiting", "approving", "swapping"]);
const ID = /^[A-Za-z0-9_-]{20,64}$/;
const DAY_TTL_S = 2 * 86_400;
const RECENT_TTL_S = 90 * 86_400;

const dayKey = (account, t) => `${account}:${new Date(t).toISOString().slice(0, 10)}`;

export function createSwapRequests({ accounts, store, usage, csp, swapHtml, presignUrl, internalKey, baseRpc = "https://mainnet.base.org", fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), statusWaitMs = STATUS_WAIT_MS, engine = null, rpc = null, signers }) {
  const router = express.Router();
  const read = rpc ?? rpcClient(baseRpc, fetchImpl);
  const presign = presignClient({ url: presignUrl, key: internalKey, fetch: fetchImpl });
  const swaps = engine ?? (presign ? createSwaps({ rpc: read, presign, now, signers }) : null);
  const asks = new Map();

  const getReq = async (id) => {
    if (typeof id !== "string" || !ID.test(id)) return null;
    return store.peekOnce("conswap", id);
  };
  const putReq = (r) => store.putOnce("conswap", r.id, r, KEEP_TTL_S);
  const dayUsed = async (account) => Number((await store.peekOnce("swapday", dayKey(account, now())))?.usd ?? 0);
  const addDay = async (account, usd) => store.putOnce("swapday", dayKey(account, now()), { usd: (await dayUsed(account)) + usd }, DAY_TTL_S);
  const recent = async (account) => (await store.peekOnce("swaprecent", account)) ?? [];
  const remember = async (r) => {
    const list = (await recent(r.account)).filter((x) => x.id !== r.id);
    list.unshift({ id: r.id, at: r.createdAt, agent: r.agentName, pay: r.view.pay, got: r.view.expected, atLeast: r.view.atLeast, status: r.status, tx: r.sent?.swap ?? null, note: r.note ?? null });
    await store.putOnce("swaprecent", r.account, list.slice(0, 20), RECENT_TTL_S);
  };
  const expired = (r) => r.status === "waiting" && now() > r.expiresAt;

  // What the owner's page and the agent see.
  function view(r, origin) {
    const status = expired(r) ? "expired" : r.status;
    const open = status === "waiting" || status === "approving";
    return {
      swap_id: r.id, status, agent: r.agentName, reason: r.reason, ...r.view, usd: Math.round(r.usd * 100) / 100,
      checks: r.txs.map((t) => ({ kind: t.kind, verdict: t.verdict, reasons: t.reasons, bound: true, valid_until: new Date(t.validUntil).toISOString() })),
      ...(open ? { txs: r.txs.map((t) => ({ kind: t.kind, tx: t.tx, sent: r.sent?.[t.kind] ?? null })), expires_at: new Date(r.expiresAt).toISOString() } : {}),
      sent: r.sent ?? {}, ...(r.note ? { note: r.note } : {}),
      ...(origin ? { approve_url: `${origin}/swap/${r.id}` } : {}),
    };
  }

  async function quoteAndCheck(r) {
    const built = await swaps.build({ owner: r.owner, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: BigInt(r.amountIn), slipBps: r.slipBps });
    if (built.error) return built;
    const checked = await swaps.check(built.txs, r.reason ? `swap ${r.view?.pay ?? ""} for ${r.tokenOut.symbol}: ${r.reason}` : `swap ${r.tokenIn.symbol} for ${r.tokenOut.symbol}`);
    if (checked.error) return checked;
    const validUntil = Math.min(...checked.checked.map((t) => Date.parse(t.validUntil)));
    return { view: built.view, txs: checked.checked.map(({ answer, ...t }) => ({ ...t, validUntil: Date.parse(t.validUntil), answer })), expiresAt: validUntil };
  }

  // ---------- the agent asks (swap_tokens) ----------
  async function request({ account, agent, origin }, args) {
    if (!swaps) return { error: "Swaps are not available on this wallet server yet." };
    if (agent.paused) return { error: `${agent.name} is paused on the owner's dashboard.` };
    const settings = cleanSwapSettings(await accounts.swapSettings(account));
    if (!settings.on) return { error: "Your user hasn't turned on swaps. They can do it on the dashboard: Your limits → Swaps (off by default)." };
    const a = asks.get(agent.id);
    if (!a || now() - a.since > 3_600_000) asks.set(agent.id, { n: 1, since: now() });
    else if (++a.n > ASKS_PER_HOUR) return { error: `${ASKS_PER_HOUR} swap requests an hour is the most one app can send its owner.` };
    const p = parseSwap(args);
    if (p.error) return { error: p.error };
    const owner = await accounts.payer(account);
    if (!owner) return { error: "Your user's account has no Ethereum wallet to swap from. They can link one on the dashboard." };
    const usd = await swaps.usdOf(p.tokenIn, p.amountIn);
    if (usd === null) return { error: `The ${p.tokenIn.symbol} price can't be read right now. Try again in a minute.` };
    if (usd > settings.perSwapUsd) return { error: `This swap is about $${usd.toFixed(2)}, above your user's limit of $${settings.perSwapUsd} per swap. Ask them to raise it on the dashboard, or swap less.` };
    const used = await dayUsed(account);
    if (used + usd > settings.perDayUsd) return { error: `With this swap (about $${usd.toFixed(2)}) your user would pass their limit of $${settings.perDayUsd} a day ($${used.toFixed(2)} used today).` };
    const base = { id: randomBytes(24).toString("base64url"), account, agentId: agent.id, agentName: agent.name, owner, tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn.toString(), slipBps: settings.slipBps, usd, reason: typeof args.reason === "string" ? args.reason.trim().slice(0, 200) || null : null, status: "waiting", sent: {}, createdAt: now() };
    const q = await quoteAndCheck(base);
    if (q.error) {
      usage.record("connector", { account, input: { tool: "swap_tokens" }, result: { status: q.red ? "red" : "refused" } });
      return { error: q.error };
    }
    const r = { ...base, view: q.view, txs: q.txs.map(({ answer, ...t }) => t), expiresAt: q.expiresAt };
    await putReq(r);
    await remember(r);
    const orange = r.txs.some((t) => t.verdict !== "green");
    await accounts.tellOwner(account, { title: `${agent.name} asks to swap ${r.view.pay}`, text: `🔄 ${agent.name} wants to swap ${r.view.pay} for at least ${r.view.atLeast} on Uniswap (Base)${r.reason ? ` for "${r.reason}"` : ""}. presign-guard: ${orange ? "orange, read the reasons first" : "green"}, bound to exactly these transactions. Nothing happens until you send it from your own wallet.`, url: `/swap/${r.id}`, tag: `swap-${r.id}` });
    usage.record("connector", { account, input: { tool: "swap_tokens", pair: `${p.tokenIn.symbol}-${p.tokenOut.symbol}` }, usd, result: { status: "waiting" } });
    return { ...view(r, origin), next: "Give your user the approve_url (also sent to their phone): their own wallet sends the swap. The price holds for about 2 minutes; the page can refresh it. Then call swap_status with swap_id." };
  }

  // Read a sent transaction back from Base, compare it with what presign-guard checked, follow its receipt.
  async function follow(r) {
    let changed = false;
    for (const t of r.txs) {
      const hash = r.sent?.[t.kind];
      if (!hash || r.confirmed?.[t.kind] !== undefined) continue;
      const onChain = await read("eth_getTransactionByHash", [hash]).catch(() => null);
      if (!onChain) continue;
      const tx = { chainId: Number(BigInt(onChain.chainId ?? "0x2105")), from: onChain.from, to: onChain.to, value: BigInt(onChain.value ?? "0").toString(), data: onChain.input };
      const bound = normaliseTx(t.tx), actual = normaliseTx(tx);
      if (!actual || JSON.stringify(bound) !== JSON.stringify(actual)) {
        changed = true;
        r.note = `The ${t.kind} that was sent is not the one presign-guard checked.`;
      }
      const receipt = await read("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (receipt) r.confirmed = { ...(r.confirmed ?? {}), [t.kind]: receipt.status === "0x1" };
    }
    if (changed) {
      r.status = "changed";
      await accounts.tellOwner(r.account, { title: "A swap was changed", text: `⚠️ ${r.note} Check your wallet's activity.`, url: `/swap/${r.id}`, tag: `swap-${r.id}` });
    } else if (r.confirmed?.swap === true && r.status !== "done") {
      r.status = "done";
      await addDay(r.account, r.usd);
      usage.record("connector", { account: r.account, input: { tool: "swap_tokens" }, usd: r.usd, result: { status: "done" } });
      await accounts.tellOwner(r.account, { title: `Swapped ${r.view.pay}`, text: `✅ Swapped ${r.view.pay} for at least ${r.view.atLeast} (Uniswap, Base).`, url: `/swap/${r.id}`, tag: `swap-${r.id}` });
    } else if (r.confirmed?.swap === false || r.confirmed?.approve === false) {
      r.status = "failed";
      r.note = `The ${r.confirmed?.approve === false ? "approval" : "swap"} failed on Base (reverted). Nothing was swapped.`;
    } else if (r.sent?.swap) r.status = "swapping";
    else if (r.sent?.approve) r.status = "approving";
    await putReq(r);
    await remember(r);
    return r;
  }

  async function status({ account, agent, origin }, id) {
    let r = await getReq(id);
    if (!r || r.account !== account || r.agentId !== agent.id) return { error: "No such swap request (they are kept an hour)." };
    const until = now() + statusWaitMs;
    while (OPEN.has(r.status) && !expired(r) && now() < until) {
      if (r.sent?.approve || r.sent?.swap) r = await follow(r);
      if (!OPEN.has(r.status)) break;
      await new Promise((ok) => setTimeout(ok, 2000));
      r = (await getReq(id)) ?? r;
    }
    return view(r, origin);
  }

  // ---------- the owner's page ----------
  router.get("/swap/:id", (_req, res) => res.set({ "content-security-policy": csp, "cache-control": "no-store", "referrer-policy": "no-referrer" }).type("html").send(swapHtml));
  router.get("/connector/swaps/:id", async (req, res) => {
    let r = await getReq(req.params.id);
    if (!r) return res.status(404).json({ message: "This swap request doesn't exist or has expired." });
    if (r.sent?.approve || r.sent?.swap) r = await follow(r);
    res.set("cache-control", "no-store").json(view(r));
  });
  // A fresh price and a fresh check (the quote holds about 2 minutes).
  router.post("/connector/swaps/:id/refresh", async (req, res) => {
    const r = await getReq(req.params.id);
    if (!r) return res.status(404).json({ message: "This swap request doesn't exist or has expired." });
    if (r.status !== "waiting" || r.sent?.approve) return res.status(409).json({ message: "This swap can't be refreshed now.", view: view(r) });
    const q = await quoteAndCheck(r);
    if (q.error) return res.status(409).json({ message: q.error, view: view(r) });
    const next = { ...r, view: q.view, txs: q.txs.map(({ answer, ...t }) => t), expiresAt: q.expiresAt };
    await putReq(next);
    res.json(view(next));
  });
  // The page reports what the owner's wallet sent.
  router.post("/connector/swaps/:id/sent", express.json({ limit: "2kb" }), async (req, res) => {
    let r = await getReq(req.params.id);
    if (!r) return res.status(404).json({ message: "This swap request doesn't exist or has expired." });
    const { kind, hash } = req.body ?? {};
    if (!r.txs.some((t) => t.kind === kind) || typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({ message: "kind and a transaction hash" });
    if (r.sent?.[kind]) return res.status(409).json({ message: "Already sent.", view: view(r) });
    if (kind === "swap" && r.txs.some((t) => t.kind === "approve") && !r.sent?.approve) return res.status(409).json({ message: "Send the approval first." });
    r = { ...r, sent: { ...(r.sent ?? {}), [kind]: hash.toLowerCase() }, status: kind === "swap" ? "swapping" : "approving" };
    await putReq(r);
    r = await follow(r);
    res.json(view(r));
  });
  router.post("/connector/swaps/:id/deny", async (req, res) => {
    const r = await getReq(req.params.id);
    if (!r) return res.status(404).json({ message: "This swap request doesn't exist or has expired." });
    if (r.status !== "waiting" || r.sent?.approve) return res.status(409).json({ message: "This swap can't be declined now.", view: view(r) });
    const next = { ...r, status: "denied" };
    await putReq(next);
    await remember(next);
    res.json(view(next));
  });

  return { router, request, status, recent, enabled: !!swaps };
}
