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
