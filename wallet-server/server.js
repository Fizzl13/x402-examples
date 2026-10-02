// Agent wallet server: one budget and one set of rules for all your agents,
// approvals on the dashboard and on Telegram. It never holds keys or funds:
// agents sign and pay themselves (presign-guard-wallet with `server`).
//
// Environment (Render only, never in code):
//   ADMIN_PASSWORD      dashboard login (12+ characters)
//   WALLET_REDIS_URL    persistent Redis (rediss://…); without it, state is in memory (dev only)
//   PUBLIC_URL          e.g. https://wallet.fizzl.eu (for the Telegram webhook and links)
//   TELEGRAM_BOT_TOKEN  optional: a bot only this server uses
//   TELEGRAM_CHAT_ID    your Telegram user id
//   TELEGRAM_WEBHOOK_SECRET  optional; random letters/digits, checked on every webhook call
import { createHash } from "node:crypto";
import { createApp } from "./src/app.js";
import { createAuth } from "./src/auth.js";
import { createWallet } from "./src/wallet.js";
import { memoryStore, redisStore } from "./src/store.js";
import { createTelegram } from "./src/telegram.js";

const env = process.env;
const store = env.WALLET_REDIS_URL ? await redisStore(env.WALLET_REDIS_URL.trim()) : (console.warn("[store] WALLET_REDIS_URL not set: state lives in memory and is lost on restart"), memoryStore());

let telegram = null;
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET || createHash("sha256").update(`aw-webhook:${env.TELEGRAM_BOT_TOKEN}`).digest("hex").slice(0, 48);
  telegram = createTelegram({ token: env.TELEGRAM_BOT_TOKEN.trim(), chatId: env.TELEGRAM_CHAT_ID.trim(), publicUrl: env.PUBLIC_URL, webhookSecret, dashboardUrl: env.PUBLIC_URL });
  telegram.setup().then((ok) => console.log(ok ? "[telegram] webhook set" : "[telegram] PUBLIC_URL not set: messages go out, but button taps can't come back"), (err) => console.warn(`[telegram] ${err.message}`));
}

const wallet = createWallet({
  store,
  notify: telegram ? (a, spending) => telegram.notify(a, spending) : undefined,
  onSettled: telegram ? (a) => telegram.decided(a) : undefined,
  signers: [...new Set([...(env.EXTRA_SIGNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean), "0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE"])],
});
const app = createApp({ wallet, auth: createAuth({ password: env.ADMIN_PASSWORD, secure: env.NODE_ENV !== "development" }), telegram });
const port = Number(env.PORT ?? 3000);
app.listen(port, () => console.log(`[wallet-server] on :${port}${telegram ? " · telegram on" : ""}`));
