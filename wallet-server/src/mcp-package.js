// The wallet MCP server as npx runs it, pinned to one version (presign-guard-wallet-mcp@0.23.0). Every setup line we
// show uses it: without a version, npx fetches whatever is newest on each start, and that code sees the agent's key.
// The version is kept in mcp-version.json here, not read from ../wallet-mcp: Render deploys this server only when a
// file under wallet-server/ changes, so a new wallet-mcp version has to change one (wallet-mcp's tests check they match).
import { readFileSync } from "node:fs";

export const WALLET_MCP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./mcp-version.json", import.meta.url), "utf8")).version;
  } catch {
    return null;
  }
})();
export const WALLET_MCP = WALLET_MCP_VERSION ? `presign-guard-wallet-mcp@${WALLET_MCP_VERSION}` : "presign-guard-wallet-mcp";

// The same version as a Claude Desktop bundle (.mcpb): a GitHub release of x402-examples, made by wallet-mcp.yml.
export const WALLET_MCPB = WALLET_MCP_VERSION ? `https://github.com/Fizzl13/x402-examples/releases/download/wallet-mcp-v${WALLET_MCP_VERSION}/fizzl-wallet.mcpb` : "https://github.com/Fizzl13/x402-examples/releases";
