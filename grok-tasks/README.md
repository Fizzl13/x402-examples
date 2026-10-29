# Grok tasks

Frits's scheduled Grok tasks, run by `.github/workflows/grok-tasks.yml` through xAI's Responses API:

| Task | What | When (UTC) |
|---|---|---|
| A | x402 scan: new x402 sellers on X, checked with x402 Doctor's free check | daily 17:41 |
| B | Scam watch: risky tokens and claim links on X, checked with presign-guard's free checks | daily 18:13 |
| D | Help desk: people with x402 payment problems on X, with reply drafts | every third day 18:37 |

Grok searches X itself (`x_search`) and gets only Fizzl's free MCP tools (`x402_quick_check`, `token_quick_verdict`,
`injection_quick_check`). It has no wallet and no paid tool, so it can't pay, sign, post or message anyone. The
report goes to the owner's Telegram through the wallet server's `/hooks/owner-report` (secret `DRAFT_KEY`), with the
tokens used and an estimate of their price; `x_search` costs $5 per 1,000 posts on top (docs.x.ai pricing).

Setup: add the repository secret `XAI_API_KEY` (an API key from console.x.ai). Without it the runs do nothing.

By hand: Actions → grok-tasks → Run workflow, with the task (A, B or D). Locally:

```sh
node run-task.mjs B --dry-run          # the request, without calling xAI
XAI_API_KEY=… node run-task.mjs A      # run it and print the report
```

The task texts are in `tasks/`; the app versions of all tasks (A–H) are kept with Frits.
