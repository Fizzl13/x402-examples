// Agent wallet server: one budget and one set of rules for all your agents,
// approvals on the dashboard and on Telegram. It never holds keys or funds:
// agents sign and pay themselves (presign-guard-wallet with `server`).
// The owner signs in with ADMIN_PASSWORD; customers sign in with their
// wallet and get their own space (Free, or Pro paid in USDC).
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
//   OPERATOR_ADDRESS    the address you trade from (street, postcode, town), shown in the terms (consumer law asks for it)
//   SUBSCRIPTION_CONTRACT  optional: the deployed FizzlSubscription address (automatic Pro payments)
//   ETHEREUM_RPC_URL, ARBITRUM_RPC_URL, OPTIMISM_RPC_URL, POLYGON_RPC_URL
//                       optional: RPCs to check Pro payments on those networks (public ones by default)
//   X402_DISCOVERY_URL  optional: the x402 catalog the search bar searches (default Coinbase's Bazaar)
//   X402_TRUST_INDEX_URL optional: x402 Doctor's Trust Index, to rank sellers by track record (default its public file)
//   SOLANA_PAY_TO       optional: the Solana address that receives Pro payments; turns on sign-in
//                       with Phantom on Solana and paying Pro in USDC on Solana
//   SOLANA_RPC_URL      optional: a Solana RPC to build and check those payments (default api.mainnet-beta.solana.com)
//   USAGE_LOG_TOKEN     optional: anonymous usage statistics to the private usage-log repo (a fine-grained
//                       GitHub token, Contents read/write on that repo only; the same as the other services)
//   USAGE_LOG_SALT, USAGE_LOG_REPO, USAGE_OWN_WALLETS  optional: see src/usage.js
//   RESEND_API_KEY      optional: turns on signing in with e-mail (a 6-digit code mailed through Resend)
//   MAIL_FROM           optional: the sender, on a domain verified at Resend (default "Fizzl wallet <noreply@fizzl.eu>")
//   VAPID_PRIVATE_KEY   optional: the key that signs phone notifications (32 bytes, base64url); by default it
//                       is derived from SESSION_SECRET / ADMIN_PASSWORD
//   CHARGER_KEY         optional: private key of a small, separate wallet with a little ETH on Base that
//                       sends the monthly charge transactions (never your payout wallet)
import { createHash } from "node:crypto";
import { createApp } from "./src/app.js";
import { createAuth } from "./src/auth.js";
import { createAccounts } from "./src/accounts.js";
import { memoryStore, redisStore } from "./src/store.js";
import { createTelegram } from "./src/telegram.js";
import { createPush } from "./src/push.js";
import { createMailer } from "./src/mail.js";
import { createCatalog, createSkillChecker } from "./src/catalog.js";
import { createTrustIndex } from "./src/trust.js";
import { createUsage } from "./src/usage.js";
import { createStats } from "./src/stats.js";
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

// Notifications on phones and computers where the dashboard is installed as an app (no setup needed:
// the key comes from VAPID_PRIVATE_KEY, or else from the session secret).
const pushSeed = env.SESSION_SECRET || env.ADMIN_PASSWORD;
const push = env.VAPID_PRIVATE_KEY || pushSeed ? createPush({ privateKey: env.VAPID_PRIVATE_KEY?.trim() || null, seed: pushSeed, subject: env.PUBLIC_URL?.startsWith("https://") ? env.PUBLIC_URL.replace(/\/$/, "") : "https://wallet.fizzl.eu" }) : null;

const usage = createUsage({ token: env.USAGE_LOG_TOKEN?.trim() || null, repo: env.USAGE_LOG_REPO || undefined, salt: env.USAGE_LOG_SALT || null, ownWallets: (env.USAGE_OWN_WALLETS ?? "").split(",") });
if (!usage.enabled) console.warn("[usage] USAGE_LOG_TOKEN not set: usage statistics are off");
const accounts = createAccounts({
  usage,
  store,
  telegram,
  push,
  mailer: createMailer({ apiKey: env.RESEND_API_KEY?.trim() || null, from: env.MAIL_FROM?.trim() || undefined }),
  adminChatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT ?? 3000}`,
  billing: { payTo: env.PRO_PAY_TO || "0x6B0F4651eD42893ab58139938175E4a69f175F25", priceUsdc: Number(env.PRO_PRICE_USDC || 5), price20Usdc: Number(env.PRO20_PRICE_USDC || 9), priceUnlimitedUsdc: Number(env.PRO_UNLIMITED_PRICE_USDC || 20), rpcUrl, subscription: env.SUBSCRIPTION_CONTRACT?.trim() || null, charger,
    chains: Object.fromEntries([[1, env.ETHEREUM_RPC_URL], [42161, env.ARBITRUM_RPC_URL], [10, env.OPTIMISM_RPC_URL], [137, env.POLYGON_RPC_URL]].filter(([, u]) => u).map(([id, rpcUrl]) => [id, { rpcUrl }])),
    solana: env.SOLANA_PAY_TO?.trim() ? { payTo: env.SOLANA_PAY_TO.trim(), rpcUrl: env.SOLANA_RPC_URL || undefined } : null },
  walletOptions: { signers: [...new Set([...(env.EXTRA_SIGNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean), "0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE"])] },
});
const auth = createAuth({ password: env.ADMIN_PASSWORD, secret: env.SESSION_SECRET, secure: env.NODE_ENV !== "development" });
// New sellers in the catalog go to the Telegram of accounts that follow their category.
const catalog = createCatalog({ url: env.X402_DISCOVERY_URL || undefined, seen: store.global, skills: createSkillChecker(), trust: createTrustIndex({ url: env.X402_TRUST_INDEX_URL || undefined }),
  onNew: async (providers) => { const n = await accounts.alertNewProviders(providers); console.log(`[catalog] ${providers.length} new provider(s), ${n} alert(s) sent`); } });
const stats = createStats({ token: env.USAGE_LOG_TOKEN?.trim() || null, repo: env.USAGE_LOG_REPO || undefined });
const app = createApp({ accounts, auth, telegram, catalog, usage, stats, signInWithWallet: env.WALLET_SIGNIN !== "off", operator: { name: env.OPERATOR_NAME?.trim() || null, email: env.CONTACT_EMAIL?.trim() || null, address: env.OPERATOR_ADDRESS?.trim() || null } });
const port = Number(env.PORT ?? 3000);
app.listen(port, () => console.log(`[wallet-server] on :${port}${telegram ? " · telegram on" : ""}`));

// Every hour: take automatic payments that are due, send Pro reminders (and refund reminders to you) on Telegram, look for new sellers in the catalog, check the sellers' watched x402 endpoints, and on Monday morning send you the weekly summary.
const hourly = async () => {
  try { const r = await accounts.chargeDue(); if (r.charged || r.failed) console.log(`[subscription] charged ${r.charged}, failed ${r.failed}`); } catch (err) { console.warn(`[subscription] ${err.message}`); }
  try { await accounts.remind(); } catch (err) { console.warn(`[remind] ${err.message}`); }
  try { await accounts.remindRefunds(); } catch (err) { console.warn(`[refunds] ${err.message}`); }
  try { await catalog.refresh(); } catch (err) { console.warn(`[catalog] ${err.message}`); }
  try { const n = await accounts.checkMonitors(); if (n) console.log(`[monitor] checked ${n} endpoint(s)`); } catch (err) { console.warn(`[monitor] ${err.message}`); }
  try { await accounts.weeklyDigest({ summary: stats.enabled ? await stats.summary(7).catch(() => null) : null }); } catch (err) { console.warn(`[digest] ${err.message}`); }
};
setTimeout(hourly, 60_000).unref();
setInterval(hourly, 3_600_000).unref();
