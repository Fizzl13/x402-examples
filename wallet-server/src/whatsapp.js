// WhatsApp for the wallet server, next to Telegram: approval requests as an approved WhatsApp template with Approve and
// Deny buttons, through Meta's WhatsApp Cloud API. One business number serves every account.
//
// - Linking: the dashboard shows a wa.me link with a one-time code as the message; the owner sends it from their own
//   WhatsApp, the webhook receives it from their number (wa_id), and the account is linked to that number. Opting in
//   is the owner's own message, as WhatsApp requires.
// - Approvals: a template message (business-initiated, so it needs a template Meta approved; category Utility) with
//   three body variables (agent, what, details) and two quick-reply buttons whose payloads carry the approval id.
// - Button taps come back to the webhook, checked with Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with
//   the app secret); who may tap is decided by the accounts module. A tap opens WhatsApp's 24-hour window, so the
//   answer ("Approved: signing") is a plain text message.
// - Meta charges per delivered template message (Netherlands: about $0.05 for Utility, per Meta's rate card, 13 Nov
//   2026); plain replies inside the 24-hour window are free.
import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://graph.facebook.com";

// A template variable can't hold a newline, a tab or more than four spaces in a row, and must not be empty.
const variable = (s, max = 300) => {
  const v = String(s ?? "").replace(/[\r\n\t]+/g, " · ").replace(/ {2,}/g, " ").trim();
  return (v.length > max ? `${v.slice(0, max - 1)}…` : v) || "-";
};
const network = (id) => {
  const s = String(id ?? "");
  if (s.startsWith("algorand:")) return "Algorand";
  if (s.startsWith("xrpl:")) return s === "xrpl:1" ? "XRP Ledger testnet" : "XRP Ledger";
  return s ? `chain ${s}` : "";
};

// The message an owner sends to link their number: the dashboard pre-fills it, the webhook reads the code from it.
export const LINK_TEXT = "Connect my Fizzl wallet:";
const LINK_RE = /connect my fizzl wallet:?\s*([A-Za-z0-9_-]{8,64})\s*$/i;
const BUTTON_RE = /^aw:(ap_[A-Za-z0-9_-]+):(y|n)$/;

/** True when `signature` (X-Hub-Signature-256) is the HMAC-SHA256 of `rawBody` with `appSecret`. */
export function validSignature(appSecret, rawBody, signature) {
  if (!appSecret || !rawBody || typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  const want = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"), "utf8");
  const got = Buffer.from(signature.slice(7), "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * @param {object} o
 * @param {string} o.token          a system user's access token (whatsapp_business_messaging)
 * @param {string} o.phoneNumberId  the business number's id in the Cloud API
 * @param {string} o.appSecret      the Meta app's secret, for the webhook signature
 * @param {string} o.verifyToken    the token Meta sends when the webhook is set up
 * @param {string} o.number         the business number in international form, digits only (for the wa.me link)
 * @param {string} [o.template]     the approved template's name
 * @param {string} [o.language]     its language code
 */
export function createWhatsApp({ token, phoneNumberId, appSecret, verifyToken, number, template = "fizzl_payment_approval", language = "en", version = "v24.0", fetch: fetchImpl = globalThis.fetch, api = API }) {
  const enabled = !!(token && phoneNumberId && appSecret && verifyToken && number);
  const digits = String(number ?? "").replace(/\D/g, "");

  async function send(body) {
    const res = await fetchImpl(`${api}/${version}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) throw new Error(`WhatsApp: ${data?.error?.message ?? `HTTP ${res.status}`}`);
    return data?.messages?.[0]?.id ?? null;
  }

  // The three body variables of an approval: who asks, for what, and the details (network, payee, check, spending).
  function variables(a, spending) {
    if (a.action) {
      const kind = a.action.kind === "paypal" ? "PayPal" : a.action.kind;
      const details = [a.action.customer ? `customer ${a.action.customer}` : null, ...(a.reasons ?? []).map((r) => r.message)].filter(Boolean).join(" · ");
      return [variable(a.agentName, 60), variable(`${a.purchase?.description ?? a.summary} (${kind})`), variable(details || kind)];
    }
    const forWhat = [a.purchase?.description, a.purchase?.url].filter(Boolean).join(" · ");
    const s = (spending ?? []).map((x) => `${x.token} ${x.used}${x.perDay ? ` / ${x.perDay}` : ""}`).join(", ");
    const details = [
      `${a.method}${a.chainId ? ` on ${network(a.chainId)}` : ""}${a.to ? ` to ${a.to}` : ""}`,
      a.verdict ? `presign-guard: ${a.verdict.verdict}${a.verdict.reasons?.length ? ` (${a.verdict.reasons.join(", ")})` : ""}` : "presign-guard: no verified verdict",
      s ? `spent this window: ${s}` : null,
    ].filter(Boolean).join(" · ");
    return [variable(a.agentName, 60), variable(`${a.summary}${forWhat ? ` · for: ${forWhat}` : ""}`), variable(details)];
  }

  const wa = {
    enabled,
    // The link the dashboard shows: opens WhatsApp with the code as the message, to our number.
    linkUrl: (code) => `https://wa.me/${digits}?text=${encodeURIComponent(`${LINK_TEXT} ${code}`)}`,
    async text(to, body) { return send({ to, type: "text", text: { preview_url: false, body: String(body).slice(0, 4096) } }); },
    // An approval request: the template with Approve and Deny buttons.
    async notify(to, a, spending) {
      const [agent, what, details] = variables(a, spending);
      return send({
        to, type: "template",
        template: {
          name: template,
          language: { code: language },
          components: [
            { type: "body", parameters: [{ type: "text", text: agent }, { type: "text", text: what }, { type: "text", text: details }] },
            { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `aw:${a.id}:y` }] },
            { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `aw:${a.id}:n` }] },
          ],
        },
      });
    },
    // Meta's webhook check when the URL is set up: the challenge back, or null.
    verify(query) {
      return verifyToken && query?.["hub.mode"] === "subscribe" && query?.["hub.verify_token"] === verifyToken ? String(query["hub.challenge"] ?? "") : null;
    },
    // A webhook delivery: returns false when the signature isn't Meta's. For each message: a link code
    // (on.start(code, from) -> reply text) or a button tap (on.decide(approvalId, "approve"|"deny", from) -> approval |
    // { refused: true }); the answer goes back as a plain text in the window the owner's message opened.
    // from = { waId, name }.
    async handleWebhook(rawBody, signature, on) {
      if (!enabled || !validSignature(appSecret, rawBody, signature)) return false;
      let update;
      try { update = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody)); } catch { return true; }
      for (const entry of update?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value ?? {};
          const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
          for (const m of value.messages ?? []) {
            const from = { waId: String(m.from ?? ""), name: names.get(m.from) ?? null };
            if (!from.waId) continue;
            const payload = m.type === "button" ? m.button?.payload : m.type === "interactive" ? m.interactive?.button_reply?.id : null;
            const tap = BUTTON_RE.exec(payload ?? "");
            let reply = null;
            if (tap) {
              const a = await on.decide(tap[1], tap[2] === "y" ? "approve" : "deny", from).catch(() => null);
              reply = a?.refused ? "You are not allowed to answer this request." : !a ? "That request wasn't found." : a.status === "pending" ? "Still pending." : a.status === "approved" ? `Approved: ${a.action ? "going ahead" : "signing"}.` : a.status === "denied" ? `Denied: ${a.action ? "not done" : "not signed"}.` : "Too late: the request expired, nothing was signed.";
            } else if (m.type === "text" && on.start) {
              const link = LINK_RE.exec(m.text?.body ?? "");
              reply = await Promise.resolve(on.start(link ? link[1] : null, from)).catch(() => "Something went wrong. Try again from the dashboard.");
            }
            if (reply) await wa.text(from.waId, reply).catch((err) => console.warn(`[whatsapp] reply: ${err.message}`));
          }
        }
      }
      return true;
    },
  };
  return wa;
}
