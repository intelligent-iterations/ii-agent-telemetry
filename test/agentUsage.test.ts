import assert from "node:assert/strict";
import path from "node:path";

import { summarizeAgentUsage } from "../src/eval/agentUsage.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-agent-usage-");
try {
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  db.recordEvent({
    source: "claude-code",
    kind: "otel.logs",
    eventType: "claude_code.api_request",
    sessionId: "claude-session",
    timestamp: "2026-05-04T10:00:00.000Z",
    payload: {
      attributes: {
        "session.id": "claude-session",
        model: "claude-opus-4-7",
        input_tokens: "10",
        output_tokens: "20",
        cache_read_tokens: "100",
        cache_creation_tokens: "50",
        cost_usd: "0.01"
      }
    }
  });
  db.recordEvent({
    source: "claude-code",
    kind: "hook",
    eventType: "Status",
    sessionId: "claude-session",
    timestamp: "2026-05-04T10:01:00.000Z",
    payload: {
      session_id: "claude-session",
      model: { id: "claude-opus-4-7" },
      cost: { total_cost_usd: 1.5 },
      context_window: {
        current_usage: {
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50
        }
      }
    }
  });
  db.recordEvent({
    source: "codex",
    kind: "transcript",
    eventType: "codex.token_count",
    sessionId: "codex-session",
    timestamp: "2026-05-04T10:02:00.000Z",
    payload: {
      model: "gpt-5.5",
      usage: {
        input_tokens: 30,
        cached_input_tokens: 25,
        output_tokens: 5,
        reasoning_output_tokens: 2,
        total_tokens: 35
      }
    }
  });

  const all = summarizeAgentUsage(db, { since: "2026-05-04T00:00:00.000Z", source: "all" });
  assert.equal(all.totals.sessions, 2);
  assert.equal(all.totals.requests, 1);
  assert.equal(all.totals.inputTokens, 40);
  assert.equal(all.totals.outputTokens, 25);
  assert.equal(all.totals.cacheReadInputTokens, 100);
  assert.equal(all.totals.cacheCreationInputTokens, 50);
  assert.equal(all.totals.cachedInputTokens, 175);
  assert.equal(all.totals.statuslineCurrentCostUsd, 1.5);
  assert.equal(all.telemetryCoverage.claudeOtelRequests, 1);
  assert.equal(all.telemetryCoverage.claudeStatuslineSamples, 1);
  assert.equal(all.telemetryCoverage.codexTokenEvents, 1);
  assert.equal(all.byModel["claude-opus-4-7"].costUsd, 0.01);
  assert.equal(all.byModel["gpt-5.5"].totalTokens, 35);
  assert.equal(all.byModel["gpt-5.5"].costUsd, 0.0001875);

  const claude = summarizeAgentUsage(db, { source: "claude-code" });
  assert.equal(claude.bySource.codex.events, 0);
  assert.equal(claude.totals.sessions, 1);
  db.close();
} finally {
  cleanup(temp);
}
