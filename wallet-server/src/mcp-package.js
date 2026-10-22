// The wallet MCP server as npx runs it, pinned to one version (presign-guard-wallet-mcp@0.20.0), read from the
// package next to this server. Every setup line we show uses it: without a version, npx fetches whatever is newest on
// each start, and that code sees the agent's key.
import { readFileSync } from "node:fs";

export const WALLET_MCP = (() => {
  try {
    return `presign-guard-wallet-mcp@${JSON.parse(readFileSync(new URL("../../wallet-mcp/package.json", import.meta.url), "utf8")).version}`;
  } catch {
    return "presign-guard-wallet-mcp";
  }
})();
