import crypto from "node:crypto";

import { DAILY_KPI_SCHEMA_VERSION, type DailyKpiReport } from "../eval/dailyKpis.js";
import type { UsageTotals } from "../eval/agentUsage.js";
import { gcpAccessToken, type KpiArtifact, type KpiSink, type KpiSinkResult } from "./kpiRouter.js";

export type ExecutionOrigin = "local" | "cloud" | "unknown";

export interface BigQueryAgentUsageRow {
  scope_id: string;
  report_id: string;
  row_kind: "summary" | "source" | "model";
  period_date: string;
  period_start: string;
  period_end: string;
  execution_origin: ExecutionOrigin;
  agent_source: string | null;
  model: string | null;
  prompts: number;
  sessions: number;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  usage_events: number;
  claude_otel_requests: number;
  claude_statusline_samples: number;
  codex_token_events: number;
  generated_at: string;
  schema_version: string;
  event_id: string | null;
  event_type: string | null;
  session_fingerprint: string | null;
  fleet_job_id: string | null;
  fleet_lease_id: string | null;
  stream_id: string | null;
  reporter_id: string | null;
}

interface BigQueryTableRef {
  project: string;
  dataset: string;
  table: string;
}

export class BigQueryKpiSink implements KpiSink {
  readonly name = "bigquery";
  private readonly table: BigQueryTableRef;
  private readonly scopeId: string;
  private readonly executionOrigin: ExecutionOrigin;
  private readonly credentialsJson: string | null;

  constructor(input: {
    table: string;
    scopeId: string;
    executionOrigin: ExecutionOrigin;
    credentialsJson?: string | null;
  }) {
    this.table = parseBigQueryTable(input.table);
    this.scopeId = validScopeId(input.scopeId);
    this.executionOrigin = validExecutionOrigin(input.executionOrigin);
    this.credentialsJson = input.credentialsJson ?? null;
  }

  async write(artifacts: KpiArtifact[]): Promise<KpiSinkResult> {
    const report = dailyReportFromArtifacts(artifacts);
    const rows = bigQueryRowsForDailyKpis(report, {
      scopeId: this.scopeId,
      executionOrigin: this.executionOrigin
    });
    const token = await gcpAccessToken(this.credentialsJson, [
      "https://www.googleapis.com/auth/bigquery.insertdata"
    ]);
    const { project, dataset, table } = this.table;
    const endpoint =
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}` +
      `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}/insertAll`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        kind: "bigquery#tableDataInsertAllRequest",
        skipInvalidRows: false,
        ignoreUnknownValues: false,
        traceId: crypto.randomUUID(),
        rows: rows.map((row) => ({
          insertId: insertIdFor(row),
          json: row
        }))
      })
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`BigQuery KPI insert failed: ${response.status} ${responseBody}`);
    }
    const parsed = responseBody ? JSON.parse(responseBody) as unknown : {};
    const insertErrors = isRecord(parsed) && Array.isArray(parsed.insertErrors)
      ? parsed.insertErrors
      : [];
    if (insertErrors.length > 0) {
      throw new Error(`BigQuery KPI insert rejected rows: ${JSON.stringify(insertErrors)}`);
    }
    return {
      sink: this.name,
      destinations: [`bigquery://${project}.${dataset}.${table}/${rows[0]?.report_id ?? "unknown"}`]
    };
  }
}

export function bigQueryRowsForDailyKpis(
  report: DailyKpiReport,
  input: { scopeId: string; executionOrigin: ExecutionOrigin }
): BigQueryAgentUsageRow[] {
  const scopeId = validScopeId(input.scopeId);
  const executionOrigin = validExecutionOrigin(input.executionOrigin);
  const reportId = crypto
    .createHash("sha256")
    .update([report.schemaVersion, scopeId, executionOrigin, report.period.date].join("\n"))
    .digest("hex");
  const common = {
    scope_id: scopeId,
    report_id: reportId,
    period_date: report.period.date,
    period_start: report.period.since,
    period_end: report.period.until,
    execution_origin: executionOrigin,
    generated_at: report.generatedAt,
    schema_version: report.schemaVersion,
    event_id: null,
    event_type: null,
    session_fingerprint: null,
    fleet_job_id: null,
    fleet_lease_id: null,
    stream_id: null,
    reporter_id: null
  };
  const summary = rowFromTotals(report.usage.totals, {
    ...common,
    row_kind: "summary",
    agent_source: null,
    model: null,
    prompts: report.metrics.humanInputs.total,
    usage_events: report.metrics.events.usageEvents,
    claude_otel_requests: report.metrics.events.claudeOtelRequests,
    claude_statusline_samples: report.metrics.events.claudeStatuslineSamples,
    codex_token_events: report.metrics.events.codexTokenEvents
  });
  const sourceRows = Object.entries(report.usage.bySource)
    .map(([source, totals]) => rowFromTotals(totals, {
      ...common,
      row_kind: "source",
      agent_source: source,
      model: null,
      prompts: report.metrics.humanInputs.bySource[source] ?? 0,
      usage_events: totals.events,
      claude_otel_requests: source === "claude-code" ? report.metrics.events.claudeOtelRequests : 0,
      claude_statusline_samples: source === "claude-code" ? report.metrics.events.claudeStatuslineSamples : 0,
      codex_token_events: source === "codex" ? report.metrics.events.codexTokenEvents : 0
    }))
    .filter(hasActivity);
  const modelRows = Object.entries(report.usage.byModel)
    .map(([model, totals]) => rowFromTotals(totals, {
      ...common,
      row_kind: "model",
      agent_source: null,
      model,
      prompts: 0,
      usage_events: totals.events,
      claude_otel_requests: 0,
      claude_statusline_samples: 0,
      codex_token_events: 0
    }))
    .filter(hasActivity);
  return [summary, ...sourceRows, ...modelRows];
}

function rowFromTotals(
  totals: UsageTotals,
  fields: Omit<
    BigQueryAgentUsageRow,
    | "sessions"
    | "requests"
    | "input_tokens"
    | "cached_input_tokens"
    | "cache_read_input_tokens"
    | "cache_creation_input_tokens"
    | "output_tokens"
    | "reasoning_output_tokens"
    | "total_tokens"
    | "cost_usd"
  >
): BigQueryAgentUsageRow {
  return {
    ...fields,
    sessions: totals.sessions,
    requests: totals.requests,
    input_tokens: totals.inputTokens,
    cached_input_tokens: totals.cachedInputTokens,
    cache_read_input_tokens: totals.cacheReadInputTokens,
    cache_creation_input_tokens: totals.cacheCreationInputTokens,
    output_tokens: totals.outputTokens,
    reasoning_output_tokens: totals.reasoningOutputTokens,
    total_tokens: totals.totalTokens,
    cost_usd: totals.costUsd
  };
}

function hasActivity(row: BigQueryAgentUsageRow): boolean {
  return row.prompts > 0 || row.sessions > 0 || row.requests > 0 ||
    row.total_tokens > 0 || row.cost_usd > 0 || row.usage_events > 0;
}

function dailyReportFromArtifacts(artifacts: KpiArtifact[]): DailyKpiReport {
  const artifact = artifacts.find((candidate) => candidate.contentType.startsWith("application/json"));
  if (!artifact) {
    throw new Error("BigQuery KPI sink requires the daily KPI JSON artifact");
  }
  const parsed = JSON.parse(artifact.body) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== DAILY_KPI_SCHEMA_VERSION ||
      !isRecord(parsed.period) || !isRecord(parsed.metrics) || !isRecord(parsed.usage)) {
    throw new Error("BigQuery KPI sink received an invalid daily KPI report");
  }
  return parsed as unknown as DailyKpiReport;
}

function parseBigQueryTable(value: string): BigQueryTableRef {
  const parts = value.trim().replace(/^`|`$/g, "").split(".");
  const identifier = /^[A-Za-z0-9_-]{1,1024}$/;
  if (parts.length !== 3 || parts.some((part) => !identifier.test(part))) {
    throw new Error("--bigquery-table must be project.dataset.table");
  }
  const [project, dataset, table] = parts;
  return { project: project!, dataset: dataset!, table: table! };
}

function validScopeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("--scope-id must be a non-empty identifier of at most 256 characters");
  }
  return trimmed;
}

function validExecutionOrigin(value: string): ExecutionOrigin {
  if (value !== "local" && value !== "cloud" && value !== "unknown") {
    throw new Error("--execution-origin must be local, cloud, or unknown");
  }
  return value;
}

function insertIdFor(row: BigQueryAgentUsageRow): string {
  return crypto
    .createHash("sha256")
    .update([row.report_id, row.row_kind, row.agent_source ?? "", row.model ?? ""].join("\n"))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
