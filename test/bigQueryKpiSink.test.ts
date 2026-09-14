import assert from "node:assert/strict";

import { DAILY_KPI_SCHEMA_VERSION, type DailyKpiReport } from "../src/eval/dailyKpis.js";
import type { UsageTotals } from "../src/eval/agentUsage.js";
import {
  BigQueryKpiSink,
  bigQueryRowsForDailyKpis,
  type ExecutionOrigin
} from "../src/export/bigQueryKpiSink.js";

const codex = totals({
  events: 1,
  sessions: 1,
  requests: 1,
  inputTokens: 700,
  cachedInputTokens: 200,
  outputTokens: 300,
  reasoningOutputTokens: 50,
  totalTokens: 1000,
  costUsd: 0.25
});
const empty = totals({});
const report: DailyKpiReport = {
  schemaVersion: DAILY_KPI_SCHEMA_VERSION,
  generatedAt: "2026-08-16T12:00:00.000Z",
  period: {
    kind: "daily",
    date: "2026-08-15",
    timeZone: "America/Toronto",
    since: "2026-08-15T04:00:00.000Z",
    until: "2026-08-16T04:00:00.000Z"
  },
  source: { dbPath: "/private/local/evaluations.sqlite" },
  metrics: {
    humanInputs: {
      total: 2,
      bySource: { codex: 2, "claude-code": 0 },
      sessions: 1
    },
    tokens: {
      inputTokens: 700,
      cachedInputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 50,
      totalTokens: 1000
    },
    costUsd: {
      estimated: 0.25,
      statuslineCurrent: 0,
      bySource: { codex: 0.25, "claude-code": 0 },
      byModel: { "gpt-test": 0.25 }
    },
    spendUsd: {
      period: 0.25,
      label: "Daily spend",
      basis: "captured token usage"
    },
    events: {
      total: 3,
      usageEvents: 1,
      claudeOtelRequests: 0,
      claudeStatuslineSamples: 0,
      codexTokenEvents: 1
    },
    sessions: 1,
    requests: 1
  },
  usage: {
    generatedAt: "2026-08-16T12:00:00.000Z",
    since: "2026-08-15T04:00:00.000Z",
    totals: codex,
    bySource: { codex, "claude-code": empty },
    byModel: { "gpt-test": codex },
    recentSessions: [],
    behavioralSignals: {
      context: 0,
      reach: 0,
      autonomy: 0,
      flow: 0,
      throughput: 0,
      notes: []
    },
    telemetryCoverage: {
      claudeOtelRequests: 0,
      claudeStatuslineSamples: 0,
      codexTokenEvents: 1
    }
  }
};

const rows = bigQueryRowsForDailyKpis(report, {
  scopeId: "workspace-1",
  executionOrigin: "cloud"
});
const repeated = bigQueryRowsForDailyKpis(report, {
  scopeId: "workspace-1",
  executionOrigin: "cloud"
});

assert.equal(rows.length, 3);
assert.deepEqual(rows.map((row) => row.row_kind), ["summary", "source", "model"]);
assert.equal(rows[0]?.scope_id, "workspace-1");
assert.equal(rows[0]?.execution_origin, "cloud");
assert.equal(rows[0]?.prompts, 2);
assert.equal(rows[0]?.total_tokens, 1000);
assert.equal(rows[0]?.codex_token_events, 1);
assert.equal(rows[1]?.agent_source, "codex");
assert.equal(rows[1]?.prompts, 2);
assert.equal(rows[2]?.model, "gpt-test");
assert.equal(rows[0]?.report_id, repeated[0]?.report_id);
assert.equal(rows[0]?.event_id, null);
assert.equal(rows[0]?.fleet_job_id, null);
assert.equal(rows[0]?.reporter_id, null);
assert.equal("db_path" in (rows[0] ?? {}), false);

assert.throws(
  () => new BigQueryKpiSink({
    table: "missing-parts",
    scopeId: "workspace-1",
    executionOrigin: "local"
  }),
  /project\.dataset\.table/
);
assert.throws(
  () => bigQueryRowsForDailyKpis(report, {
    scopeId: "workspace-1",
    executionOrigin: "edge" as ExecutionOrigin
  }),
  /local, cloud, or unknown/
);

function totals(input: Partial<UsageTotals>): UsageTotals {
  return {
    events: 0,
    sessions: 0,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    statuslineCurrentCostUsd: 0,
    first: null,
    last: null,
    ...input
  };
}
