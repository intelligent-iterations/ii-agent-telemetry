import path from "node:path";

import type { InstallContext } from "./fileOps.js";

export function evalsCommand(context: InstallContext, args: string): string {
  const cliPath = path.join(context.packageRoot, "dist", "src", "cli.js");
  return `EVALS_STATE_DIR=${shellQuote(context.stateDir)} NODE_NO_WARNINGS=1 node ${shellQuote(cliPath)} ${args}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
