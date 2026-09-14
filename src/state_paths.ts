import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PACKAGE_REPO_NAME = "ii-agent-evaluations";
export const STATE_ENV_VAR = "EVALS_STATE_DIR";
export const RUN_ID_ENV_VAR = "EVALS_RUN_ID";

export interface StatePaths {
  root: string;
  runId: string;
  runDir: string;
  eventsDir: string;
  cursorsDir: string;
  logsDir: string;
  reportsDir: string;
  dbPath: string;
  portFile: string;
  activePortFile: string;
  installManifest: string;
}

export function defaultRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function resolveStatePaths(options: { runId?: string; stateDir?: string; create?: boolean } = {}): StatePaths {
  const root = path.resolve(
    options.stateDir ?? process.env[STATE_ENV_VAR] ?? path.join(os.homedir(), "ii", PACKAGE_REPO_NAME)
  );
  const runId = options.runId ?? process.env[RUN_ID_ENV_VAR] ?? defaultRunId();
  const runDir = path.join(root, runId);
  const resolved = {
    root,
    runId,
    runDir,
    eventsDir: path.join(runDir, "events"),
    cursorsDir: path.join(runDir, "cursors"),
    logsDir: path.join(runDir, "logs"),
    reportsDir: path.join(runDir, "reports"),
    dbPath: path.join(runDir, "evaluations.sqlite"),
    portFile: path.join(runDir, "port.json"),
    activePortFile: path.join(root, "active-port.json"),
    installManifest: path.join(root, "installer", "manifest.json")
  };

  if (options.create ?? true) {
    for (const dir of [resolved.runDir, resolved.eventsDir, resolved.cursorsDir, resolved.logsDir, resolved.reportsDir, path.dirname(resolved.installManifest)]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  return resolved;
}
