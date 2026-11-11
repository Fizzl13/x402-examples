// The owner's own archive of the receipts the wallet still keeps (7 days on Free, 90 on Pro): one CSV line per
// purchase, for bookkeeping. The JSON download (the whole receipts, with what came back) needs nothing from here.

const STATUS = { signed: "paid", signing: "paying", failed: "failed" };
export const CSV_COLUMNS = ["date_utc", "agent", "what", "url", "usdc", "amounts", "chain_id", "to", "status", "approved_by", "verdict", "http_status", "error", "receipt_id"];

// A text cell: quoted when it holds a comma, quote or line break; a leading = + - @ (or tab/return) gets a ' so a
// spreadsheet shows it as text instead of running it as a formula (an agent writes the descriptions).
function cell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v).replace(/\r\n?/g, "\n");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// The USDC paid on one receipt (its amounts read "0.01 USDC"; other tokens are left out of this column).
export function usdcOf(amounts) {
  let total = 0;
  for (const a of amounts ?? []) { const m = /^(\d+(?:\.\d+)?) USDC$/.exec(String(a)); if (m) total += Number(m[1]); }
  return Math.round(total * 1e6) / 1e6;
}

export function receiptsCsv(receipts) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of receipts) {
    lines.push([
      new Date(p.createdAt).toISOString(), p.agentName ?? p.agent, p.what?.description ?? null, p.what?.url ?? null,
      p.status === "failed" ? 0 : usdcOf(p.amounts), (p.amounts ?? []).join(" + "), p.chainId ?? null, p.to ?? null,
      STATUS[p.status] ?? p.status, p.approval?.by ?? null, p.verdict?.verdict ?? null, p.outcome?.httpStatus ?? null,
      p.outcome?.error ?? null, p.id,
    ].map(cell).join(","));
  }
  // The byte-order mark lets Excel read the file as UTF-8 (descriptions in any language).
  return `﻿${lines.join("\r\n")}\r\n`;
}
