import path from "node:path";

import { copyTreePhase, type InstallContext } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

export function installPrompts(context: InstallContext): InstallManifestEntry[] {
  return copyTreePhase({
    context,
    phase: "prompts",
    sourceDir: path.join(context.packageRoot, "prompts"),
    targetDir: path.join(context.home, ".codex", "prompts", "ii-evaluations")
  });
}
