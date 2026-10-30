# Grok tasks

Frits's scheduled Grok tasks, run by `.github/workflows/grok-tasks.yml` through xAI's Responses API:

| Task | What | When (UTC) |
|---|---|---|
| A | x402 scan: new x402 sellers on X, checked with x402 Doctor's free check | daily 17:41 |
| B | Scam watch: risky tokens and claim links on X, checked with presign-guard's free checks | every third day 18:13 |
| D | Help desk: people with x402 payment problems on X, with reply drafts | every third day 18:37 |
| F | x402 ecosystem digest: releases, complaints and what overlaps with Fizzl, from a week of X | Mondays 07:19 |
| H | Review of @x402fizzl's posts of the week, with 3 post ideas | Sundays 19:47 |

Grok searches X itself (`x_search`), can open links with `web_search` (at most 6 searches of each per run), and gets at most Fizzl's free MCP tools (`x402_quick_check`, `token_quick_verdict`,
`injection_quick_check`). It has no wallet and no paid tool, so it can't pay, sign, post or message anyone. The
report goes to the owner's Telegram through the wallet server's `/hooks/owner-report` (secret `DRAFT_KEY`), with the
tokens and tool calls used and an estimate of the whole run's price (docs.x.ai pricing). Task A cost about $0.73 a
run on grok-4.7 (29 Oct 2026), so A runs daily, B and D every third day and F and H weekly: about $1.40 a day.

Every endpoint Grok checked with `x402_quick_check` and found failing (read from the tool calls, not from Grok's
text; at most 5 a run) then goes through x402 Doctor's free web check, which hands the owner a mail draft on Telegram
when the seller publishes a contact address (one mail per address, ever; nothing is sent without the owner's Send).
Every endpoint Grok checked (at most 8 a run) is also added to the x402 Trust Index (`POST /api/trust/submit`, free):
Doctor checks the 402 again and skips what a registry already lists, so a seller seen only on X gets a daily track
record. The report says how many were new.

Setup: add the repository secret `XAI_API_KEY` (an API key from console.x.ai). Without it the runs do nothing.

By hand: Actions → grok-tasks → Run workflow, with the task (A, B, D, F or H). Locally:

```sh
node run-task.mjs B --dry-run          # the request, without calling xAI
XAI_API_KEY=… node run-task.mjs A      # run it and print the report
```

The task texts are in `tasks/`; the app versions of all tasks (A–H) are kept with Frits.
