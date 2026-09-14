import crypto from "node:crypto";
import fs from "node:fs";

import type { EvalEventRecord } from "../ingest/types.js";
import type { EventSink, PipelineEnvelope, SinkResult } from "../pipeline/types.js";
import { estimateOpenAiTokenCostUsd } from "../eval/openAiTokenPricing.js";

export type AgentUsageExecutionOrigin = "local" | "cloud" | "unknown";
export type CodexUsageTelemetry = "transcript" | "otel" | "both";
export type AgentUsageBillingMode = "subscription_included" | "metered_api" | "metered_credits" | "cloud_provider" | "unknown";

export interface AgentUsageBilling {
  mode: AgentUsageBillingMode;
  provider: string;
  plan?: string;
  subscriptionCostUsdMonthly?: number;
}

export interface AgentUsageEvent {
  schemaVersion: "ii.agent-usage.event.v1";
  eventId: string;
  occurredAt: string;
  source: "claude-code" | "codex";
  eventType: string;
  executionOrigin: AgentUsageExecutionOrigin;
  model?: string;
  billing: AgentUsageBilling;
  sessionFingerprint?: string;
  fleet?: { jobId?: string; leaseId?: string; streamId?: string };
  metrics: AgentUsageMetrics;
}

interface AgentUsageMetrics {
  prompts: number;
  sessions: number;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Backward-compatible alias for API-equivalent list-price value. */
  costUsd: number;
  apiEquivalentCostUsd: number;
  actualCostUsd?: number;
  usageEvents: number;
  claudeOtelRequests: number;
  claudeStatuslineSamples: number;
  codexTokenEvents: number;
}

export class AgentUsageWebhookSink implements EventSink {
  readonly name = "agent-usage-webhook";
  private readonly token: string;

  constructor(
    private readonly input: {
      endpoint: string;
      tokenFile: string;
      executionOrigin: AgentUsageExecutionOrigin;
      codexTelemetry?: CodexUsageTelemetry;
      billing?: AgentUsageBilling;
      fleet?: { jobId?: string; leaseId?: string; streamId?: string };
      timeoutMs?: number;
    }
  ) {
    this.token = readBearerToken(input.tokenFile);
    validateEndpoint(input.endpoint);
  }

  async publish(record: EvalEventRecord, _envelope: PipelineEnvelope): Promise<SinkResult> {
    const event = toAgentUsageEvent(record, {
      executionOrigin: this.input.executionOrigin,
      codexTelemetry: this.input.codexTelemetry,
      billing: this.input.billing,
      fleet: this.input.fleet
    });
    if (!event) return { sink: this.name, ok: true };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.input.timeoutMs ?? 5000);
    try {
      const response = await fetch(this.input.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ events: [event] })
      });
      return response.ok
        ? { sink: this.name, ok: true }
        : { sink: this.name, ok: false, error: `http_${response.status}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function toAgentUsageEvent(
  record: EvalEventRecord,
  context: {
    executionOrigin: AgentUsageExecutionOrigin;
    codexTelemetry?: CodexUsageTelemetry;
    billing?: AgentUsageBilling;
    fleet?: { jobId?: string; leaseId?: string; streamId?: string };
  }
): AgentUsageEvent | null {
  if (record.source !== "codex" && record.source !== "claude-code") return null;
  const payload = payloadValue(record);
  const metrics = emptyMetrics();
  let model: string | null = null;
  const codexTelemetry = context.codexTelemetry ?? "both";

  if (record.eventType === "codex.token_count") {
    if (codexTelemetry === "otel") return null;
    const usage = objectValue(objectValue(payload).usage);
    model = safeLabel(objectValue(payload).model, 160);
    metrics.requests = 1;
    metrics.inputTokens = integer(usage.input_tokens);
    metrics.cachedInputTokens = integer(usage.cached_input_tokens);
    metrics.outputTokens = integer(usage.output_tokens);
    metrics.reasoningOutputTokens = integer(usage.reasoning_output_tokens);
    metrics.totalTokens = integer(usage.total_tokens) || metrics.inputTokens + metrics.outputTokens;
    metrics.costUsd = model
      ? (estimateOpenAiTokenCostUsd(model, {
          inputTokens: metrics.inputTokens,
          cachedInputTokens: metrics.cachedInputTokens,
          outputTokens: metrics.outputTokens
        }) ?? 0)
      : 0;
    metrics.codexTokenEvents = 1;
  } else if (record.eventType === "claude_code.api_request") {
    const attrs = attributes(payload);
    model = safeLabel(attrs.model, 160);
    metrics.requests = 1;
    metrics.inputTokens = integer(attrs.input_tokens);
    metrics.outputTokens = integer(attrs.output_tokens);
    metrics.cacheReadInputTokens = integer(attrs.cache_read_tokens);
    metrics.cacheCreationInputTokens = integer(attrs.cache_creation_tokens);
    metrics.cachedInputTokens = metrics.cacheReadInputTokens + metrics.cacheCreationInputTokens;
    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens + metrics.cachedInputTokens;
    metrics.costUsd = decimal(attrs.cost_usd);
    metrics.claudeOtelRequests = 1;
  } else if (record.eventType === "codex.sse_event") {
    if (codexTelemetry === "transcript") return null;
    const attrs = attributes(payload);
    const kind = safeLabel(attrs.kind ?? attrs["event.kind"], 80);
    if (kind !== "response.completed") return null;
    model = safeLabel(attrs.model, 160);
    metrics.inputTokens = firstInteger(attrs, ["input_tokens", "input_token_count"]);
    metrics.cachedInputTokens = firstInteger(attrs, ["cached_input_tokens", "cached_input_token_count"]);
    metrics.outputTokens = firstInteger(attrs, ["output_tokens", "output_token_count"]);
    metrics.reasoningOutputTokens = firstInteger(attrs, ["reasoning_output_tokens", "reasoning_output_token_count"]);
    metrics.totalTokens = firstInteger(attrs, ["total_tokens", "total_token_count"])
      || metrics.inputTokens + metrics.outputTokens;
    metrics.costUsd = model
      ? (estimateOpenAiTokenCostUsd(model, {
          inputTokens: metrics.inputTokens,
          cachedInputTokens: metrics.cachedInputTokens,
          outputTokens: metrics.outputTokens
        }) ?? 0)
      : 0;
    metrics.codexTokenEvents = 1;
  } else if (isPromptEvent(record.eventType, payload, codexTelemetry)) {
    metrics.prompts = 1;
  } else if (record.eventType === "codex.conversation_starts") {
    model = safeLabel(attributes(payload).model, 160);
    metrics.sessions = 1;
  } else {
    return null;
  }

  metrics.usageEvents = 1;
  // The receiving column is NUMERIC with scale 9. costUsd arrives either as a
  // provider-reported float or as the product of a local rate estimate, and
  // both routinely carry full float noise (0.05626975000000001). Anything past
  // nine decimals is rejected outright, taking the whole event with it, so the
  // value is normalized here rather than at the boundary that cannot accept it.
  metrics.costUsd = roundCostUsd(metrics.costUsd);
  metrics.apiEquivalentCostUsd = metrics.costUsd;
  const billing = safeBilling(context.billing, record.source);
  const actualCostUsd = actualCostFor(billing.mode, metrics.apiEquivalentCostUsd);
  if (actualCostUsd !== null) metrics.actualCostUsd = roundCostUsd(actualCostUsd);
  const fleet = safeFleet(context.fleet);
  return {
    schemaVersion: "ii.agent-usage.event.v1",
    eventId: record.id,
    occurredAt: record.timestamp,
    source: record.source,
    eventType: safeLabel(record.eventType, 100) ?? `${record.source}.usage`,
    executionOrigin: context.executionOrigin,
    ...(model ? { model } : {}),
    billing,
    ...(record.sessionId ? { sessionFingerprint: fingerprint(record.source, record.sessionId) } : {}),
    ...(fleet ? { fleet } : {}),
    metrics
  };
}

function emptyMetrics(): AgentUsageMetrics {
  return {
    prompts: 0,
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
    apiEquivalentCostUsd: 0,
    usageEvents: 0,
    claudeOtelRequests: 0,
    claudeStatuslineSamples: 0,
    codexTokenEvents: 0
  };
}

function safeBilling(input: AgentUsageBilling | undefined, source: "claude-code" | "codex"): AgentUsageBilling {
  const mode = input?.mode ?? "unknown";
  const provider = safeLabel(input?.provider, 64) ?? (source === "codex" ? "openai" : "anthropic");
  const plan = safeLabel(input?.plan, 100);
  const monthly = input?.subscriptionCostUsdMonthly;
  return {
    mode,
    provider,
    ...(plan ? { plan } : {}),
    ...(typeof monthly === "number" && Number.isFinite(monthly) && monthly >= 0
      ? { subscriptionCostUsdMonthly: roundCostUsd(monthly) }
      : {})
  };
}

function actualCostFor(mode: AgentUsageBillingMode, apiEquivalentCostUsd: number): number | null {
  if (mode === "subscription_included") return 0;
  if (mode === "metered_api") return apiEquivalentCostUsd;
  return null;
}

function isPromptEvent(
  eventType: string,
  payload: unknown,
  codexTelemetry: CodexUsageTelemetry
): boolean {
  if (eventType === "claude_code.user_prompt") return true;
  if (eventType === "codex.user_prompt") return codexTelemetry !== "transcript";
  if (eventType !== "codex.transcript.line") return false;
  if (codexTelemetry === "otel") return false;
  const line = objectValue(objectValue(payload).line);
  const inner = objectValue(line.payload);
  return (
    (line.type === "event_msg" && inner.type === "user_message") ||
    (line.type === "response_item" && inner.type === "message" && inner.role === "user")
  );
}

function attributes(payload: unknown): Record<string, unknown> {
  return objectValue(objectValue(payload).attributes);
}

function payloadValue(record: EvalEventRecord): unknown {
  return record.payload;
}

function safeFleet(input: { jobId?: string; leaseId?: string; streamId?: string } | undefined): AgentUsageEvent["fleet"] | null {
  if (!input) return null;
  const fleet = {
    ...(safeLabel(input.jobId, 256) ? { jobId: safeLabel(input.jobId, 256)! } : {}),
    ...(safeLabel(input.leaseId, 128) ? { leaseId: safeLabel(input.leaseId, 128)! } : {}),
    ...(safeLabel(input.streamId, 256) ? { streamId: safeLabel(input.streamId, 256)! } : {})
  };
  return Object.keys(fleet).length ? fleet : null;
}

function safeLabel(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(normalized)
    ? normalized
    : null;
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

const COST_USD_DECIMALS = 9;

function roundCostUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toFixed(COST_USD_DECIMALS));
}

function decimal(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function firstInteger(input: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = integer(input[key]);
    if (value > 0) return value;
  }
  return 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fingerprint(source: string, sessionId: string): string {
  return crypto.createHash("sha256").update(`${source}\n${sessionId}`).digest("hex");
}

function readBearerToken(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 20 || stat.size > 4096) {
    throw new Error("Agent usage bearer token file is invalid");
  }
  const token = fs.readFileSync(filePath, "utf8").trim();
  if (token.length < 20 || /[\r\n]/.test(token)) {
    throw new Error("Agent usage bearer token file is invalid");
  }
  return token;
}

function validateEndpoint(value: string): void {
  const endpoint = new URL(value);
  const local = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !local) {
    throw new Error("Agent usage endpoint must use HTTPS");
  }
}
