# x402 Agent Safety Bench: raw results

Written by `.github/workflows/agent-safety-bench-archive.yml` on `main`: the results of every
`agent-safety-bench-run`, one file per workflow run (`results/<run id>.jsonl`), one row per run of a scenario
(scenario, kind, condition, agent and model, safe, done, unsafe_usd, spent_usd, overhead_usd, payments, signed,
preflights, checks, turns, usage, answer, repeat, at, run_id). The method is in
`agent-safety-bench/DESIGN.md`; the results are summarised on https://fizzl.eu/bench/
