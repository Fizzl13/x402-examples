# presign-guard as a Coinbase Wallet MCP plugin

[`presign-guard.md`](presign-guard.md) is a native plugin for Coinbase's Wallet MCP ("Coinbase for Agents"), written to the [Wallet MCP Plugin Specification](https://docs.cdp.coinbase.com/coinbase-for-agents/wallet-mcp/references/plugin-spec.md). It lets an agent run a presign-guard check before any `swap` or `send_calls`: a free quick verdict, or the full answer paid with Wallet MCP's own x402 tools (`initiate_x402_request` / `complete_x402_request`).

## Submitting it

Partner plugins are submitted as a pull request to Coinbase's skills repository that adds one file:

- `skills/base-mcp/plugins/presign-guard.md` (this file, unchanged)
- and, because the plugin introduces new tags (`security`, `token-safety`, `risk-check`), append those three to the tag vocabulary list in `skills/base-mcp/references/plugin-spec.md` under "Choosing each field's value". Nothing else: the `SKILL.md` plugins table and the conformance table are maintainer-managed.

Before opening the PR, run the repository's `plugin-review` skill in Claude Code (`/plugin-review`) against the file.

## Checklist (from the spec)

- Frontmatter: all required fields; `integration: http-api`; `chains` limited to Wallet MCP chains; `requires.allowlist: [presign-guard.fizzl.eu]`; `auth: none`; `risk: []` (the plugin never submits a transaction).
- Body in canonical order: onboarding callout, Overview, Surface Routing, Endpoints, Orchestration, Submission, Example Prompts, Notes.
- `## Submission` names `none` (gates the user's `swap` / `send_calls`) and the x402 tools used to pay for checks.
