# Event Routing

`ii-agent-evaluations` is structured as local event middleware:

```text
Claude Code OTel / Claude statusline / hooks / Codex / backfill
  -> ingest adapter
  -> EventPipeline
  -> middleware
  -> local SQLite
  -> optional sinks
```

The local SQLite store is always the default system of record. Optional sinks can fan out events elsewhere later, similar in spirit to RudderStack-style routing.

## Middleware

Middleware receives a `PipelineEnvelope` and can:

- Drop invalid events.
- Add route metadata.
- Normalize payloads.
- Enforce redaction or policy checks.

## Claude Code Inputs

Claude Code telemetry uses three local inputs:

- OpenTelemetry logs and metrics over OTLP/HTTP JSON. These are the primary
  source for `claude_code.api_request`, token usage, cost, tool results, API
  errors, compaction, and hook execution telemetry.
- Statusline JSON through a managed wrapper. This captures real-time session
  counters without enabling prompt, tool argument, tool content, or raw API
  body logging.
- Hooks for semantic lifecycle events and failures. Hooks stay best-effort so
  telemetry failure does not break the host agent.

## Sinks

Current sink scaffolding:

- `JsonlSink` writes routed events to a local JSONL file.
- `WebhookSink` posts events to a configured HTTP endpoint.

Remote sinks are disabled by default. To enable a local JSONL fanout:

```bash
EVALS_EVENT_JSONL_SINK=1 node dist/src/cli.js server
```

To enable a remote webhook later:

```bash
EVALS_WEBHOOK_URL=https://example.invalid/agent-events \
EVALS_WEBHOOK_TOKEN=... \
node dist/src/cli.js server
```

Do not enable remote sinks for sensitive telemetry without an explicit security review. Events can contain prompts, paths, command lines, and tool payloads.
