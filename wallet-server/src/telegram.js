// Telegram for the wallet server: one bot for every account. Approval
// requests go to the chat an account linked (or, for the owner, to
// TELEGRAM_CHAT_ID). Button taps and /start links come back via a webhook (set
// on start), checked with Telegram's secret-token header; who may tap is
// decided by the accounts module. A bot with a webhook can't also be
// long-polled, so give the server its own bot (not the one an agent uses with
// telegramApprover).
const API = "https://api.telegram.org";
const escape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function createTelegram({ token, publicUrl, webhookSecret, dashboardUrl, username = null, fetch: fetchImpl = globalThis.fetch, api = API }) {
  const call = async (method, body) => {
    const res = await fetchImpl(`${api}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(`Telegram ${method}: ${data?.description ?? `HTTP ${res.status}`}`);
    return data.result;
  };
  const messages = new Map(); // approval id -> { chatId, messageId, body }, to edit after the decision

  const text = (a, spending) => {
    const lines = [`<b>${escape(a.agentName)} wants to sign something over your limit</b>`, "", escape(a.summary), "", `<code>${escape(a.method)}</code> · chain ${escape(a.chainId)}${a.to ? ` · to <code>${escape(a.to)}</code>` : ""}`];
    if (a.purchase?.description || a.purchase?.url) {
      lines.splice(3, 0, ...[a.purchase.description ? `for: ${escape(a.purchase.description)}` : null, a.purchase.url ? `<code>${escape(a.purchase.url)}</code>` : null].filter(Boolean), "");
    }
    lines.push(a.verdict ? `presign-guard: <b>${escape(a.verdict.verdict)}</b>${a.verdict.reasons?.length ? ` (${escape(a.verdict.reasons.join(", "))})` : ""}` : "presign-guard: no verified verdict");
    const s = (spending ?? []).map((x) => `${escape(x.token)} ${escape(x.used)}${x.perDay ? ` / ${escape(x.perDay)}` : ""}`).join(" · ");
    if (s) lines.push(`spent this window: ${s}`);
    if (dashboardUrl) lines.push("", `<a href="${escape(dashboardUrl)}">Open the dashboard</a>`);
    return lines.join("\n");
  };

  const tg = {
    get username() { return username; },
    async setup() {
      const me = await call("getMe", {}).catch(() => null);
      if (me?.username) username = me.username;
      if (!publicUrl || !webhookSecret) return false;
      await call("setWebhook", { url: `${publicUrl.replace(/\/$/, "")}/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ["callback_query", "message"], drop_pending_updates: true });
      return true;
    },
    async send(chatId, body) { await call("sendMessage", { chat_id: chatId, text: body, disable_web_page_preview: true }); },
    async notify(chatId, a, spending) {
      const body = text(a, spending);
      const sent = await call("sendMessage", {
        chat_id: chatId, text: body, parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `aw:${a.id}:y` }, { text: "Deny", callback_data: `aw:${a.id}:n` }]] },
      });
      messages.set(a.id, { chatId, messageId: sent.message_id, body });
    },
    // After any decision (dashboard, Telegram, expiry): update the message.
    async decided(a) {
      const m = messages.get(a.id);
      if (!m) return;
      messages.delete(a.id);
      const outcome = a.status === "approved" ? `<b>Approved (${escape(a.decidedBy)}): signing.</b>` : a.status === "denied" ? `<b>Denied (${escape(a.decidedBy)}): not signed.</b>` : "<b>No answer in time: not signed.</b>";
      await call("editMessageText", { chat_id: m.chatId, message_id: m.messageId, text: `${m.body}\n\n${outcome}`, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    },
    // The webhook: returns true when the request was really from Telegram.
    // on.decide(approvalId, "approve"|"deny", from) -> approval | { refused: true }; on.start(code, chat, from) -> reply text.
    async handleWebhook(headers, update, on) {
      if (!webhookSecret || headers["x-telegram-bot-api-secret-token"] !== webhookSecret) return false;
      const msg = update?.message;
      if (msg && typeof msg.text === "string") {
        const m = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9]{8,64}))?\s*$/.exec(msg.text.trim());
        if (m && on.start) {
          const reply = await on.start(m[1] ?? null, msg.chat, msg.from).catch(() => "Something went wrong. Try again from the dashboard.");
          await tg.send(msg.chat.id, reply).catch(() => {});
        }
        return true;
      }
      const q = update?.callback_query;
      const m = /^aw:(ap_[A-Za-z0-9_-]+):(y|n)$/.exec(q?.data ?? "");
      if (!m) return true;
      const a = await on.decide(m[1], m[2] === "y" ? "approve" : "deny", q.from).catch(() => null);
      const answer = a?.refused ? "You are not allowed to answer this." : !a ? "Not found." : a.status === "pending" ? "Still pending." : a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : "Too late: expired.";
      await call("answerCallbackQuery", { callback_query_id: q.id, text: answer }).catch(() => {});
      return true;
    },
  };
  return tg;
}
