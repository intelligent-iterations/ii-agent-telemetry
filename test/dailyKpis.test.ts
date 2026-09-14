import assert from "node:assert/strict";
import path from "node:path";

import { createDailyKpiArtifacts, dailyKpiPeriod } from "../src/eval/dailyKpis.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-daily-kpis-");
try {
  const dbPath = path.join(temp, "evals.sqlite");
  const db = new EvalDatabase(dbPath);
  db.init();
  db.recordEvent({
    source: "claude-code",
    kind: "hook",
    eventType: "UserPromptSubmit",
    sessionId: "claude-session",
    timestamp: "2026-05-04T14:00:00.000Z",
    payload: { ok: true }
  });
  db.recordEvent({
    source: "claude-code",
    kind: "hook",
    eventType: "Status",
    sessionId: "claude-session",
    timestamp: "2026-05-04T14:01:00.000Z",
    payload: {
      session_id: "claude-session",
      model: { id: "claude-opus-4-7" },
      cost: { total_cost_usd: 0.75 },
      context_window: {
        current_usage: {
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 3
        }
      }
    }
  });
  db.recordEvent({
    source: "codex",
    kind: "hook",
    eventType: "UserPromptSubmit",
    sessionId: "codex-session",
    timestamp: "2026-05-04T15:00:00.000Z",
    payload: { ok: true }
  });
  db.recordEvent({
    source: "codex",
    kind: "transcript",
    eventType: "codex.token_count",
    sessionId: "codex-session",
    timestamp: "2026-05-04T15:01:00.000Z",
    payload: {
      model: "gpt-5.5",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 10,
        reasoning_output_tokens: 3,
        total_tokens: 110
      }
    }
  });
  db.recordEvent({
    source: "codex",
    kind: "hook",
    eventType: "UserPromptSubmit",
    sessionId: "outside-window",
    timestamp: "2026-05-05T04:01:00.000Z",
    payload: { ok: true }
  });

  const artifacts = createDailyKpiArtifacts({
    db,
    dbPath,
    date: "2026-05-04",
    timeZone: "America/Toronto"
  });
  assert.equal(artifacts.report.period.since, "2026-05-04T04:00:00.000Z");
  assert.equal(artifacts.report.period.until, "2026-05-05T04:00:00.000Z");
  assert.equal(artifacts.report.metrics.humanInputs.total, 2);
  assert.equal(artifacts.report.metrics.humanInputs.bySource["claude-code"], 1);
  assert.equal(artifacts.report.metrics.humanInputs.bySource.codex, 1);
  assert.equal(artifacts.report.metrics.tokens.inputTokens, 100);
  assert.equal(artifacts.report.metrics.tokens.cachedInputTokens, 40);
  assert.equal(artifacts.report.metrics.tokens.totalTokens, 110);
  assert.equal(artifacts.report.metrics.costUsd.estimated, 0.00062);
  assert.equal(artifacts.report.metrics.costUsd.statuslineCurrent, 0.75);
  assert.equal(artifacts.report.metrics.spendUsd.period, 0.00062);
  assert.equal(artifacts.report.metrics.spendUsd.label, "Daily spend");
  assert.equal(artifacts.report.metrics.events.claudeStatuslineSamples, 1);
  assert.match(artifacts.markdown, /Human inputs: 2/);
  assert.match(artifacts.markdown, /Daily spend: \$0\.00062/);
  assert.doesNotMatch(artifacts.markdown, /Cost captured/);
  assert.match(artifacts.markdown, /Claude token telemetry missing; Claude usage is not zero/);
  assert.match(artifacts.markdown, /\| Claude Code \| n\/a \| \$0\.75 statusline \| 1 \| 1 \|/);

  const previous = dailyKpiPeriod({
    now: new Date("2026-05-05T13:00:00.000Z"),
    timeZone: "America/Toronto"
  });
  assert.equal(previous.date, "2026-05-04");

  db.close();

  const readOnlyDb = new EvalDatabase(dbPath, { readOnly: true });
  readOnlyDb.init();
  try {
    const readOnlyArtifacts = createDailyKpiArtifacts({
      db: readOnlyDb,
      dbPath,
      date: "2026-05-04",
      timeZone: "America/Toronto"
    });
    assert.equal(readOnlyArtifacts.report.metrics.tokens.totalTokens, 110);
  } finally {
    readOnlyDb.close();
  }
} finally {
  cleanup(temp);
}
