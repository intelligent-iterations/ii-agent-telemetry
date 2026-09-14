import path from "node:path";

import type { EvalEventRecord } from "../ingest/types.js";
import type { EvalDatabase } from "../storage/evalDb.js";
import { summarizeAgentUsage, type AgentUsageSummary, type UsageSource } from "./agentUsage.js";

export const DAILY_KPI_SCHEMA_VERSION = "ii-agent-kpis.daily.v1";

export interface DailyKpiPeriod {
  kind: "daily";
  date: string;
  timeZone: string;
  since: string;
  until: string;
}

export interface HumanInputSummary {
  total: number;
  bySource: Record<string, number>;
  sessions: number;
}

export interface DailyKpiReport {
  schemaVersion: typeof DAILY_KPI_SCHEMA_VERSION;
  generatedAt: string;
  period: DailyKpiPeriod;
  source: {
    dbPath: string;
  };
  metrics: {
    humanInputs: HumanInputSummary;
    tokens: {
      inputTokens: number;
      cachedInputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    };
    costUsd: {
      estimated: number;
      statuslineCurrent: number;
      bySource: Record<UsageSource, number>;
      byModel: Record<string, number>;
    };
    spendUsd: {
      period: number;
      label: string;
      basis: string;
    };
    events: {
      total: number;
      usageEvents: number;
      claudeOtelRequests: number;
      claudeStatuslineSamples: number;
      codexTokenEvents: number;
    };
    sessions: number;
    requests: number;
  };
  usage: AgentUsageSummary;
}

export interface DailyKpiArtifacts {
  report: DailyKpiReport;
  jsonFileName: string;
  markdownFileName: string;
  json: string;
  markdown: string;
}

export function createDailyKpiArtifacts(input: {
  db: EvalDatabase;
  dbPath: string;
  date?: string | null;
  timeZone?: string | null;
  now?: Date;
}): DailyKpiArtifacts {
  const period = dailyKpiPeriod({
    date: input.date ?? null,
    timeZone: input.timeZone ?? null,
    now: input.now
  });
  const usage = summarizeAgentUsage(input.db, { source: "all", since: period.since, until: period.until });
  const events = input.db.queryEvents({ since: period.since, until: period.until, limit: 500_000 });
  const humanInputs = summarizeHumanInputs(events);
  const byModelCost = Object.fromEntries(
    Object.entries(usage.byModel)
      .map(([model, totals]) => [model, roundUsd(totals.costUsd)])
      .sort((left, right) => Number(right[1]) - Number(left[1]))
  );
  const report: DailyKpiReport = {
    schemaVersion: DAILY_KPI_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period,
    source: { dbPath: path.resolve(input.dbPath) },
    metrics: {
      humanInputs,
      tokens: {
        inputTokens: usage.totals.inputTokens,
        cachedInputTokens: usage.totals.cachedInputTokens,
        cacheReadInputTokens: usage.totals.cacheReadInputTokens,
        cacheCreationInputTokens: usage.totals.cacheCreationInputTokens,
        outputTokens: usage.totals.outputTokens,
        reasoningOutputTokens: usage.totals.reasoningOutputTokens,
        totalTokens: usage.totals.totalTokens
      },
      costUsd: {
        estimated: roundUsd(usage.totals.costUsd),
        statuslineCurrent: roundUsd(usage.totals.statuslineCurrentCostUsd),
        bySource: {
          "claude-code": roundUsd(usage.bySource["claude-code"].costUsd),
          codex: roundUsd(usage.bySource.codex.costUsd)
        },
        byModel: byModelCost
      },
      spendUsd: {
        period: roundUsd(usage.totals.costUsd),
        label: spendLabelForPeriod(period),
        basis: "captured token usage in this KPI period, priced from known model rates"
      },
      events: {
        total: events.length,
        usageEvents: usage.totals.events,
        claudeOtelRequests: usage.telemetryCoverage.claudeOtelRequests,
        claudeStatuslineSamples: usage.telemetryCoverage.claudeStatuslineSamples,
        codexTokenEvents: usage.telemetryCoverage.codexTokenEvents
      },
      sessions: usage.totals.sessions,
      requests: usage.totals.requests
    },
    usage
  };
  return {
    report,
    jsonFileName: `agent-kpis-${period.date}.json`,
    markdownFileName: `agent-kpis-${period.date}.md`,
    json: `${JSON.stringify(report, null, 2)}\n`,
    markdown: renderDailyKpiMarkdown(report)
  };
}

export function dailyKpiPeriod(input: { date?: string | null; timeZone?: string | null; now?: Date } = {}): DailyKpiPeriod {
  const timeZone = input.timeZone ?? "America/Toronto";
  const date = input.date ?? previousLocalDate(input.now ?? new Date(), timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`KPI date must be YYYY-MM-DD, got: ${date}`);
  }
  const since = zonedMidnightUtc(date, timeZone).toISOString();
  const until = zonedMidnightUtc(addCalendarDays(date, 1), timeZone).toISOString();
  return { kind: "daily", date, timeZone, since, until };
}

function summarizeHumanInputs(events: EvalEventRecord[]): HumanInputSummary {
  const bySource: Record<string, number> = {};
  const sessions = new Set<string>();
  for (const event of events) {
    if (!isHumanInputEvent(event)) {
      continue;
    }
    bySource[event.source] = (bySource[event.source] ?? 0) + 1;
    if (event.sessionId) {
      sessions.add(`${event.source}:${event.sessionId}`);
    }
  }
  return {
    total: Object.values(bySource).reduce((sum, count) => sum + count, 0),
    bySource,
    sessions: sessions.size
  };
}

function isHumanInputEvent(event: EvalEventRecord): boolean {
  return event.eventType === "UserPromptSubmit" || event.eventType === "user_prompt_submit";
}

function renderDailyKpiMarkdown(report: DailyKpiReport): string {
  const topModels = Object.entries(report.metrics.costUsd.byModel)
    .filter(([model, cost]) => cost > 0 || (report.usage.byModel[model]?.totalTokens ?? 0) > 0)
    .slice(0, 8)
    .map(([model, cost]) => `| ${model} | ${formatCompactNumber(report.usage.byModel[model]?.totalTokens)} | ${formatUsd(cost)} |`)
    .join("\n");
  return [
    `# Agent KPIs - ${report.period.date}`,
    "",
    `Window: ${report.period.since} to ${report.period.until} (${report.period.timeZone})`,
    "",
    "## Usage",
    "",
    `- Human inputs: ${formatNumber(report.metrics.humanInputs.total)} (${humanInputSources(report)})`,
    `- Tokens captured: ${formatCompactNumber(report.metrics.tokens.totalTokens)} (${formatCompactNumber(report.metrics.tokens.cachedInputTokens)} cached input)`,
    `- Output: ${formatCompactNumber(report.metrics.tokens.outputTokens)} tokens + ${formatCompactNumber(report.metrics.tokens.reasoningOutputTokens)} reasoning`,
    `- ${report.metrics.spendUsd.label}: ${formatUsd(report.metrics.spendUsd.period)}`,
    "",
    "## By Agent",
    "",
    "| Agent | Tokens | Spend | Prompts | Sessions |",
    "|---|---:|---:|---:|---:|",
    ...sourceBreakdownRows(report),
    "",
    "## Coverage",
    "",
    `- Events: ${formatNumber(report.metrics.events.total)}`,
    `- Codex token events: ${formatNumber(report.metrics.events.codexTokenEvents)}`,
    `- Claude API requests: ${formatNumber(report.metrics.events.claudeOtelRequests)}`,
    `- Claude statusline samples: ${formatNumber(report.metrics.events.claudeStatuslineSamples)}`,
    ...markdownCoverageNotes(report),
    "",
    "## Models",
    "",
    "| Model | Tokens | Spend |",
    "|---|---:|---:|",
    topModels || "| n/a | 0 | $0.00 |",
    ""
  ].join("\n");
}

function sourceBreakdownRows(report: DailyKpiReport): string[] {
  const claude = report.usage.bySource["claude-code"];
  const codex = report.usage.bySource.codex;
  const claudeStatuslineCost = claude.statuslineCurrentCostUsd || report.metrics.costUsd.statuslineCurrent;
  const claudeTokenCell = claudeTokenTelemetryMissing(report) ? "n/a" : formatCompactNumber(claude.totalTokens);
  const claudeCostCell = report.metrics.events.claudeOtelRequests > 0
    ? formatUsd(claude.costUsd)
    : claudeStatuslineCost > 0
      ? `${formatUsd(claudeStatuslineCost)} statusline`
      : "n/a";
  return [
    `| Codex | ${formatCompactNumber(codex.totalTokens)} | ${formatUsd(codex.costUsd)} | ${formatNumber(report.metrics.humanInputs.bySource.codex)} | ${formatNumber(codex.sessions)} |`,
    `| Claude Code | ${claudeTokenCell} | ${claudeCostCell} | ${formatNumber(report.metrics.humanInputs.bySource["claude-code"])} | ${formatNumber(claude.sessions)} |`
  ];
}

function markdownCoverageNotes(report: DailyKpiReport): string[] {
  if (!claudeTokenTelemetryMissing(report)) {
    return [];
  }
  return [
    "- Claude token telemetry missing; Claude usage is not zero."
  ];
}

function claudeTokenTelemetryMissing(report: DailyKpiReport): boolean {
  const claudeInputs = report.metrics.humanInputs.bySource["claude-code"] ?? 0;
  const claudeSessions = report.usage.bySource["claude-code"].sessions;
  return report.metrics.events.claudeOtelRequests === 0 &&
    (report.metrics.events.claudeStatuslineSamples > 0 || claudeInputs > 0 || claudeSessions > 0);
}

function humanInputSources(report: DailyKpiReport): string {
  return `Claude Code ${formatNumber(report.metrics.humanInputs.bySource["claude-code"])}, Codex ${formatNumber(report.metrics.humanInputs.bySource.codex)}`;
}

function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function formatCompactNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Number(value ?? 0));
}

function formatUsd(value: number | null | undefined): string {
  const number = Number(value ?? 0);
  const digits = Math.abs(number) > 0 && Math.abs(number) < 0.01 ? 5 : 2;
  return `$${number.toFixed(digits)}`;
}

function spendLabelForPeriod(period: { kind?: string }): string {
  if (period.kind === "daily") {
    return "Daily spend";
  }
  if (period.kind === "weekly") {
    return "Weekly spend";
  }
  return "Period spend";
}

function previousLocalDate(now: Date, timeZone: string): string {
  const parts = zonedParts(now, timeZone);
  return addCalendarDays(formatDate(parts.year, parts.month, parts.day), -1);
}

function zonedMidnightUtc(date: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const targetLocal = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetLocal;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const actualLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = targetLocal - actualLocal;
    if (delta === 0) {
      break;
    }
    guess += delta;
  }
  return new Date(guess);
}

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
