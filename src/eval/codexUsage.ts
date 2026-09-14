import type { EvalDatabase } from "../storage/evalDb.js";

export interface TokenUsageTotals {
  events: number;
  sessions: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  first: string | null;
  last: string | null;
}

export interface CodexUsageSummary {
  totals: TokenUsageTotals;
  recentSessions: Array<TokenUsageTotals & { sessionId: string }>;
}

const TOKEN_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

export function summarizeCodexUsage(db: EvalDatabase, options: { since?: string | null; sessionId?: string | null } = {}): CodexUsageSummary {
  const events = db.queryEvents({
    source: "codex",
    eventType: "codex.token_count",
    since: options.since ?? null,
    sessionId: options.sessionId ?? null,
    limit: 100_000
  });
  const totals = emptyTotals();
  const sessions = new Map<string, TokenUsageTotals>();

  for (const event of events) {
    const payload = event.payload as { usage?: Record<string, unknown> };
    addUsage(totals, payload.usage ?? {}, event.timestamp);
    const sessionId = event.sessionId ?? "unknown";
    const session = sessions.get(sessionId) ?? emptyTotals();
    addUsage(session, payload.usage ?? {}, event.timestamp);
    sessions.set(sessionId, session);
  }

  totals.sessions = sessions.size;
  return {
    totals,
    recentSessions: [...sessions.entries()]
      .map(([sessionId, total]) => ({ sessionId, ...total }))
      .sort((left, right) => Date.parse(right.last ?? "0") - Date.parse(left.last ?? "0"))
      .slice(0, 20)
  };
}

function emptyTotals(): TokenUsageTotals {
  return {
    events: 0,
    sessions: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    first: null,
    last: null
  };
}

function addUsage(total: TokenUsageTotals, usage: Record<string, unknown>, timestamp: string): void {
  total.events += 1;
  for (const key of TOKEN_KEYS) {
    total[key] += numberValue(usage[key]);
  }
  if (!total.first || Date.parse(timestamp) < Date.parse(total.first)) {
    total.first = timestamp;
  }
  if (!total.last || Date.parse(timestamp) > Date.parse(total.last)) {
    total.last = timestamp;
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
