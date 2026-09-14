import assert from "node:assert/strict";
import path from "node:path";

import { createSimpleSelfEvaluation } from "../src/eval/selfEvaluator.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-self-");
try {
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  db.recordEvent({ source: "agent", kind: "hook", eventType: "PostToolUse", sessionId: "s1", payload: { ok: true } });
  const result = createSimpleSelfEvaluation({ db, sessionId: "s1", rubric: "tool_use_quality" });
  assert.equal(result.score >= 1 && result.score <= 5, true);
  assert.match(result.reportMarkdown, /Events reviewed: 1/);
  db.close();
} finally {
  cleanup(temp);
}
