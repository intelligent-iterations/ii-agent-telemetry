import type { EvalEventRecord } from "../ingest/types.js";
import type { EvalDatabase } from "../storage/evalDb.js";
import { estimateOpenAiTokenCostUsd } from "./openAiTokenPricing.js";

export type UsageSource = "claude-code" | "codex";

export interface UsageTotals {
  events: number;
  sessions: number;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  statuslineCurrentCostUsd: number;
  first: string | null;
  last: string | null;
}

export interface SessionUsageSummary extends UsageTotals {
  sessionId: string;
  source: UsageSource;
  model: string | null;
  statuslineObservedDeltaUsd: number;
}

export interface BehavioralSignals {
  context: number;
  reach: number;
  autonomy: number;
  flow: number;
  throughput: number;
  notes: string[];
}

export interface AgentUsageSummary {
  generatedAt: string;
  since: string | null;
  totals: UsageTotals;
  bySource: Record<UsageSource, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  recentSessions: SessionUsageSummary[];
  behavioralSignals: BehavioralSignals;
  telemetryCoverage: {
    claudeOtelRequests: number;
    claudeStatuslineSamples: number;
    codexTokenEvents: number;
  };
}

interface MutableSession extends UsageTotals {
  sessionId: string;
  source: UsageSource;
  model: string | null;
  firstStatusCost: number | null;
  lastStatusCost: number | null;
}

export function summarizeAgentUsage(db: EvalDatabase, options: { since?: string | null; until?: string | null; source?: UsageSource | "all" | null } = {}): AgentUsageSummary {
  const sources = options.source && options.source !== "all" ? [options.source] : ["claude-code", "codex"] as const;
  const totals = emptyTotals();
  const bySource: Record<UsageSource, UsageTotals> = {
    "claude-code": emptyTotals(),
    codex: emptyTotals()
  };
  const byModel = new Map<string, UsageTotals>();
  const sessions = new Map<string, MutableSession>();
  const coverage = {
    claudeOtelRequests: 0,
    claudeStatuslineSamples: 0,
    codexTokenEvents: 0
  };
  const behavior = {
    prompts: 0,
    tools: 0,
    subagents: 0,
    tasks: 0,
    failures: 0,
    cacheTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    first: null as string | null,
    last: null as string | null
  };

  for (const source of sources) {
    const events = db
      .queryEvents({ source, since: options.since ?? null, until: options.until ?? null, limit: 250_000 })
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    for (const event of events) {
      if (source === "claude-code") {
        applyClaudeEvent(event, { totals, bySource, byModel, sessions, coverage, behavior });
      } else {
        applyCodexEvent(event, { totals, bySource, byModel, sessions, coverage, behavior });
      }
    }
  }

  totals.sessions = sessions.size;
  for (const source of ["claude-code", "codex"] as const) {
    bySource[source].sessions = [...sessions.values()].filter((session) => session.source === source).length;
  }

  return {
    generatedAt: new Date().toISOString(),
    since: options.since ?? null,
    totals,
    bySource,
    byModel: Object.fromEntries([...byModel.entries()].sort((left, right) => right[1].totalTokens - left[1].totalTokens)),
    recentSessions: [...sessions.values()]
      .map((session) => ({
        ...plainTotals(session),
        sessionId: session.sessionId,
        source: session.source,
        model: session.model,
        statuslineObservedDeltaUsd: Math.max(0, (session.lastStatusCost ?? 0) - (session.firstStatusCost ?? 0))
      }))
      .sort((left, right) => Date.parse(right.last ?? "0") - Date.parse(left.last ?? "0"))
      .slice(0, 30),
    behavioralSignals: scoreBehavior(behavior),
    telemetryCoverage: coverage
  };
}

function applyClaudeEvent(
  event: EvalEventRecord,
  state: {
    totals: UsageTotals;
    bySource: Record<UsageSource, UsageTotals>;
    byModel: Map<string, UsageTotals>;
    sessions: Map<string, MutableSession>;
    coverage: AgentUsageSummary["telemetryCoverage"];
    behavior: Parameters<typeof scoreBehavior>[0];
  }
): void {
  countBehavior(event, state.behavior);
  if (event.eventType === "claude_code.api_request") {
    const attrs = attributesFromPayload(event.payload);
    const usage = {
      inputTokens: numberFrom(attrs.input_tokens),
      outputTokens: numberFrom(attrs.output_tokens),
      cacheReadInputTokens: numberFrom(attrs.cache_read_tokens),
      cacheCreationInputTokens: numberFrom(attrs.cache_creation_tokens),
      costUsd: numberFrom(attrs.cost_usd)
    };
    const model = stringFrom(attrs.model) ?? "claude";
    const sessionId = stringFrom(attrs["session.id"]) ?? event.sessionId ?? "unknown";
    state.coverage.claudeOtelRequests += 1;
    addUsageEverywhere(state, "claude-code", sessionId, model, event.timestamp, {
      requests: 1,
      ...usage,
      cachedInputTokens: usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
    });
  }
  if (event.eventType === "Status") {
    const payload = objectValue(event.payload);
    const sessionId = stringFrom(payload.session_id) ?? event.sessionId ?? "unknown";
    const model = stringFromPath(payload, ["model", "id"]) ?? stringFromPath(payload, ["model", "display_name"]) ?? "claude";
    const usage = objectValue(objectValue(payload.context_window).current_usage);
    const costUsd = numberFrom(objectValue(payload.cost).total_cost_usd);
    state.coverage.claudeStatuslineSamples += 1;
    const session = getSession(state.sessions, "claude-code", sessionId);
    session.model = model;
    session.lastStatusCost = costUsd;
    session.firstStatusCost ??= costUsd;
    session.statuslineCurrentCostUsd = costUsd;
    touch(session, event.timestamp);
    state.bySource["claude-code"].statuslineCurrentCostUsd = latestSessionCostTotal(state.sessions, "claude-code");
    state.totals.statuslineCurrentCostUsd = latestSessionCostTotal(state.sessions, null);
    addModelStatuslineCost(state.byModel, model, event.timestamp, costUsd);
    state.behavior.cacheTokens += numberFrom(usage.cache_read_input_tokens) + numberFrom(usage.cache_creation_input_tokens);
  }
}

function applyCodexEvent(
  event: EvalEventRecord,
  state: {
    totals: UsageTotals;
    bySource: Record<UsageSource, UsageTotals>;
    byModel: Map<string, UsageTotals>;
    sessions: Map<string, MutableSession>;
    coverage: AgentUsageSummary["telemetryCoverage"];
    behavior: Parameters<typeof scoreBehavior>[0];
  }
): void {
  countBehavior(event, state.behavior);
  if (event.eventType !== "codex.token_count") {
    return;
  }
  const payload = objectValue(event.payload);
  const usage = objectValue(payload.usage);
  const model = stringFrom(payload.model) ?? "codex";
  const inputTokens = numberFrom(usage.input_tokens);
  const cachedInputTokens = numberFrom(usage.cached_input_tokens);
  const outputTokens = numberFrom(usage.output_tokens);
  const estimatedCostUsd = estimateOpenAiTokenCostUsd(model, {
    inputTokens,
    cachedInputTokens,
    outputTokens
  });
  state.coverage.codexTokenEvents += 1;
  addUsageEverywhere(state, "codex", event.sessionId ?? "unknown", model, event.timestamp, {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: numberFrom(usage.reasoning_output_tokens),
    totalTokens: numberFrom(usage.total_tokens),
    costUsd: estimatedCostUsd ?? 0
  });
}

function addUsageEverywhere(
  state: {
    totals: UsageTotals;
    bySource: Record<UsageSource, UsageTotals>;
    byModel: Map<string, UsageTotals>;
    sessions: Map<string, MutableSession>;
    behavior: Parameters<typeof scoreBehavior>[0];
  },
  source: UsageSource,
  sessionId: string,
  model: string,
  timestamp: string,
  delta: Partial<UsageTotals>
): void {
  const session = getSession(state.sessions, source, sessionId);
  session.model = model;
  for (const target of [state.totals, state.bySource[source], session, getModel(state.byModel, model)]) {
    addDelta(target, delta, timestamp);
  }
  state.behavior.inputTokens += delta.inputTokens ?? 0;
  state.behavior.outputTokens += delta.outputTokens ?? 0;
  state.behavior.cacheTokens += (delta.cachedInputTokens ?? 0) + (delta.cacheReadInputTokens ?? 0) + (delta.cacheCreationInputTokens ?? 0);
  state.behavior.costUsd += delta.costUsd ?? 0;
}

function countBehavior(event: EvalEventRecord, behavior: Parameters<typeof scoreBehavior>[0]): void {
  if (/prompt/i.test(event.eventType)) behavior.prompts += 1;
  if (/tool/i.test(event.eventType)) behavior.tools += 1;
  if (/subagent/i.test(event.eventType)) behavior.subagents += 1;
  if (/task/i.test(event.eventType)) behavior.tasks += 1;
  if (/fail|error|denied/i.test(event.eventType)) behavior.failures += 1;
  if (!behavior.first || Date.parse(event.timestamp) < Date.parse(behavior.first)) behavior.first = event.timestamp;
  if (!behavior.last || Date.parse(event.timestamp) > Date.parse(behavior.last)) behavior.last = event.timestamp;
}

function scoreBehavior(input: {
  prompts: number;
  tools: number;
  subagents: number;
  tasks: number;
  failures: number;
  cacheTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  first: string | null;
  last: string | null;
}): BehavioralSignals {
  const cacheRatio = input.inputTokens > 0 ? input.cacheTokens / Math.max(1, input.inputTokens + input.cacheTokens) : 0;
  const toolPerPrompt = input.tools / Math.max(1, input.prompts);
  const costEfficiency = input.costUsd > 0 ? input.outputTokens / input.costUsd : input.outputTokens;
  const hours = input.first && input.last ? Math.max(0, (Date.parse(input.last) - Date.parse(input.first)) / 3_600_000) : 0;
  const notes: string[] = [];
  if (input.failures > 0) notes.push(`${input.failures} failure-like events observed`);
  if (cacheRatio > 0.5) notes.push("high cache leverage");
  if (input.subagents > 0) notes.push("subagent usage observed");
  if (input.tasks > 0) notes.push("task lifecycle telemetry observed");
  return {
    context: clampScore(40 + cacheRatio * 60),
    reach: clampScore(30 + Math.min(35, input.subagents * 8) + Math.min(35, input.tasks * 5) + Math.min(20, toolPerPrompt)),
    autonomy: clampScore(50 + Math.min(35, toolPerPrompt * 4) - Math.min(40, input.failures * 5)),
    flow: clampScore(30 + Math.min(50, hours * 4) + Math.min(20, input.prompts)),
    throughput: clampScore(30 + Math.min(45, costEfficiency / 250) + Math.min(25, input.outputTokens / 20_000)),
    notes
  };
}

function addDelta(target: UsageTotals, delta: Partial<UsageTotals>, timestamp: string): void {
  target.events += 1;
  target.requests += delta.requests ?? 0;
  target.inputTokens += delta.inputTokens ?? 0;
  target.cachedInputTokens += delta.cachedInputTokens ?? 0;
  target.cacheReadInputTokens += delta.cacheReadInputTokens ?? 0;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens ?? 0;
  target.outputTokens += delta.outputTokens ?? 0;
  target.reasoningOutputTokens += delta.reasoningOutputTokens ?? 0;
  target.totalTokens += delta.totalTokens ?? 0;
  target.costUsd += delta.costUsd ?? 0;
  touch(target, timestamp);
}

function touch(target: UsageTotals, timestamp: string): void {
  if (!target.first || Date.parse(timestamp) < Date.parse(target.first)) target.first = timestamp;
  if (!target.last || Date.parse(timestamp) > Date.parse(target.last)) target.last = timestamp;
}

function getSession(sessions: Map<string, MutableSession>, source: UsageSource, sessionId: string): MutableSession {
  const key = `${source}:${sessionId}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = { ...emptyTotals(), source, sessionId, model: null, firstStatusCost: null, lastStatusCost: null };
  sessions.set(key, created);
  return created;
}

function getModel(models: Map<string, UsageTotals>, model: string): UsageTotals {
  const existing = models.get(model);
  if (existing) return existing;
  const created = emptyTotals();
  models.set(model, created);
  return created;
}

function addModelStatuslineCost(models: Map<string, UsageTotals>, model: string, timestamp: string, costUsd: number): void {
  const summary = getModel(models, model);
  summary.statuslineCurrentCostUsd = Math.max(summary.statuslineCurrentCostUsd, costUsd);
  touch(summary, timestamp);
}

function latestSessionCostTotal(sessions: Map<string, MutableSession>, source: UsageSource | null): number {
  return [...sessions.values()]
    .filter((session) => source === null || session.source === source)
    .reduce((sum, session) => sum + (session.lastStatusCost ?? 0), 0);
}

function plainTotals(input: UsageTotals): UsageTotals {
  return {
    events: input.events,
    sessions: input.sessions,
    requests: input.requests,
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    outputTokens: input.outputTokens,
    reasoningOutputTokens: input.reasoningOutputTokens,
    totalTokens: input.totalTokens,
    costUsd: input.costUsd,
    statuslineCurrentCostUsd: input.statuslineCurrentCostUsd,
    first: input.first,
    last: input.last
  };
}

function emptyTotals(): UsageTotals {
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
    last: null
  };
}

function attributesFromPayload(payload: unknown): Record<string, unknown> {
  const object = objectValue(payload);
  return objectValue(object.attributes);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringFromPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const part of path) {
    current = objectValue(current)[part];
  }
  return stringFrom(current);
}

function numberFrom(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
