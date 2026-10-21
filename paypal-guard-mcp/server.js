#!/usr/bin/env node
// fizzl-paypal-guard-mcp: PayPal's Agent Toolkit for any MCP client (Claude Desktop, Claude Code, Cursor, …), with
// fizzl-paypal-guard checking every call that moves money. Configured with environment variables; see README.md.
// Speaks MCP over stdio, logs to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, serverFromConfig, VERSION } from "./lib.js";

let config;
try {
  config = configFromEnv(process.env, process.argv.slice(2));
} catch (err) {
  console.error(`[fizzl-paypal-guard-mcp] ${err.message}`);
  process.exit(1);
}
const log = (e) => console.error(`[fizzl-paypal-guard] ${e.outcome}: ${e.summary}${e.reasons?.length ? ` (${e.reasons.map((r) => r.message).join("; ")})` : ""}${e.approvedBy ? `, ${e.approvedBy}` : ""}`);
await serverFromConfig(config, { log }).connect(new StdioServerTransport());
const ask = { fizzl: "approvals in the Fizzl wallet (Telegram)", telegram: "approvals on Telegram", chat: "approvals in the chat app (MCP elicitation)", none: "no approvals: over a limit is not done" }[config.approval.kind];
console.error(config.setup
  ? `[fizzl-paypal-guard-mcp ${VERSION}] not set up: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. The tools are listed; each call says how to set it up.`
  : `[fizzl-paypal-guard-mcp ${VERSION}] PayPal ${config.sandbox ? "sandbox" : "LIVE"}, ${ask}, limits kept in ${config.limitsFile}`);
