#!/usr/bin/env node
// presign-guard-wallet-mcp: a wallet with spending limits for any MCP client
// (Claude Desktop, Claude Code, Cursor, …). Configured with environment
// variables; see README.md. Speaks MCP over stdio, logs to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createServer, createWallet, VERSION } from "./lib.js";

let config;
try {
  config = configFromEnv();
} catch (err) {
  console.error(`[presign-guard-wallet-mcp] ${err.message}`);
  process.exit(1);
}
const wallet = createWallet(config);
await createServer(wallet).connect(new StdioServerTransport());
console.error(`[presign-guard-wallet-mcp ${VERSION}] wallet ${wallet.address} on ${config.chainName}, ${config.server ? `limits on ${config.server.url}` : `limits ${JSON.stringify(config.limits.tokens)}`}${config.telegram ? ", approvals on Telegram" : ""}`);
