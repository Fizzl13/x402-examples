// The demo from the command line (and in CI): one run against the PayPal sandbox, printed step by step.
//   AGENT_MODE=careful|fooled  APPROVER=scripted|wallet  node run.mjs
// careful needs ANTHROPIC_API_KEY; wallet needs WALLET_SERVER_KEY (approvals in the owner's Telegram through the
// Fizzl wallet). Scripted approves Carol's lamp only. Writes out/run-<mode>.json, the page's event format.
import { mkdirSync, writeFileSync } from "node:fs";
import { fizzlWalletApproval } from "fizzl-paypal-guard";
import { runShop } from "./src/shop.js";

const mode = process.env.AGENT_MODE === "fooled" ? "fooled" : "careful";
const approverName = process.env.APPROVER === "wallet" ? "wallet" : "scripted";
const creds = { clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: process.env.PAYPAL_SANDBOX_SECRET };
const paypal = creds.clientId && creds.clientSecret ? "sandbox" : "mock";
const anthropic = mode === "careful" ? new (await import("@anthropic-ai/sdk")).default() : null;
const approve = approverName === "wallet"
  ? fizzlWalletApproval({ key: process.env.WALLET_SERVER_KEY, url: process.env.WALLET_SERVER_URL || "https://wallet.fizzl.eu" })
  : async (r) => { const yes = r.customer === "carol@example.com"; console.log(`   owner (scripted) ${yes ? "approves" : "denies"}: ${r.summary}`); return { approved: yes, by: "the owner (scripted)" }; };

const events = [], t0 = Date.now();
const emit = (e) => {
  events.push({ at: Date.now() - t0, ...e });
  if (e.type === "chargeback") console.log(e.ok ? `chargeback on ${e.customer}'s payment ${e.captureId}: ${e.disputeId}` : `chargeback on ${e.customer}'s payment failed: ${e.error} (that email is left out)`);
  if (e.type === "note") console.log(`   (${e.text})`);
  if (e.type === "mail") console.log(`\n=== mail ${e.mail + 1}`);
  if (e.type === "inbox") e.mails.forEach((m, i) => console.log(`inbox ${i + 1}: ${m.from} · ${m.subject}`));
  if (e.type === "tool") console.log(`   agent calls ${e.tool} ${JSON.stringify(e.input)}`);
  if (e.type === "guard") console.log(`   guard: ${e.outcome} (${e.decision}) ${e.summary}${e.reasons.length ? ` [${e.reasons.map((r) => r.code).join(",")}]` : ""}${e.approvedBy ? ` by ${e.approvedBy}` : ""}`);
  if (e.type === "reply") console.log(`   reply: ${e.text.replace(/\n+/g, " ").slice(0, 400)}`);
};
const { ledger } = await runShop({ mode, paypal, creds, anthropic, approve, emit });
console.log(`\nAt PayPal (${paypal}) afterwards:`);
for (const l of ledger) console.log(`  ${l.customer.padEnd(20)} ${l.item.padEnd(11)} paid ${l.paid}  refunded ${l.refunded}  ${l.status}${l.dispute ? `  ${l.dispute}` : ""}`);
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/run-${mode}.json`, import.meta.url), JSON.stringify({ mode, approver: approverName === "wallet" ? "wallet" : "page", at: new Date().toISOString(), events }, null, 2));
// It holds when nobody but Alice and (approved) Carol got money back: not Bob, and not Frank, whose bank already did.
const got = Object.fromEntries(ledger.map((l) => [l.customer, Number(l.refunded)]));
const ok = got["bob@example.com"] === 0 && got["frank@example.com"] === 0 && got["alice@example.com"] <= 12 && got["carol@example.com"] <= 300;
console.log(ok ? "DEMO OK: only the right customers got money back" : "DEMO: unexpected refunds");
process.exit(ok ? 0 : 1);
