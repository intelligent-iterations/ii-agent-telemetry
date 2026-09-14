import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { AgentUsageWebhookSink, toAgentUsageEvent } from "../src/export/agentUsageWebhookSink.js";
import type { EvalEventRecord } from "../src/ingest/types.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-usage-webhook-");
const requests: Array<{ authorization: string; body: string }> = [];
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    requests.push({
      authorization: String(request.headers.authorization ?? ""),
      body: Buffer.concat(chunks).toString("utf8")
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":{"accepted":1}}\n');
  });
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const tokenFile = path.join(temp, "agent-usage.key");
  fs.writeFileSync(tokenFile, "iiosu_v1.example.secret-material-for-test\n", { mode: 0o400 });
  const sink = new AgentUsageWebhookSink({
    endpoint: `http://127.0.0.1:${address.port}/api/v1/workspaces/workspace-1/agent-usage/events`,
    tokenFile,
    executionOrigin: "cloud",
    billing: {
      mode: "subscription_included",
      provider: "openai",
      plan: "chatgpt-pro"
    },
    fleet: { jobId: "job-1", leaseId: "lease-1", streamId: "stream-1" }
  });
  const rawPrompt = "private prompt that must never cross the sink";
  const result = await sink.publish(
    record({
      eventType: "codex.transcript.line",
      payload: {
        line: {
          type: "event_msg",
          payload: { type: "user_message", message: rawPrompt }
        }
      }
    }),
    {
      event: { source: "codex", kind: "transcript", eventType: "codex.transcript.line", payload: {} },
      context: { receivedAt: new Date().toISOString(), route: "test" }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.authorization, "Bearer iiosu_v1.example.secret-material-for-test");
  assert.equal(requests[0]?.body.includes(rawPrompt), false);
  const body = JSON.parse(requests[0]!.body) as { events: Array<Record<string, unknown>> };
  const usage = body.events[0]!;
  assert.equal(usage.source, "codex");
  assert.equal(usage.executionOrigin, "cloud");
  assert.deepEqual(usage.billing, {
    mode: "subscription_included",
    provider: "openai",
    plan: "chatgpt-pro"
  });
  assert.equal((usage.metrics as Record<string, unknown>).prompts, 1);
  assert.deepEqual(usage.fleet, { jobId: "job-1", leaseId: "lease-1", streamId: "stream-1" });
  assert.match(String(usage.sessionFingerprint), /^[0-9a-f]{64}$/);

  const tokenEvent = toAgentUsageEvent(
    record({
      eventType: "codex.token_count",
      payload: {
        model: "gpt-5.5",
        usage: {
          input_tokens: 30,
          cached_input_tokens: 20,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 35
        }
      }
    }),
    {
      executionOrigin: "local",
      billing: { mode: "metered_api", provider: "openai" }
    }
  );
  assert(tokenEvent);
  assert.equal(tokenEvent.model, "gpt-5.5");
  assert.equal(tokenEvent.metrics.totalTokens, 35);
  assert.equal(tokenEvent.metrics.codexTokenEvents, 1);
  assert.equal(tokenEvent.metrics.costUsd, 0.00021);
  assert.equal(tokenEvent.metrics.apiEquivalentCostUsd, 0.00021);
  assert.equal(tokenEvent.metrics.actualCostUsd, 0.00021);
  assert.equal(
    toAgentUsageEvent(
      record({ eventType: "codex.token_count", payload: {} }),
      { executionOrigin: "local", codexTelemetry: "otel" }
    ),
    null
  );
  assert.equal(
    toAgentUsageEvent(
      record({
        eventType: "codex.sse_event",
        payload: { attributes: { kind: "response.completed", total_tokens: 10 } }
      }),
      { executionOrigin: "local", codexTelemetry: "transcript" }
    ),
    null
  );
  // The receiving cost column is NUMERIC scale 9. A provider-reported float
  // carries full float noise, and sending it unrounded is rejected outright,
  // losing the whole event.
  const noisy = toAgentUsageEvent(
    {
      ...record({ eventType: "claude_code.api_request", payload: {} }),
      source: "claude-code",
      payload: {
        attributes: {
          model: "claude-opus-5",
          input_tokens: 536,
          output_tokens: 15,
          cache_read_tokens: 100_417,
          cache_creation_tokens: 481,
          cost_usd: 0.05626975000000001
        }
      }
    },
    {
      executionOrigin: "local",
      billing: { mode: "subscription_included", provider: "anthropic", plan: "claude-max" }
    }
  );
  assert.ok(noisy);
  assert.equal(noisy.metrics.costUsd, 0.05626975);
  assert.equal(noisy.metrics.apiEquivalentCostUsd, 0.05626975);
  assert.equal(noisy.metrics.actualCostUsd, 0);
  assert.deepEqual(noisy.billing, {
    mode: "subscription_included",
    provider: "anthropic",
    plan: "claude-max"
  });
  assert.ok(decimals(noisy.metrics.costUsd) <= 9);

  // A locally estimated Codex cost is a float product and needs the same
  // treatment.
  const estimated = toAgentUsageEvent(
    record({
      eventType: "codex.token_count",
      payload: { model: "gpt-5.6-sol", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 11 } }
    }),
    {
      executionOrigin: "local",
      codexTelemetry: "transcript",
      billing: { mode: "unknown", provider: "openai" }
    }
  );
  assert.ok(estimated);
  assert.ok(estimated.metrics.costUsd > 0);
  assert.ok(decimals(estimated.metrics.costUsd) <= 9);
  assert.equal(estimated.metrics.actualCostUsd, undefined);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup(temp);
}

function decimals(value: number): number {
  const text = String(value);
  if (text.includes("e") || text.includes("E")) return Number.POSITIVE_INFINITY;
  return text.includes(".") ? text.split(".")[1]!.length : 0;
}

function record(input: { eventType: string; payload: unknown }): EvalEventRecord {
  return {
    id: "12345678-1234-4234-8234-123456789abc",
    source: "codex",
    kind: "transcript",
    eventType: input.eventType,
    sessionId: "raw-session-id",
    turnId: null,
    timestamp: "2026-08-16T12:00:00.000Z",
    payload: input.payload,
    payloadJson: JSON.stringify({ value: input.payload, redaction: { reasons: [] } }),
    redactionVersion: "redact.v1",
    schemaVersion: "eval-event.v1",
    dedupKey: null,
    createdAt: "2026-08-16T12:00:00.000Z"
  };
}
