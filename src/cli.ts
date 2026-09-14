#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BigQueryKpiSink, type ExecutionOrigin } from "./export/bigQueryKpiSink.js";
import { migrateBigQuerySchema, readBigQuerySchema } from "./export/bigQuerySchemaMigrator.js";
import { artifactsForDailyKpis, GcsKpiSink, KpiRouter, LocalKpiSink, objectPrefixForDate, parseSinkList } from "./export/kpiRouter.js";
import { summarizeAgentUsage, type UsageSource } from "./eval/agentUsage.js";
import { summarizeCodexUsage } from "./eval/codexUsage.js";
import { createDailyKpiArtifacts } from "./eval/dailyKpis.js";
import { createSimpleSelfEvaluation } from "./eval/selfEvaluator.js";
import { CodexTranscriptWatcher } from "./ingest/codexWatcher.js";
import { ingestHookEvent } from "./ingest/hooksReceiver.js";
import { ingestHarnessAuditSnapshot } from "./ingest/harnessIngester.js";
import { installAll, type InstallPhase } from "./install/installer.js";
import { uninstallAll } from "./install/uninstall.js";
import { createDefaultPipeline } from "./pipeline/factory.js";
import { authorizationHeader, readPortFile } from "./portFile.js";
import { startEvalServer } from "./server.js";
import { RUN_ID_ENV_VAR, resolveStatePaths, type StatePaths } from "./state_paths.js";
import { EvalDatabase } from "./storage/evalDb.js";

interface CliOptions {
  flags: Map<string, string | true>;
  args: string[];
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (command === "help" || command === "--help") {
    printHelp();
    return;
  }

  const state = resolveCommandState(command);

  if (command === "server") {
    const db = openDb(state.dbPath);
    const pipeline = createDefaultPipeline({ db, logsDir: state.logsDir });
    const codexWatcher = startOptionalCodexWatcher({ pipeline, state });
    const server = await startEvalServer({
      pipeline,
      portFile: state.portFile,
      activePortFile: state.activePortFile,
      port: numberFlag(options, "port"),
      token: stringFlag(options, "token") ?? undefined,
      runId: state.runId,
      runDir: state.runDir
    });
    process.stdout.write(`evals listening on 127.0.0.1:${server.port}\n`);
    if (codexWatcher) {
      process.stdout.write(`codex transcript watcher active for ${codexWatcher.transcriptDir}\n`);
    }
    await waitForever();
    return;
  }

  if (command === "install") {
    const phases = stringFlag(options, "phases")?.split(",").filter(Boolean) as InstallPhase[] | undefined;
    const entries = installAll({
      dryRun: hasFlag(options, "dry-run"),
      force: hasFlag(options, "force"),
      phases,
      portFile: stringFlag(options, "port-file") ?? undefined
    });
    process.stdout.write(`${hasFlag(options, "dry-run") ? "would install" : "installed"} ${entries.length} entries\n`);
    return;
  }

  if (command === "uninstall") {
    const count = uninstallAll({ manifestPath: state.installManifest, dryRun: hasFlag(options, "dry-run") });
    process.stdout.write(`${hasFlag(options, "dry-run") ? "would uninstall" : "uninstalled"} ${count} entries\n`);
    return;
  }

  if (command === "emit") {
    await emit(options, state.portFile, state.dbPath, path.join(state.logsDir, "hook-errors.jsonl"));
    return;
  }

  if (command === "statusline") {
    await statusline(options, state.portFile, state.dbPath, path.join(state.logsDir, "hook-errors.jsonl"));
    return;
  }

  if (command === "ingest") {
    const db = openDb(state.dbPath);
    const pipeline = createDefaultPipeline({ db, logsDir: state.logsDir });
    const mode = options.args[0];
    if (mode === "codex") {
      const transcriptDir = options.args[1] ?? stringFlag(options, "dir") ?? path.join(os.homedir(), ".codex", "sessions");
      const watcher = new CodexTranscriptWatcher({ transcriptDir, cursorsDir: state.cursorsDir, pipeline });
      await watcher.scanOnce();
      process.stdout.write(`${db.countEvents()} total events\n`);
      return;
    }
    if (mode === "harness") {
      const auditDbPath = options.args[1] ?? stringFlag(options, "db");
      if (!auditDbPath) throw new Error("Usage: evals ingest harness <hero-audit.sqlite>");
      const count = ingestHarnessAuditSnapshot({ db, auditDbPath });
      process.stdout.write(`imported ${count} harness snapshot events\n`);
      return;
    }
  }

  if (command === "eval") {
    const db = openDb(state.dbPath);
    const sessionId = stringFlag(options, "session") ?? "all";
    const rubric = stringFlag(options, "rubric") ?? "tool_use_quality";
    const result = createSimpleSelfEvaluation({ db, sessionId, rubric });
    fs.writeFileSync(path.join(state.reportsDir, `${result.reportId}.md`), `${result.reportMarkdown}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "usage") {
    const db = openDb(state.dbPath);
    const target = options.args[0] ?? "codex";
    if (target === "codex" && stringFlag(options, "legacy")) {
      const summary = summarizeCodexUsage(db, {
        since: stringFlag(options, "since"),
        sessionId: stringFlag(options, "session")
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    if (target !== "codex" && target !== "claude" && target !== "claude-code" && target !== "all") {
      throw new Error("Usage: evals usage [all|claude|codex] [--since ISO]");
    }
    const source = usageSourceForTarget(target);
    const summary = summarizeAgentUsage(db, {
      since: stringFlag(options, "since"),
      until: stringFlag(options, "until"),
      source
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  if (command === "kpi") {
    await exportKpis(options, state);
    return;
  }

  if (command === "doctor") {
    const db = openDb(state.dbPath);
    const portExists = fs.existsSync(state.portFile);
    // Sink selection happens in the *server* process from its own environment,
    // so it cannot be read from this one. The running server records what it
    // wired up in the port file; report that rather than guessing from here.
    let runningSinks: string[] | null = null;
    if (portExists) {
      try {
        // Absent (a server predating this field) stays null = unknown; a
        // server with no sinks writes an explicit empty list.
        runningSinks = readPortFile(state.portFile).sinks ?? null;
      } catch {
        runningSinks = null;
      }
    }
    const pipelineErrors = path.join(state.logsDir, "pipeline-errors.jsonl");
    process.stdout.write(
      `${JSON.stringify(
        {
          state: state.runDir,
          db: state.dbPath,
          events: db.countEvents(),
          hookErrors: path.join(state.logsDir, "hook-errors.jsonl"),
          pipelineErrors: fs.existsSync(pipelineErrors) ? pipelineErrors : null,
          portFile: portExists ? state.portFile : null,
          runningSinks,
          usageReporting: runningSinks === null ? "unknown" : runningSinks.includes("agent-usage-webhook")
        },
        null,
        2
      )}\n`
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function emit(options: CliOptions, portFilePath: string, dbPath: string, errorLogPath: string): Promise<void> {
  const source = stringFlag(options, "source") ?? "agent";
  const eventType = stringFlag(options, "event") ?? "self_evaluation.created";
  const stdin = await readStdinIfPiped();
  const payload = stringFlag(options, "payload")
    ? JSON.parse(String(stringFlag(options, "payload")))
    : stdin
      ? JSON.parse(stdin)
      : { argv: process.argv.slice(2) };
  if (hasFlag(options, "local")) {
    const db = openDb(dbPath);
    const pipeline = createDefaultPipeline({ db, logsDir: path.dirname(errorLogPath) });
    await ingestHookEvent(pipeline, { source, event_type: eventType, payload });
    if (!hasFlag(options, "quiet")) {
      process.stdout.write("emitted locally\n");
    }
    return;
  }
  try {
    const portFile = readDiscoveredPortFile(portFilePath);
    const response = await fetch(`http://127.0.0.1:${portFile.port}/v1/hook-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationHeader(portFile.token)
      },
      body: JSON.stringify({ source, event_type: eventType, payload })
    });
    if (!response.ok) {
      throw new Error(`emit failed: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    if (hasFlag(options, "best-effort")) {
      appendHookError(errorLogPath, {
        source,
        eventType,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!hasFlag(options, "quiet")) {
        process.stderr.write(`evals emit skipped: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      return;
    }
    throw error;
  }
  if (!hasFlag(options, "quiet")) {
    process.stdout.write("emitted\n");
  }
}

async function statusline(options: CliOptions, portFilePath: string, dbPath: string, errorLogPath: string): Promise<void> {
  const stdin = await readStdinIfPiped();
  const payload = stdin ? JSON.parse(stdin) : {};
  const event = {
    source: "claude-code",
    event_type: "Status",
    session_id: stringFromPath(payload, ["session_id"]) ?? undefined,
    payload
  };
  try {
    if (hasFlag(options, "local")) {
      const db = openDb(dbPath);
      const pipeline = createDefaultPipeline({ db, logsDir: path.dirname(errorLogPath) });
      await ingestHookEvent(pipeline, event);
      db.close();
    } else {
      const portFile = readDiscoveredPortFile(portFilePath);
      const response = await fetch(`http://127.0.0.1:${portFile.port}/v1/hook-events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authorizationHeader(portFile.token)
        },
        body: JSON.stringify(event)
      });
      if (!response.ok) {
        throw new Error(`statusline emit failed: ${response.status} ${await response.text()}`);
      }
    }
  } catch (error) {
    if (!hasFlag(options, "best-effort")) {
      throw error;
    }
    appendHookError(errorLogPath, {
      source: "claude-code",
      eventType: "Status",
      error: error instanceof Error ? error.message : String(error)
    });
  }
  if (!hasFlag(options, "quiet")) {
    process.stdout.write(`${formatStatusline(payload)}\n`);
  }
}

async function exportKpis(options: CliOptions, state: StatePaths): Promise<void> {
  const mode = options.args[0] ?? "daily";
  if (mode === "migrate-bigquery-schema") {
    const table = stringFlag(options, "bigquery-table") ?? "";
    const schemaPath = stringFlag(options, "schema") ?? "";
    if (!table || !schemaPath) {
      throw new Error("Usage: evals kpi migrate-bigquery-schema --bigquery-table project.dataset.table --schema path.json");
    }
    const result = await migrateBigQuerySchema({
      table,
      expectedFields: readBigQuerySchema(schemaPath),
      credentialsJson: stringFlag(options, "gcp-credentials-json")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (mode !== "daily") {
    throw new Error("Usage: evals kpi daily [--date YYYY-MM-DD] [--timezone Zone] [--sink local,gcs,bigquery] [--out DIR] [--gcs-bucket gs://bucket/prefix] [--bigquery-table project.dataset.table --scope-id ID --execution-origin local|cloud|unknown]");
  }
  const dbPath = stringFlag(options, "db") ?? state.dbPath;
  if (!fs.existsSync(dbPath) && !hasFlag(options, "allow-empty")) {
    throw new Error(`KPI database not found: ${dbPath}. Pass --db, set EVALS_STATE_DIR to the mounted state root, or use --allow-empty.`);
  }
  const db = openDb(dbPath, { readOnly: fs.existsSync(dbPath) });
  try {
    const artifacts = createDailyKpiArtifacts({
      db,
      dbPath,
      date: stringFlag(options, "date"),
      timeZone: stringFlag(options, "timezone") ?? stringFlag(options, "time-zone")
    });
    const sinks = parseSinkList(stringFlag(options, "sink")).map((sinkName) => {
      if (sinkName === "local") {
        return new LocalKpiSink(stringFlag(options, "out") ?? path.join(state.reportsDir, "kpis", artifacts.report.period.date));
      }
      if (sinkName === "gcs") {
        const datePrefix = objectPrefixForDate(artifacts.report.period.date);
        const basePrefix = stringFlag(options, "gcs-prefix");
        const prefix = [basePrefix, datePrefix].filter(Boolean).join("/");
        return new GcsKpiSink({
          bucketUri: stringFlag(options, "gcs-bucket") ?? "",
          prefix,
          credentialsJson: stringFlag(options, "gcp-credentials-json")
        });
      }
      if (sinkName === "bigquery") {
        return new BigQueryKpiSink({
          table: stringFlag(options, "bigquery-table") ?? "",
          scopeId: stringFlag(options, "scope-id") ?? "",
          executionOrigin: executionOriginFlag(options),
          credentialsJson: stringFlag(options, "gcp-credentials-json")
        });
      }
      throw new Error(`Unknown KPI sink: ${sinkName}`);
    });
    const results = await new KpiRouter(sinks).write(artifactsForDailyKpis(artifacts));
    process.stdout.write(`${JSON.stringify({ report: artifacts.report, sinks: results }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

function formatStatusline(payload: unknown): string {
  if (!isRecord(payload)) {
    return "[Claude]";
  }
  const model = nestedString(payload, ["model", "display_name"]) ?? nestedString(payload, ["model", "id"]) ?? "Claude";
  const cost = nestedNumber(payload, ["cost", "total_cost_usd"]) ?? 0;
  const contextPct = nestedNumber(payload, ["context_window", "used_percentage"]) ?? 0;
  const fiveHourLimit = nestedNumber(payload, ["rate_limits", "five_hour", "used_percentage"]);
  const limit = fiveHourLimit === null ? "" : ` | 5h ${Math.round(fiveHourLimit)}%`;
  return `[${model}] $${cost.toFixed(2)} | ${Math.round(contextPct)}% context${limit}`;
}

function executionOriginFlag(options: CliOptions): ExecutionOrigin {
  const value = stringFlag(options, "execution-origin") ?? "unknown";
  if (value !== "local" && value !== "cloud" && value !== "unknown") {
    throw new Error("--execution-origin must be local, cloud, or unknown");
  }
  return value;
}

function stringFromPath(payload: unknown, pathParts: string[]): string | null {
  const value = nestedValue(payload, pathParts);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedString(payload: unknown, pathParts: string[]): string | null {
  const value = nestedValue(payload, pathParts);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedNumber(payload: unknown, pathParts: string[]): number | null {
  const value = nestedValue(payload, pathParts);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedValue(payload: unknown, pathParts: string[]): unknown {
  let current = payload;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendHookError(filePath: string, input: { source: string; eventType: string; error: string }): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({ ...input, createdAt: new Date().toISOString(), pid: process.pid })}\n`,
      { mode: 0o600 }
    );
  } catch {
    // Hook telemetry must never break the host agent.
  }
}

function startOptionalCodexWatcher(input: { pipeline: ReturnType<typeof createDefaultPipeline>; state: StatePaths }):
  | { transcriptDir: string; watcher: CodexTranscriptWatcher }
  | null {
  const transcriptDir = process.env.EVALS_CODEX_TRANSCRIPT_DIR;
  if (!transcriptDir) {
    return null;
  }
  const watcher = new CodexTranscriptWatcher({
    transcriptDir,
    cursorsDir: input.state.cursorsDir,
    pipeline: input.pipeline
  });
  watcher.start().catch((error) => {
    appendHookError(path.join(input.state.logsDir, "codex-watcher-errors.jsonl"), {
      source: "codex",
      eventType: "codex.transcript_watcher",
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return { transcriptDir, watcher };
}

function openDb(dbPath: string, options: { readOnly?: boolean } = {}): EvalDatabase {
  const db = new EvalDatabase(dbPath, options);
  db.init();
  return db;
}

function resolveCommandState(command: string): StatePaths {
  if (command === "install" || command === "uninstall") {
    return resolveStatePaths({ create: false });
  }
  if (command === "server") {
    return resolveStatePaths({ runId: process.env[RUN_ID_ENV_VAR] ?? undefined });
  }

  const base = resolveStatePaths({ create: false });
  if (!process.env[RUN_ID_ENV_VAR]) {
    const active = readOptionalPortFile(base.activePortFile);
    if (active?.runId) {
      return resolveStatePaths({ runId: active.runId });
    }
  }
  return resolveStatePaths();
}

function readDiscoveredPortFile(portFilePath: string) {
  if (fs.existsSync(portFilePath)) {
    return readPortFile(portFilePath);
  }
  const base = resolveStatePaths({ create: false });
  if (fs.existsSync(base.activePortFile)) {
    return readPortFile(base.activePortFile);
  }
  throw new Error(`Evaluations collector port file not found: ${portFilePath}. Start the collector or reinstall hooks with the intended EVALS_STATE_DIR.`);
}

function readOptionalPortFile(filePath: string) {
  try {
    return fs.existsSync(filePath) ? readPortFile(filePath) : null;
  } catch {
    return null;
  }
}

async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}

function parseArgs(args: string[]): CliOptions {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { flags, args: positional };
}

function hasFlag(options: CliOptions, key: string): boolean {
  return options.flags.has(key);
}

function stringFlag(options: CliOptions, key: string): string | null {
  const value = options.flags.get(key);
  return typeof value === "string" ? value : null;
}

function numberFlag(options: CliOptions, key: string): number | undefined {
  const value = stringFlag(options, key);
  return value ? Number.parseInt(value, 10) : undefined;
}

function usageSourceForTarget(target: string): UsageSource | "all" {
  if (target === "claude" || target === "claude-code") {
    return "claude-code";
  }
  if (target === "codex") {
    return "codex";
  }
  return "all";
}

function waitForever(): Promise<void> {
  return new Promise(() => undefined);
}

function printHelp(): void {
  process.stdout.write(`evals commands:
  server [--port N] [--token TOKEN]
  install [--dry-run] [--force] [--phases a,b]
  uninstall [--dry-run]
  emit [--source claude-code|codex|agent] [--event name] [--payload json] [--local] [--quiet]
  statusline [--best-effort] [--quiet]
  ingest codex <transcript-dir>  # default: ${path.join(os.homedir(), ".codex", "sessions")}
  ingest harness <hero-audit.sqlite>
  usage [all|claude|codex] [--since ISO] [--until ISO]
  usage codex --legacy [--since ISO] [--session id]
  kpi daily [--date YYYY-MM-DD] [--timezone Zone] [--sink local,gcs,bigquery] [--out DIR]
            [--gcs-bucket gs://bucket/prefix]
            [--bigquery-table project.dataset.table --scope-id ID --execution-origin local|cloud|unknown]
  eval [--session id] [--rubric name]
  doctor
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
