import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveStatePaths } from "../src/state_paths.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-state-");
try {
  const state = resolveStatePaths({ stateDir: temp, create: false });
  assert.notEqual(state.runId, "default");
  assert.equal(state.root, temp);
  assert.equal(fs.existsSync(state.runDir), false);
  assert.equal(state.activePortFile.endsWith("active-port.json"), true);
} finally {
  cleanup(temp);
}
