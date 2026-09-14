# State Model

Runtime state defaults to:

```text
~/ii/ii-agent-evaluations/<run_id>/
  events/
  cursors/
  logs/
    hook-errors.jsonl
    pipeline-errors.jsonl
    events-routed.jsonl       # optional when EVALS_EVENT_JSONL_SINK=1
  reports/
  evaluations.sqlite
  port.json
```

The active collector also writes a small discovery pointer at:

```text
~/ii/ii-agent-evaluations/active-port.json
```

Installed hooks use that pointer to find the current run's authenticated
localhost endpoint when `EVALS_RUN_ID` is not set in the agent process.

Installer state lives at:

```text
~/ii/ii-agent-evaluations/installer/manifest.json
```

`EVALS_STATE_DIR` may override the state root for tests or explicit local experiments.
