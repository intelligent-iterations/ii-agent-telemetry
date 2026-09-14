import fs from "node:fs";

import { restoreManifestEntries } from "./fileOps.js";
import { readManifest } from "./manifest.js";

export function uninstallAll(input: { manifestPath: string; dryRun: boolean }): number {
  const manifest = readManifest(input.manifestPath);
  restoreManifestEntries(manifest.entries, input.dryRun);
  if (!input.dryRun) {
    fs.rmSync(input.manifestPath, { force: true });
  }
  return manifest.entries.length;
}
