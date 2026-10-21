// Ways to ask the owner. Each is an async function (request) -> { approved, by } that the guard calls when an
// action is over a limit; no answer in time means no. A request is { id, agent, tool, summary, reasons, customer }.
import { createInterface } from "node:readline/promises";

const reasonsText = (r) => r.reasons.map((x) => `• ${x.message}`).join("\n");

// In the terminal, for local tries: the owner types y.
export function consoleApproval({ input = process.stdin, output = process.stdout } = {}) {
  return async (r) => {
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(`\n🔔 ${r.agent} wants to ${r.summary}\n${reasonsText(r)}\nApprove? (y/N) `);
      return { approved: /^y(es)?$/i.test(answer.trim()), by: "console" };
    } finally { rl.close(); }
  };
}

// On the owner's phone, with Approve and Deny buttons from a Telegram bot of their own (BotFather). The bot
// must have no webhook: the answers are read with getUpdates. Only taps in `chatId` count.
export function telegramApproval({ token, chatId, timeoutMs = 10 * 60_000, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!token || !chatId) throw new TypeError("telegramApproval: token and chatId are required");
  const api = async (method, body) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
    return json.result;
  };
  const waiting = new Map(); // approval id -> { resolve, messageId, text }
  let offset = 0, polling = null;

  async function poll() {
    while (waiting.size) {
      let updates = [];
      try { updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["callback_query"] }); } catch (err) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const cq = u.callback_query, m = /^pg:([\w-]{1,40}):([yn])$/.exec(cq?.data ?? "");
        if (!m || String(cq.message?.chat?.id) !== String(chatId) || !waiting.has(m[1])) continue;
        const w = waiting.get(m[1]);
        waiting.delete(m[1]);
        const approved = m[2] === "y", by = `telegram:${cq.from?.username ?? cq.from?.id ?? "owner"}`;
        await api("answerCallbackQuery", { callback_query_id: cq.id, text: approved ? "Approved" : "Denied" }).catch(() => {});
        await api("editMessageText", { chat_id: chatId, message_id: w.messageId, text: `${w.text}\n\n${approved ? "✅ Approved" : "❌ Denied"}` }).catch(() => {});
        w.resolve({ approved, by });
      }
    }
    polling = null;
  }

  return async (r) => {
    const text = `🔔 ${r.agent} wants to ${r.summary}${r.customer ? `\nCustomer in this conversation: ${r.customer}` : ""}\n\n${reasonsText(r)}\n\nNo answer in ${Math.round(timeoutMs / 60_000)} min means no.`;
    const msg = await api("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `pg:${r.id}:y` }, { text: "❌ Deny", callback_data: `pg:${r.id}:n` }]] } });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!waiting.delete(r.id)) return;
        api("editMessageText", { chat_id: chatId, message_id: msg.message_id, text: `${text}\n\n⌛ No answer: not done` }).catch(() => {});
        resolve({ approved: false, by: "timeout" });
      }, timeoutMs);
      waiting.set(r.id, { messageId: msg.message_id, text, resolve: (v) => { clearTimeout(timer); resolve(v); } });
      polling ??= poll();
    });
  };
}
