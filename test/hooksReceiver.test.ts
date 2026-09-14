import assert from "node:assert/strict";
import path from "node:path";

import { ingestHookEvent } from "../src/ingest/hooksReceiver.js";
import { EventPipeline } from "../src/pipeline/eventPipeline.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-hooks-");
try {
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  const pipeline = new EventPipeline({ db });

  await ingestHookEvent(pipeline, { source: "agent", event_type: "self_evaluation.created", payload: { ok: true } });
  await ingestHookEvent(pipeline, { source: "agent", event_type: "self_evaluation.updated", payload: { ok: true } });

  const events = db.listEvents(10);
  assert.equal(events.find((event) => event.eventType === "self_evaluation.created")?.kind, "self_evaluation.created");
  assert.equal(events.find((event) => event.eventType === "self_evaluation.updated")?.kind, "self_evaluation");
  db.close();
} finally {
  cleanup(temp);
}
