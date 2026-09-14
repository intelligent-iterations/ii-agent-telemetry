import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { REDACTION_VERSION, redactPayload } from "../redact.js";
import type { EvalEventInput, EvalEventRecord } from "../ingest/types.js";

export const EVENT_SCHEMA_VERSION = "eval-event.v1";

export interface EvalDatabaseOptions {
  readOnly?: boolean;
}

export class EvalDatabase {
  private db: DatabaseSync | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly options: EvalDatabaseOptions = {}
  ) {}

  init(): void {
    if (this.options.readOnly) {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      return;
    }

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        redaction_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        dedup_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_timestamp ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_kind_timestamp ON events(kind, timestamp);
      CREATE TABLE IF NOT EXISTS evaluation_reports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        rubric TEXT NOT NULL,
        score INTEGER NOT NULL,
        report_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  recordEvent(input: EvalEventInput): EvalEventRecord | null {
    const db = this.requireDb();
    const redacted = redactPayload(input.payload);
    if (redacted.dropped) {
      return null;
    }
    const timestamp = input.timestamp ?? new Date().toISOString();
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const payloadJson = JSON.stringify({
      value: redacted.value,
      redaction: { reasons: redacted.reasons }
    });
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO events (
          id, source, kind, event_type, session_id, turn_id, timestamp,
          payload_json, redaction_version, schema_version, dedup_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.source,
        input.kind,
        input.eventType,
        input.sessionId ?? null,
        input.turnId ?? null,
        timestamp,
        payloadJson,
        REDACTION_VERSION,
        EVENT_SCHEMA_VERSION,
        input.dedupKey ?? null,
        createdAt
      );

    if (result.changes === 0) {
      return null;
    }

    return {
      id,
      source: input.source,
      kind: input.kind,
      eventType: input.eventType,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      timestamp,
      payload: redacted.value,
      payloadJson,
      redactionVersion: REDACTION_VERSION,
      schemaVersion: EVENT_SCHEMA_VERSION,
      dedupKey: input.dedupKey ?? null,
      createdAt
    };
  }

  listEvents(limit = 100): EvalEventRecord[] {
    return this.requireDb()
      .prepare(
        `SELECT
          id, source, kind, event_type as eventType, session_id as sessionId,
          turn_id as turnId, timestamp, payload_json as payloadJson,
          redaction_version as redactionVersion, schema_version as schemaVersion,
          dedup_key as dedupKey, created_at as createdAt
        FROM events
        ORDER BY timestamp DESC
        LIMIT ?`
      )
      .all(limit)
      .map((row) => ({
        ...(row as Omit<EvalEventRecord, "payload">),
        payload: JSON.parse((row as { payloadJson: string }).payloadJson).value
      })) as EvalEventRecord[];
  }

  queryEvents(input: {
    source?: string | null;
    eventType?: string | null;
    sessionId?: string | null;
    since?: string | null;
    until?: string | null;
    limit?: number;
  }): EvalEventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.source) {
      clauses.push("source = ?");
      params.push(input.source);
    }
    if (input.eventType) {
      clauses.push("event_type = ?");
      params.push(input.eventType);
    }
    if (input.sessionId) {
      clauses.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.since) {
      clauses.push("timestamp >= ?");
      params.push(input.since);
    }
    if (input.until) {
      clauses.push("timestamp < ?");
      params.push(input.until);
    }
    params.push(input.limit ?? 1000);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.requireDb()
      .prepare(
        `SELECT
          id, source, kind, event_type as eventType, session_id as sessionId,
          turn_id as turnId, timestamp, payload_json as payloadJson,
          redaction_version as redactionVersion, schema_version as schemaVersion,
          dedup_key as dedupKey, created_at as createdAt
        FROM events
        ${where}
        ORDER BY timestamp DESC
        LIMIT ?`
      )
      .all(...params)
      .map((row) => ({
        ...(row as Omit<EvalEventRecord, "payload">),
        payload: JSON.parse((row as { payloadJson: string }).payloadJson).value
      })) as EvalEventRecord[];
  }

  countEvents(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };
    return row.count;
  }

  recordReport(input: { sessionId: string; rubric: string; score: number; reportMarkdown: string }): string {
    const id = crypto.randomUUID();
    this.requireDb()
      .prepare(
        `INSERT INTO evaluation_reports (id, session_id, rubric, score, report_markdown, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.rubric, input.score, input.reportMarkdown, new Date().toISOString());
    return id;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("EvalDatabase.init() must be called before use");
    }
    return this.db;
  }
}
