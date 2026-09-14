# ii-agent-telemetry

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/intelligent-iterations/ii-agent-telemetry/badge)](https://securityscorecards.dev/viewer/?uri=github.com/intelligent-iterations/ii-agent-telemetry)

Local telemetry ingestion and self-evaluation for Claude Code and Codex sessions.

The npm package remains named `ii-agent-evaluations`, and its command remains
`evals`, for compatibility with existing installations.

## What It Does

- Receives OpenTelemetry logs, metrics, and traces over local OTLP/HTTP.
- Receives semantic lifecycle events from Claude Code and Codex hooks.
- Captures Claude Code statusline JSON for real-time model, cost, context,
  token, line-change, and rate-limit counters.
- Falls back to transcript ingestion for historical sessions.
- Redacts sensitive data before storage.
- Stores events in local SQLite.
- Routes events through a middleware pipeline with optional sinks.
- Can send a strict, content-free usage projection to an authenticated
  workspace endpoint.
- Normalizes Claude Code and Codex usage into one cross-agent session/model
  report.
- Exports daily agent KPIs as JSON/Markdown through local or GCS sinks.
- Produces rubric-based self-evaluation reports.

## State

Runtime state defaults to:

```text
~/ii/ii-agent-evaluations/<run_id>/
```

Set `EVALS_STATE_DIR` only for tests or one-off local experiments.

## Quickstart

```bash
git clone https://github.com/intelligent-iterations/ii-agent-telemetry.git
cd ii-agent-telemetry
npm ci
npm run build
node dist/src/cli.js install --dry-run
node dist/src/cli.js doctor
```

Start the collector:

```bash
node dist/src/cli.js server
```

Then use another terminal for reports:

```bash
node dist/src/cli.js usage all --since 2026-05-04T04:00:00.000Z
node dist/src/cli.js kpi daily --date 2026-05-04 --sink local --out ./kpis
```

On macOS, `install` also writes a LaunchAgent at
`~/Library/LaunchAgents/com.ii.agent-evaluations.plist` so the local collector
can stay online for Claude Code and Codex hooks. Start or refresh it with:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ii.agent-evaluations.plist"
```

After **editing** the plist, whether adding the usage sink variables below,
changing the port, or repointing the checkout, a `launchctl kickstart -k` is not enough.
launchd keeps its own copy of a loaded job definition, so `kickstart` relaunches
the process from the *old* environment: the collector comes back listening and
looks healthy while the new variables never reach it. Reload it instead:

```bash
launchctl bootout "gui/$(id -u)/com.ii.agent-evaluations"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ii.agent-evaluations.plist"
```

Then confirm the process really has them, because nothing in the log will say
otherwise:

```bash
pid="$(launchctl list | awk '$3 == "com.ii.agent-evaluations" { print $1 }')"
ps -Eww -p "$pid" -o command= | tr ' ' '\n' | grep '^EVALS_'
```

Collector logs go under `~/Library/Logs/ii-agent-evaluations/` instead of the
evaluation state directory so launchd can open them before the Node process
starts.

## Security

The collector binds to `127.0.0.1` and requires a bearer token on ingest requests. The token and active port are written to the run state directory with file mode `0600`.

Claude Code prompt text, tool arguments, raw tool content, and raw API bodies
are disabled by default in the installer. Enable those only for a local,
explicitly reviewed debugging session.

## Workspace usage reporting

The optional usage sink sends only prompt/session/request counters, token
totals, model/source labels, declared execution origin, hashed session
correlation, and Fleet job/lease IDs. It never forwards an event record or its
payload. Configure it for an isolated run with:

```bash
export EVALS_USAGE_WEBHOOK_URL="https://telemetry.example/api"
export EVALS_USAGE_WORKSPACE_ID="workspace-id"
export EVALS_USAGE_BEARER_TOKEN_FILE="/run/secrets/agent-usage.key"
export EVALS_EXECUTION_ORIGIN="cloud"
export EVALS_CODEX_TRANSCRIPT_DIR="$CODEX_HOME/sessions"
node dist/src/cli.js server
```

The bearer file may contain a workspace-scoped reporting key or a short-lived
identity token authorized to write usage events. In ephemeral runtimes, mount
that file through a run-scoped secret binding. Never put the credential value
in a job request, environment value, tag, or log. Use live reporting or the
daily BigQuery export for a state directory, not both.

When `EVALS_CODEX_TRANSCRIPT_DIR` is configured, the live sink treats transcript
prompt/token events as canonical and ignores equivalent Codex OTel usage events.
Without a transcript directory it uses Codex OTel. This prevents the same turn
from being counted twice when both collectors are active.
