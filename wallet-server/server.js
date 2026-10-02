// Agent wallet server: one budget and one set of rules for all your agents,
// approvals on the dashboard and on Telegram. It never holds keys or funds:
// agents sign and pay themselves (presign-guard-wallet with `server`).
// The owner signs in with ADMIN_PASSWORD; customers sign in with their
// wallet and get their own space (Free, or Pro paid in USDC on Base).
//
// Environment (Render only, never in code):
//   ADMIN_PASSWORD      dashboard login (12+ characters)
//   WALLET_REDIS_URL    persistent Redis (rediss://…); without it, state is in memory (dev only)
//   PUBLIC_URL          e.g. https://wallet.fizzl.eu (for the Telegram webhook and links)
//   TELEGRAM_BOT_TOKEN  optional: a bot only this server uses
//   TELEGRAM_CHAT_ID    your Telegram user id
//   TELEGRAM_WEBHOOK_SECRET  optional; random letters/digits, checked on every webhook call
//   SESSION_SECRET      optional: signs dashboard sessions (else ADMIN_PASSWORD)
//   PRO_PAY_TO          the address Pro payments go to (default: Fizzl's payout address)
//   PRO_PRICE_USDC      Pro per 30 days (default 5)
//   BASE_RPC_URL        optional: a Base RPC to check payments (default https://mainnet.base.org)
//   WALLET_SIGNIN       "off" for a private, owner-only server (no customer sign-in)
//   OPERATOR_NAME       who runs the service, shown in the privacy statement (/privacy)
//   CONTACT_EMAIL       where customers reach you about their data, shown in the privacy statement
//   SUBSCRIPTION_CONTRACT  optional: the deployed FizzlSubscription address (automatic Pro payments)
//   CHARGER_KEY         optional: private key of a small, separate wallet with a little ETH on Base that
//                       sends the monthly charge transactions (never your payout wallet)
import { createHash } from "node:crypto";
import { createApp } from "./src/app.js";
import { createAuth } from "./src/auth.js";
import { createAccounts } from "./src/accounts.js";
import { memoryStore, redisStore } from "./src/store.js";
import { createTelegram } from "./src/telegram.js";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const env = process.env;
const store = env.WALLET_REDIS_URL ? await redisStore(env.WALLET_REDIS_URL.trim()) : (console.warn("[store] WALLET_REDIS_URL not set: state lives in memory and is lost on restart"), memoryStore());

let telegram = null;
if (env.TELEGRAM_BOT_TOKEN) {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET || createHash("sha256").update(`aw-webhook:${env.TELEGRAM_BOT_TOKEN}`).digest("hex").slice(0, 48);
  telegram = createTelegram({ token: env.TELEGRAM_BOT_TOKEN.trim(), publicUrl: env.PUBLIC_URL, webhookSecret, dashboardUrl: env.PUBLIC_URL });
  telegram.setup().then((ok) => console.log(ok ? `[telegram] webhook set (@${telegram.username})` : "[telegram] PUBLIC_URL not set: messages go out, but button taps can't come back"), (err) => console.warn(`[telegram] ${err.message}`));
}

// Automatic Pro payments: the subscription contract, and a small wallet that sends the monthly
// charge transactions (it only needs a little ETH on Base for gas; it never receives the payments,
// and its key can do nothing but trigger charges that are due anyway).
const rpcUrl = env.BASE_RPC_URL || "https://mainnet.base.org";
let charger = null;
if (env.CHARGER_KEY) {
  const account = privateKeyToAccount(env.CHARGER_KEY.trim());
  const client = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  charger = { address: account.address, send: (to, data) => client.sendTransaction({ to, data }) };
  console.log(`[subscription] charger ${account.address}`);
}

const accounts = createAccounts({
  store,
  telegram,
  adminChatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT ?? 3000}`,
  billing: { payTo: env.PRO_PAY_TO || "0x6B0F4651eD42893ab58139938175E4a69f175F25", priceUsdc: Number(env.PRO_PRICE_USDC || 5), rpcUrl, subscription: env.SUBSCRIPTION_CONTRACT?.trim() || null, charger },
  walletOptions: { signers: [...new Set([...(env.EXTRA_SIGNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean), "0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE"])] },
});
const auth = createAuth({ password: env.ADMIN_PASSWORD, secret: env.SESSION_SECRET, secure: env.NODE_ENV !== "development" });
const app = createApp({ accounts, auth, telegram, signInWithWallet: env.WALLET_SIGNIN !== "off", operator: { name: env.OPERATOR_NAME?.trim() || null, email: env.CONTACT_EMAIL?.trim() || null } });
const port = Number(env.PORT ?? 3000);
app.listen(port, () => console.log(`[wallet-server] on :${port}${telegram ? " · telegram on" : ""}`));

// Every hour: take automatic payments that are due, then send Pro reminders on Telegram.
const hourly = async () => {
  try { const r = await accounts.chargeDue(); if (r.charged || r.failed) console.log(`[subscription] charged ${r.charged}, failed ${r.failed}`); } catch (err) { console.warn(`[subscription] ${err.message}`); }
  try { await accounts.remind(); } catch (err) { console.warn(`[remind] ${err.message}`); }
};
setTimeout(hourly, 60_000).unref();
setInterval(hourly, 3_600_000).unref();
