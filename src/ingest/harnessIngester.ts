import fs from "node:fs";

import type { EvalDatabase } from "../storage/evalDb.js";

export function ingestHarnessAuditSnapshot(input: { db: EvalDatabase; auditDbPath: string }): number {
  if (!fs.existsSync(input.auditDbPath)) {
    throw new Error(`Harness audit database not found: ${input.auditDbPath}`);
  }
  const record = input.db.recordEvent({
    source: "harness",
    kind: "harness",
    eventType: "harness.audit.snapshot",
    payload: {
      path: input.auditDbPath,
      importedAt: new Date().toISOString()
    },
    dedupKey: `harness:${input.auditDbPath}:${fs.statSync(input.auditDbPath).mtimeMs}`
  });
  return record ? 1 : 0;
}
