import path from "node:path";

import { copyTreePhase, type InstallContext } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

export function installSkills(context: InstallContext): InstallManifestEntry[] {
  return copyTreePhase({
    context,
    phase: "skills",
    sourceDir: path.join(context.packageRoot, "skills"),
    targetDir: path.join(context.home, ".claude", "skills")
  });
}
