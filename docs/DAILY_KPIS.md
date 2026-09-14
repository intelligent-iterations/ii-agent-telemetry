# Daily KPI Export

`ii-agent-evaluations` can export a daily JSON and Markdown KPI bundle from the
local SQLite event store.

```bash
node dist/src/cli.js kpi daily \
  --date 2026-05-04 \
  --timezone America/Toronto \
  --sink local \
  --out "$HOME/ii/ii-agent-evaluations/kpis/2026-05-04"
```

The report covers the local calendar day `[00:00, 00:00)` in the requested
timezone. If `--date` is omitted, the command exports the previous local day.

The JSON includes:

- Human input count from `UserPromptSubmit` hook events.
- Input, cached input, output, reasoning output, and total tokens.
- Daily spend for the report window, derived from captured token usage and known model pricing.
- Claude Code request/statusline and Codex token-event coverage counts.
- The full normalized usage rollup used to derive the KPI summary.

## Sinks

The exporter writes through a small sink router:

```bash
node dist/src/cli.js kpi daily \
  --sink local,gcs,bigquery \
  --out ./kpis \
  --gcs-bucket gs://example-agent-ops \
  --gcs-prefix agent-kpis \
  --bigquery-table example-project.agent_ops.agent_usage_daily \
  --scope-id workspace-1 \
  --execution-origin local
```

The GCS sink uses service-account JSON from one of:

- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `GCP_SERVICE_ACCOUNT_JSON`
- `GOOGLE_APPLICATION_CREDENTIALS` pointing at a JSON file

Objects are written under:

```text
<gcs-prefix>/daily/YYYY/MM/DD/agent-kpis-YYYY-MM-DD.{json,md}
```

The BigQuery sink writes summary, agent-source, and model rows. It excludes the
SQLite path, prompt text, transcripts, and other event payloads. `--scope-id`
is the consumer's authorization boundary; multi-tenant consumers should use
their tenant or workspace ID.
`--execution-origin` is required producer metadata: use `local`, `cloud`, or
`unknown`; the exporter never guesses from the machine running the export.

Create the destination table before enabling the sink. A partitioned and
clustered table keeps workspace/date queries bounded:

```sql
CREATE TABLE `PROJECT.DATASET.agent_usage_daily` (
  scope_id STRING NOT NULL,
  report_id STRING NOT NULL,
  row_kind STRING NOT NULL,
  period_date DATE NOT NULL,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  execution_origin STRING NOT NULL,
  agent_source STRING,
  model STRING,
  prompts INT64 NOT NULL,
  sessions INT64 NOT NULL,
  requests INT64 NOT NULL,
  input_tokens INT64 NOT NULL,
  cached_input_tokens INT64 NOT NULL,
  cache_read_input_tokens INT64 NOT NULL,
  cache_creation_input_tokens INT64 NOT NULL,
  output_tokens INT64 NOT NULL,
  reasoning_output_tokens INT64 NOT NULL,
  total_tokens INT64 NOT NULL,
  cost_usd NUMERIC NOT NULL,
  usage_events INT64 NOT NULL,
  claude_otel_requests INT64 NOT NULL,
  claude_statusline_samples INT64 NOT NULL,
  codex_token_events INT64 NOT NULL,
  generated_at TIMESTAMP NOT NULL,
  schema_version STRING NOT NULL,
  event_id STRING,
  event_type STRING,
  session_fingerprint STRING,
  fleet_job_id STRING,
  fleet_lease_id STRING,
  host_id STRING,
  billing_mode STRING,
  billing_provider STRING,
  billing_plan STRING,
  subscription_cost_usd_monthly NUMERIC,
  api_equivalent_cost_usd NUMERIC,
  actual_cost_usd NUMERIC,
  stream_id STRING,
  reporter_id STRING
)
PARTITION BY period_date
CLUSTER BY scope_id, execution_origin, row_kind
OPTIONS (require_partition_filter = TRUE);
```

The writer identity needs table metadata read plus append access. A reporting
reader needs BigQuery job creation in its query project and read access to this
table. Both identities should be scoped to this dataset or table instead of
receiving project administration.

The nullable event, correlation, host, billing, and dual-cost columns are
populated by the authenticated `ii.agent-usage.event.v1` ingestion path. The
legacy `cost_usd` column remains the API-equivalent list-price value. Daily
exports intentionally leave the new classification columns null. Apply the
additive schema in `config/agent-usage-bigquery-schema.json` before deploying a
producer or reader that uses them. Do not enable both live ingestion and daily
export for the same evaluator state, because the two paths would count the same
usage twice.
