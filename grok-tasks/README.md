# Grok tasks

Frits's scheduled Grok tasks, run by `.github/workflows/grok-tasks.yml` through xAI's Responses API:

| Task | What | When (UTC) |
|---|---|---|
| A | x402 scan: new x402 sellers on X, checked with x402 Doctor's free check | daily 17:41 |
| B | Scam watch: risky tokens and claim links on X, checked with presign-guard's free checks | by hand |
| D | Help desk: people with x402 payment problems on X, with reply drafts | by hand |
| F | x402 ecosystem digest: releases, complaints and what overlaps with Fizzl, from a week of X | by hand |
| H | Review of @x402fizzl's posts of the week, with 3 post ideas | by hand |
| V | Findability: four plain developer questions, asked with web search only; which answers name our services | Wednesdays 09:53 |

V runs weekly too: through the API Grok has no memory and no connectors, so it answers as for any developer (the
prompt never names Fizzl), and the report starts with one line saying which of the four answers named our service.
Besides that, only A runs on a schedule: what its tool calls find feeds the mail drafts and the Trust Index below, which only works
through the API. B, D, F and H are reports the owner only reads, so he runs them in the Grok app, which his
subscription covers; here they can still be started by hand.

Grok searches X itself (`x_search`), can open links with `web_search` (at most 6 searches of each per run), and gets at most Fizzl's free MCP tools (`x402_quick_check`, `token_quick_verdict`,
`injection_quick_check`). It has no wallet and no paid tool, so it can't pay, sign, post or message anyone. The
report goes to the owner's Telegram through the wallet server's `/hooks/owner-report` (secret `DRAFT_KEY`), with the
tokens and tool calls used and the run's price: xAI's own cost from the answer (`cost_in_usd_ticks`), or else an
estimate from docs.x.ai pricing, with cached input at its lower price. Task A cost about $0.73 a
run on grok-4.7 (29 Oct 2026, estimated before cached input was counted at its own price).

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
