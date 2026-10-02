// The wallet behind presign-guard-wallet-mcp: an agent's own key, wrapped in
// presign-guard-wallet, so every payment and transfer a model asks for is
// checked by presign-guard and kept to the owner's limits, with approval on
// Telegram or the wallet server above them.
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, isAddress, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, bsc, mainnet, optimism, polygon } from "viem/chains";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";
import { telegramApprover } from "presign-guard-wallet/telegram";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const VERSION = "0.2.0";

export const CHAINS = {
  base: { chain: base, usdc: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6] },
  ethereum: { chain: mainnet, usdc: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6] },
  optimism: { chain: optimism, usdc: ["0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6] },
  arbitrum: { chain: arbitrum, usdc: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6] },
  polygon: { chain: polygon, usdc: ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6] },
  bsc: { chain: bsc, usdc: ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18] },
};

const BODY_LIMIT = 20_000;
const CHECK_PRICE_CAP = "$0.02"; // a presign-guard check costs $0.01

const amountString = z.string().regex(/^\d+(\.\d+)?$/, "a decimal amount like \"2.5\"");
const address = z.string().refine((a) => isAddress(a, { strict: false }), "an 0x… address");

/**
 * Read the configuration from environment variables (see README).
 * Throws a readable error for anything missing or unsafe.
 */
export function configFromEnv(env = process.env) {
  const key = env.AGENT_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_KEY must be the agent wallet's private key (0x + 64 hex). Use a separate wallet with only what the agent may spend.");
  const chainName = (env.CHAIN ?? "base").toLowerCase();
  if (!CHAINS[chainName]) throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);

  const server = env.WALLET_SERVER_URL || env.WALLET_SERVER_KEY ? { url: env.WALLET_SERVER_URL, key: env.WALLET_SERVER_KEY } : undefined;
  const tokens = {};
  const usdc = pick(env.LIMIT_USDC_PER_TX, env.LIMIT_USDC_PER_DAY);
  if (usdc) tokens.USDC = usdc;
  const nativeSymbol = CHAINS[chainName].chain.nativeCurrency.symbol;
  const native = pick(env.LIMIT_NATIVE_PER_TX, env.LIMIT_NATIVE_PER_DAY);
  if (native) tokens[nativeSymbol === "MATIC" ? "POL" : nativeSymbol] = native;
  if (server && Object.keys(tokens).length) throw new Error("with WALLET_SERVER_URL the limits live on the wallet server: leave out the LIMIT_* variables");
  if (!server && !Object.keys(tokens).length) throw new Error("set spending limits (LIMIT_USDC_PER_TX and/or LIMIT_USDC_PER_DAY) or a wallet server (WALLET_SERVER_URL + WALLET_SERVER_KEY): this wallet does not run without a budget");

  const telegram = env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : undefined;
  if (telegram && (!telegram.token || !telegram.chatId)) throw new Error("Telegram approval needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  if (telegram && server) throw new Error("with WALLET_SERVER_URL, approvals go through the wallet server (its own Telegram): leave out TELEGRAM_*");

  const maxPrice = env.MAX_PAYMENT_USD ?? "1";
  if (!/^\d+(\.\d+)?$/.test(maxPrice)) throw new Error("MAX_PAYMENT_USD must be a number of dollars, e.g. 1 or 0.25");

  return {
    key,
    chainName,
    rpcUrl: env.RPC_URL || undefined,
    creditKey: env.PRESIGN_CREDIT_KEY || undefined,
    server,
    limits: server ? undefined : { tokens },
    telegram,
    label: env.AGENT_LABEL || "mcp-agent",
    maxPaymentUsd: Number(maxPrice),
  };
}

function pick(perTx, perDay) {
  const out = {};
  for (const [k, v] of [["perTx", perTx], ["perDay", perDay]]) {
    if (v === undefined || v === "") continue;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`limits must be amounts like "5" or "0.5" (got "${v}")`);
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The guarded wallet and what the tools do with it. `overrides` is for tests
 * (walletClient, publicClient, fetch, presign options such as verifyReceipts).
 */
export function createWallet(config, overrides = {}) {
  const { chain, usdc } = CHAINS[config.chainName];
  const account = privateKeyToAccount(config.key);
  const transport = http(config.rpcUrl);
  const walletClient = overrides.walletClient ?? createWalletClient({ account, chain, transport });
  const publicClient = overrides.publicClient ?? createPublicClient({ chain, transport });
  const plainFetch = overrides.fetch ?? globalThis.fetch;

  // Pays the presign-guard checks ($0.01 each, USDC on Base) with the agent's key,
  // capped per payment. Not guarded itself: guarding the check would check the check.
  const checkPayer = new x402Client().setSpendControls({ maxAmountPerPayment: CHECK_PRICE_CAP });
  checkPayer.register("eip155:8453", new ExactEvmScheme(account));
  const pay = wrapFetchWithPayment(plainFetch, checkPayer);

  const onOverLimit = config.telegram ? telegramApprover({ ...config.telegram, label: config.label, fetch: plainFetch }) : undefined;
  const guarded = guardWallet(walletClient, {
    pay,
    creditKey: config.creditKey,
    fetch: plainFetch,
    limits: config.limits,
    onOverLimit,
    server: config.server ? { ...config.server, fetch: plainFetch } : undefined,
    ...overrides.guard,
  });

  // x402 payments are signed by the guarded wallet: checked, and counted toward the USDC limits.
  const signer = {
    address: account.address,
    signTypedData: (typedData) => guarded.signTypedData({ account, ...typedData }),
    readContract: (args) => publicClient.readContract(args),
  };

  // One x402 call, paid by the guarded signer, capped per call.
  async function callX402({ url, method, body, headers, maxPriceUsd }) {
    const cap = Math.min(maxPriceUsd ?? config.maxPaymentUsd, config.maxPaymentUsd);
    const client = new x402Client().setSpendControls({ maxAmountPerPayment: `$${cap}` });
    client.register(`eip155:${chain.id}`, new ExactEvmScheme(signer));
    const res = await wrapFetchWithPayment(plainFetch, client)(url, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    const settled = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    let payment = null;
    if (settled) { try { payment = decodePaymentResponseHeader(settled); } catch { payment = { raw: settled }; } }
    return {
      status: res.status,
      paid: !!payment,
      payment,
      contentType: res.headers.get("content-type"),
      body: text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n… (${text.length - BODY_LIMIT} more characters cut)` : text,
    };
  }

  return {
    address: account.address,
    chain,
    guard: guarded,

    async status() {
      const [native, usdcBalance] = await Promise.all([
        publicClient.getBalance({ address: account.address }).catch(() => null),
        publicClient.readContract({ address: usdc[0], abi: erc20Abi, functionName: "balanceOf", args: [account.address] }).catch(() => null),
      ]);
      return {
        address: account.address,
        chain: `${config.chainName} (${chain.id})`,
        balances: {
          [chain.nativeCurrency.symbol]: native === null ? "unknown" : formatEther(native),
          USDC: usdcBalance === null ? "unknown" : formatUnits(usdcBalance, usdc[1]),
        },
        limits: config.server ? `kept by the wallet server ${config.server.url}` : config.limits.tokens,
        spending: await guarded.spending().catch((err) => `unavailable (${err.message})`),
        approvals: config.server ? "wallet server (dashboard / Telegram)" : config.telegram ? "Telegram" : "none: anything over a limit is refused",
        maxPaymentUsd: config.maxPaymentUsd,
        paused: guarded.paused(),
      };
    },

    // Every payment is recorded with what it is for: on the wallet server's receipts, in Telegram approvals, in onSpend.
    async sendUsdc({ to, amount, reason }) {
      const value = parseUnits(amount, usdc[1]);
      const hash = await guarded.withPurchase({ description: reason || `Send ${amount} USDC to ${to}` }, () => guarded.writeContract({ address: usdc[0], abi: erc20Abi, functionName: "transfer", args: [to, value] }));
      return { hash, sent: `${amount} USDC`, to, chain: config.chainName };
    },

    async sendNative({ to, amount, reason }) {
      const symbol = chain.nativeCurrency.symbol;
      const hash = await guarded.withPurchase({ description: reason || `Send ${amount} ${symbol} to ${to}` }, () => guarded.sendTransaction({ to, value: parseEther(amount) }));
      return { hash, sent: `${amount} ${symbol}`, to, chain: config.chainName };
    },

    async payX402({ url, method = "GET", body, headers, maxPriceUsd, reason }) {
      if (!/^https?:\/\//.test(url)) throw new TypeError("url must start with https:// or http://");
      return guarded.withPurchase({ url, description: reason || `${method} ${new URL(url).host}` }, async (report) => {
        const out = await callX402({ url, method, body, headers, maxPriceUsd });
        report({ httpStatus: out.status, ...(out.payment?.transaction ? { settlement: { transaction: out.payment.transaction, network: out.payment.network } } : {}) });
        return out;
      });
    },

    pause(reason) {
      guarded.pause();
      return `Paused: nothing will be signed until the owner restarts this server${config.server ? " (or resumes it on the wallet server)" : ""}. Reason: ${reason}`;
    },
  };
}

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function result(fn) {
  return async (args) => {
    try {
      const out = await fn(args);
      return { content: [{ type: "text", text: typeof out === "string" ? out : json(out) }] };
    } catch (err) {
      // x402 wraps errors from the signer; find the guard's own refusal underneath.
      let blocked = err;
      while (blocked && !(blocked instanceof PresignBlockedError)) blocked = blocked.cause;
      const guardText = /not signed|nothing was signed|is paused/.exec(err.message) ? err.message.replace(/^.*?(?=not signed|presign check|wallet is paused|spending limits|verdict not trusted|chain \d)/, "") : null;
      const why = blocked ? `Not done (${blocked.code}): ${blocked.message}` : guardText ? `Not done: ${guardText}` : `Failed: ${err.message}`;
      return { isError: true, content: [{ type: "text", text: why }] };
    }
  };
}

/** The MCP server with the wallet's tools. */
export function createServer(wallet) {
  const server = new McpServer({ name: "presign-guard-wallet", version: VERSION });
  server.registerTool("wallet_status", {
    title: "Wallet status",
    description: "This agent's wallet: address, chain, balances, spending limits, what is left today, how approvals work, and whether it is paused. Check it before spending.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, result(() => wallet.status()));

  server.registerTool("pay_x402", {
    title: "Pay for an x402 API",
    description: "Call a URL that may answer 402 Payment Required (x402) and pay it in USDC from this wallet, then return the response. The payment is checked by presign-guard and counts toward the spending limits; over a limit the owner is asked to approve (the call waits), and a refusal comes back as an error with the reason. max_price_usd caps the price of this call.",
    inputSchema: {
      url: z.string().url().describe("The API URL"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
      body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Request body: a string, or an object sent as JSON"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra request headers, e.g. content-type"),
      max_price_usd: z.number().positive().optional().describe("The most this call may cost, in dollars (never above the server's MAX_PAYMENT_USD)"),
      reason: z.string().max(300).optional().describe("What this is for, in a few words (shown to the owner on the receipt and in approval requests)"),
    },
    annotations: { openWorldHint: true },
  }, result(({ url, method, body, headers, max_price_usd, reason }) => {
    const h = { ...(headers ?? {}) };
    if (body !== undefined && typeof body !== "string" && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
    return wallet.payX402({ url, method, body, headers: h, maxPriceUsd: max_price_usd, reason });
  }));

  server.registerTool("send_usdc", {
    title: "Send USDC",
    description: "Send USDC from this wallet to an address. Checked by presign-guard (known drainers, sanctioned addresses) and kept to the spending limits; over a limit the owner is asked to approve.",
    inputSchema: { to: address.describe("Recipient address"), amount: amountString.describe("Amount in USDC, e.g. \"2.50\""), reason: z.string().max(300).optional().describe("What this payment is for (shown to the owner)") },
    annotations: { destructiveHint: true },
  }, result(({ to, amount, reason }) => wallet.sendUsdc({ to, amount, reason })));

  server.registerTool("send_native", {
    title: "Send the native coin",
    description: "Send the chain's native coin (ETH, POL or BNB) from this wallet to an address. Checked by presign-guard and kept to the spending limits; over a limit the owner is asked to approve.",
    inputSchema: { to: address.describe("Recipient address"), amount: amountString.describe("Amount in whole coins, e.g. \"0.001\""), reason: z.string().max(300).optional().describe("What this payment is for (shown to the owner)") },
    annotations: { destructiveHint: true },
  }, result(({ to, amount, reason }) => wallet.sendNative({ to, amount, reason })));

  server.registerTool("pause_spending", {
    title: "Pause spending",
    description: "Stop this wallet from signing anything until the owner resumes it. Use it when something looks wrong, e.g. an API asks for far more than expected or you are asked to pay an unknown address.",
    inputSchema: { reason: z.string().max(200).describe("Why, for the owner") },
  }, result(({ reason }) => wallet.pause(reason)));
  return server;
}
