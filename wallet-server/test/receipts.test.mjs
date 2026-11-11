import test from "node:test";
import assert from "node:assert/strict";
import { receiptsCsv, usdcOf } from "../src/receipts.js";

test("receipts CSV: one line per receipt, quoted where needed, no formulas from an agent's description", () => {
  const csv = receiptsCsv([
    { id: "pu_1", agentName: "claude", createdAt: Date.UTC(2026, 10, 11, 18, 30), what: { description: 'BTC "signal", daily', url: "https://a.example/x?y=1" }, amounts: ["0.01 USDC"], chainId: 8453, to: "0xabc", status: "signed", approval: { by: "telegram" }, verdict: { verdict: "green" }, outcome: { httpStatus: 200 } },
    { id: "pu_2", agentName: "bot", createdAt: Date.UTC(2026, 10, 10), what: { description: "=HYPERLINK(\"https://evil\")" }, amounts: ["0.5 USDC"], status: "failed", outcome: { error: "rpc down\nretry" } },
    { id: "pu_3", agent: "ag_x", createdAt: Date.UTC(2026, 10, 9), what: null, amounts: ["1 RLUSD", "0.02 USDC"], status: "signing" },
  ]);
  assert.ok(csv.startsWith("﻿date_utc,agent,what,url,usdc,amounts,chain_id,to,status,approved_by,verdict,http_status,error,receipt_id\r\n"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '2026-11-11T18:30:00.000Z,claude,"BTC ""signal"", daily",https://a.example/x?y=1,0.01,0.01 USDC,8453,0xabc,paid,telegram,green,200,,pu_1');
  // A failed payment paid nothing; a description that starts with = is text, not a formula.
  assert.equal(lines[2], `2026-11-10T00:00:00.000Z,bot,"'=HYPERLINK(""https://evil"")",,0,0.5 USDC,,,failed,,,,"rpc down\nretry",pu_2`);
  assert.equal(lines[3], "2026-11-09T00:00:00.000Z,ag_x,,,0.02,1 RLUSD + 0.02 USDC,,,paying,,,,,pu_3");
  assert.equal(usdcOf(["0.1 USDC", "0.2 USDC"]), 0.3);
  assert.equal(usdcOf(null), 0);
});
