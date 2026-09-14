import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { CodexTranscriptWatcher } from "../src/ingest/codexWatcher.js";
import { summarizeCodexUsage } from "../src/eval/codexUsage.js";
import { EventPipeline } from "../src/pipeline/eventPipeline.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-codex-");
try {
  const transcripts = path.join(temp, "sessions");
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(
    path.join(transcripts, "session.jsonl"),
    [
      '{"type":"message","text":"hello"}',
      '{"timestamp":"2026-05-04T12:59:00.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}',
      '{"timestamp":"2026-05-04T13:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"reasoning_output_tokens":1,"total_tokens":12},"last_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"reasoning_output_tokens":1,"total_tokens":12},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":5}}}}',
      "plain line",
      ""
    ].join("\n")
  );
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  const pipeline = new EventPipeline({ db });
  const watcher = new CodexTranscriptWatcher({ transcriptDir: transcripts, cursorsDir: path.join(temp, "cursors"), pipeline });
  await watcher.scanOnce();
  assert.equal(db.countEvents(), 4);
  const tokenPayload = db.queryEvents({ source: "codex", eventType: "codex.token_count", limit: 1 })[0]?.payload as { model?: string };
  assert.equal(tokenPayload.model, "gpt-5.5");
  const usage = summarizeCodexUsage(db);
  assert.equal(usage.totals.events, 1);
  assert.equal(usage.totals.input_tokens, 10);
  assert.equal(usage.totals.cached_input_tokens, 4);
  assert.equal(usage.totals.output_tokens, 2);
  assert.equal(usage.totals.reasoning_output_tokens, 1);
  assert.equal(usage.totals.total_tokens, 12);
  await watcher.scanOnce();
  assert.equal(db.countEvents(), 4);
  const crlfPath = path.join(transcripts, "crlf.jsonl");
  const crlfFirstLine = '{"type":"message","text":"crlf"}';
  fs.writeFileSync(
    crlfPath,
    [
      crlfFirstLine,
      '{"timestamp":"2026-05-04T13:01:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":2}}}}'
    ].join("\r\n")
  );
  await watcher.scanOnce();
  assert.equal(db.countEvents(), 6);
  const crlfTokenPayload = db.queryEvents({ source: "codex", eventType: "codex.token_count", sessionId: "crlf", limit: 1 })[0]?.payload as { byte_offset?: number };
  assert.equal(crlfTokenPayload.byte_offset, Buffer.byteLength(crlfFirstLine) + 2);
  db.close();
} finally {
  cleanup(temp);
}
