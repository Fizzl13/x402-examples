// E-mail out, for sign-in codes: Resend's HTTP API (https://resend.com), no extra packages.
// Off unless RESEND_API_KEY is set. The sender (MAIL_FROM) must be on a domain verified at Resend.
export function createMailer({ apiKey, from = "Fizzl wallet <noreply@fizzl.eu>", fetch = globalThis.fetch }) {
  if (!apiKey) return null;
  return {
    async send(to, subject, text) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`mail service answered ${res.status}`);
    },
  };
}
