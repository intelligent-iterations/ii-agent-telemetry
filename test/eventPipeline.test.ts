import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { EventPipeline } from "../src/pipeline/eventPipeline.js";
import { JsonlSink } from "../src/pipeline/sinks.js";
import type { EventSink, SinkResult } from "../src/pipeline/types.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-pipeline-");
try {
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  const routed = path.join(temp, "routed.jsonl");
  const pipeline = new EventPipeline({
    db,
    sinks: [new JsonlSink(routed)],
    errorLogPath: path.join(temp, "pipeline-errors.jsonl")
  });

  const result = await pipeline.publish(
    {
      source: "agent",
      kind: "hook",
      eventType: "pipeline.test",
      payload: { ok: true }
    },
    "test"
  );

  assert.equal(result.accepted, true);
  assert.equal(db.countEvents(), 1);
  assert.equal(fs.existsSync(routed), true);
  assert.match(fs.readFileSync(routed, "utf8"), /pipeline\.test/);
  db.close();

  // A sink that reports failure without throwing must still be logged; an
  // unauthorized or rejecting remote sink otherwise looks exactly like a
  // healthy one.
  const rejectingDb = new EvalDatabase(path.join(temp, "rejecting.sqlite"));
  rejectingDb.init();
  const rejectingErrors = path.join(temp, "rejecting-errors.jsonl");
  const rejectingSink: EventSink = {
    name: "rejecting",
    async publish(): Promise<SinkResult> {
      return { sink: "rejecting", ok: false, error: "http_403" };
    }
  };
  const rejectingPipeline = new EventPipeline({
    db: rejectingDb,
    sinks: [rejectingSink],
    errorLogPath: rejectingErrors
  });

  const rejected = await rejectingPipeline.publish(
    {
      source: "agent",
      kind: "hook",
      eventType: "pipeline.rejected",
      payload: { ok: true }
    },
    "test"
  );

  assert.equal(rejected.accepted, true);
  assert.equal(rejected.sinkResults[0]?.ok, false);
  assert.equal(fs.existsSync(rejectingErrors), true);
  const logged = JSON.parse(fs.readFileSync(rejectingErrors, "utf8").trim());
  assert.equal(logged.type, "sink_failure");
  assert.equal(logged.sink, "rejecting");
  assert.equal(logged.error, "http_403");
  rejectingDb.close();
} finally {
  cleanup(temp);
}
