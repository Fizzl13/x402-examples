#!/usr/bin/env node
// presign-guard-wallet-mcp: a wallet with spending limits for any MCP client
// (Claude Desktop, Claude Code, Cursor, …). Configured with environment
// variables; see README.md. Speaks MCP over stdio, logs to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createServer, createWallet, linkedEnv, linkingWallet, setupWallet, SETUP_MESSAGE, VERSION } from "./lib.js";

const describe = (wallet, config) => `wallet ${wallet.address} on ${config.chainName}, ${config.server ? `limits on ${config.server.url}` : `limits ${JSON.stringify(config.limits.tokens)}`}${config.ac2 ? ", approvals signed in your wallet over AC2" : config.telegram ? ", approvals on Telegram" : ""}`;
const fail = (err) => { console.error(`[presign-guard-wallet-mcp] ${err.message}`); process.exit(1); };

// Without AGENT_KEY (or AGENT_KEY_FILE) the wallet links itself with a code: it makes its own key in ~/.fizzl and
// each tool answers with a code for the owner to enter on the dashboard, until they do (then it works, no restart).
// Once linked, it starts from those files. LINKING=off keeps the setup mode: the tools only say how to add a key.
// Any other configuration error stops it.
const keyless = !process.env.AGENT_KEY?.trim() && !process.env.AGENT_KEY_FILE?.trim();
if (keyless && /^(off|0|false|no)$/i.test(process.env.LINKING ?? "")) {
  await createServer(setupWallet()).connect(new StdioServerTransport());
  console.error(`[presign-guard-wallet-mcp ${VERSION}] ${SETUP_MESSAGE}`);
} else {
  let env = process.env;
  try { if (keyless) env = linkedEnv(); } catch (err) { fail(err); }
  if (!env) {
    let current = linkingWallet(process.env, {
      onLinked: () => {
        try {
          const config = configFromEnv(linkedEnv());
          current = createWallet(config);
          console.error(`[presign-guard-wallet-mcp ${VERSION}] ${describe(current, config)}`);
        } catch (err) { console.error(`[presign-guard-wallet-mcp] linked, but ${err.message}. Restart the app.`); }
      },
    });
    // The tools keep one wallet object; behind it, the linking wallet makes way for the real one.
    await createServer(new Proxy({}, { get: (_t, k) => current[k] })).connect(new StdioServerTransport());
    console.error(`[presign-guard-wallet-mcp ${VERSION}] not linked yet: ask for the wallet status to get a code`);
  } else {
    let config;
    try { config = configFromEnv(env); } catch (err) { fail(err); }
    const wallet = createWallet(config);
    await createServer(wallet).connect(new StdioServerTransport());
    console.error(`[presign-guard-wallet-mcp ${VERSION}] ${describe(wallet, config)}`);
  }
}
