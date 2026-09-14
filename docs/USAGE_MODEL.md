# Usage Model

`ii-agent-evaluations` normalizes Claude Code and Codex telemetry into one
local usage model. The goal is to support dashboards, budget checks, and
self-evaluation reports without coupling callers to one agent's log format.

## Inputs

- Claude Code OpenTelemetry events and metrics are the preferred source for
  request-level model, token, cache, cost, and latency data.
- Claude Code statusline samples provide live session totals, context pressure,
  and plan/rate-limit signals.
- Claude Code and Codex hooks provide lifecycle, task, tool, permission, and
  failure events.
- Codex transcript token events provide per-turn token deltas and rate-limit
  snapshots. The watcher also carries the latest observed Codex model from
  `turn_context` lines into token usage events.
- Codex cost is estimated after ingest for known OpenAI model IDs from input,
  cached input, and output token counts. Unknown model aliases remain unpriced
  instead of guessing.

The `gpt-5.6-luna` API-equivalent rate is $0.20 per million fresh input
tokens, $0.02 per million cached input tokens, and $1.20 per million output
tokens. Above 272,000 input tokens, the long-context rates are $0.40, $0.04,
and $1.80 respectively. Cached input is included inside the reported input
count, so the estimator subtracts it before applying the fresh-input rate.

## Normalized Fields

The `evals usage all` report includes:

- `totals`: cross-agent tokens, cache tokens, costs, request counts, and active
  time bounds.
- `bySource`: separate Claude Code and Codex rollups.
- `byModel`: model-level rollups across both agents.
- `recentSessions`: latest sessions with source, model, token, cost, and status
  cost details.
- `telemetryCoverage`: counts of the high-confidence sources feeding the report.
- `behavioralSignals`: early self-evaluation signals for context leverage,
  tool reach, autonomy, flow, and throughput.

Live usage events can also carry execution job identifiers, model, and billing
classification. Stable job labels can identify workload classes while physical
host placement remains infrastructure audit metadata.
API-equivalent list price and actual variable spend are separate values:
subscription-included usage has zero per-call spend but retains its
API-equivalent value; a known fixed subscription fee is kept as monthly plan
metadata rather than multiplied across events.

## Design Influences

- OpenUsage-style cross-provider rollups: one local view of quotas, spend,
  sessions, and model usage.
- AgentFit-style behavioral scoring: derive improvement signals from actual
  coding sessions rather than surveys.
- ccusage-style token/cache accounting: keep cache creation, cache reads,
  fresh input, output, and cost visible as distinct fields.

The implementation is intentionally middleware-first. SQLite is the local
system of record, and optional sinks can route normalized events elsewhere
after a security review.
