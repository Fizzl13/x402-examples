// Approval requests on Telegram, sent by the server. Button taps come back via
// a webhook (set on start), checked with Telegram's secret-token header and the
// owner's user id. A bot with a webhook can't also be long-polled, so give the
// server its own bot (not the one an agent uses with telegramApprover).
const API = "https://api.telegram.org";
const escape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function createTelegram({ token, chatId, publicUrl, webhookSecret, dashboardUrl, fetch: fetchImpl = globalThis.fetch, api = API }) {
  const call = async (method, body) => {
    const res = await fetchImpl(`${api}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(`Telegram ${method}: ${data?.description ?? `HTTP ${res.status}`}`);
    return data.result;
  };
  const messages = new Map(); // approval id -> message id, to edit after the decision

  const text = (a, spending) => {
    const lines = [`<b>${escape(a.agentName)} wants to sign something over your limit</b>`, "", escape(a.summary), "", `<code>${escape(a.method)}</code> · chain ${escape(a.chainId)}${a.to ? ` · to <code>${escape(a.to)}</code>` : ""}`];
    lines.push(a.verdict ? `presign-guard: <b>${escape(a.verdict.verdict)}</b>${a.verdict.reasons?.length ? ` (${escape(a.verdict.reasons.join(", "))})` : ""}` : "presign-guard: no verified verdict");
    const s = (spending ?? []).map((x) => `${escape(x.token)} ${escape(x.used)}${x.perDay ? ` / ${escape(x.perDay)}` : ""}`).join(" · ");
    if (s) lines.push(`spent this window: ${s}`);
    if (dashboardUrl) lines.push("", `<a href="${escape(dashboardUrl)}">Open the dashboard</a>`);
    return lines.join("\n");
  };

  return {
    async setup() {
      if (!publicUrl || !webhookSecret) return false;
      await call("setWebhook", { url: `${publicUrl.replace(/\/$/, "")}/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ["callback_query"], drop_pending_updates: true });
      return true;
    },
    async notify(a, spending) {
      const sent = await call("sendMessage", {
        chat_id: chatId, text: text(a, spending), parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `aw:${a.id}:y` }, { text: "Deny", callback_data: `aw:${a.id}:n` }]] },
      });
      messages.set(a.id, { messageId: sent.message_id, body: text(a, spending) });
    },
    // After any decision (dashboard, Telegram, expiry): update the message.
    async decided(a) {
      const m = messages.get(a.id);
      if (!m) return;
      messages.delete(a.id);
      const outcome = a.status === "approved" ? `<b>Approved (${escape(a.decidedBy)}): signing.</b>` : a.status === "denied" ? `<b>Denied (${escape(a.decidedBy)}): not signed.</b>` : "<b>No answer in time: not signed.</b>";
      await call("editMessageText", { chat_id: chatId, message_id: m.messageId, text: `${m.body}\n\n${outcome}`, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    },
    // The webhook: returns true when the request was really from Telegram.
    async handleWebhook(headers, update, decide) {
      if (!webhookSecret || headers["x-telegram-bot-api-secret-token"] !== webhookSecret) return false;
      const q = update?.callback_query;
      const m = /^aw:(ap_[A-Za-z0-9_-]+):(y|n)$/.exec(q?.data ?? "");
      if (!m) return true;
      if (String(q.from?.id) !== String(chatId)) {
        await call("answerCallbackQuery", { callback_query_id: q.id, text: "You are not allowed to answer this." }).catch(() => {});
        return true;
      }
      const who = q.from?.username ? `@${q.from.username}` : "Telegram";
      const a = await decide(m[1], m[2] === "y" ? "approve" : "deny", who).catch(() => null);
      await call("answerCallbackQuery", { callback_query_id: q.id, text: !a ? "Not found." : a.status === "pending" ? "Still pending." : a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : "Too late: expired." }).catch(() => {});
      return true;
    },
  };
}
