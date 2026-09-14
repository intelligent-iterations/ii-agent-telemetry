import path from "node:path";

import { modifyJsonFile, writeManagedFile, type InstallContext } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

const PREVIOUS_STATUSLINE_KEY = "_iiEvaluationsStatusLinePrevious";

export function installClaudeStatusline(context: InstallContext): InstallManifestEntry[] {
  const scriptPath = path.join(context.home, ".claude", "ii-evaluations-statusline.mjs");
  const settingsPath = path.join(context.home, ".claude", "settings.json");
  const cliPath = path.join(context.packageRoot, "dist", "src", "cli.js");
  const entries: InstallManifestEntry[] = [
    writeManagedFile({
      context,
      phase: "claude-statusline",
      targetPath: scriptPath,
      content: statuslineWrapperScript({ cliPath, stateDir: context.stateDir })
    }),
    modifyJsonFile({
      context,
      phase: "claude-statusline",
      targetPath: settingsPath,
      mutate: (settings) => {
        const previous = previousStatusline(settings);
        return {
          ...settings,
          [PREVIOUS_STATUSLINE_KEY]: previous,
          statusLine: {
            type: "command",
            command: `NODE_NO_WARNINGS=1 node ${shellQuote(scriptPath)}`,
            padding: statuslinePadding(previous),
            _iiEvaluations: true
          }
        };
      }
    })
  ];
  return entries;
}

function previousStatusline(settings: Record<string, unknown>): unknown {
  if (settings[PREVIOUS_STATUSLINE_KEY] !== undefined) {
    return settings[PREVIOUS_STATUSLINE_KEY];
  }
  const current = settings.statusLine;
  if (isObject(current) && current._iiEvaluations === true) {
    return null;
  }
  return current ?? null;
}

function statuslinePadding(previous: unknown): number {
  if (isObject(previous) && typeof previous.padding === "number") {
    return previous.padding;
  }
  return 0;
}

function statuslineWrapperScript(input: { cliPath: string; stateDir: string }): string {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const cliPath = ${JSON.stringify(input.cliPath)};
const stateDir = ${JSON.stringify(input.stateDir)};
const previous = readPreviousStatusline();
const stdin = await readStdin();

spawnSync(process.execPath, [cliPath, "statusline", "--best-effort", "--quiet"], {
  input: stdin,
  encoding: "utf8",
  env: { ...process.env, NODE_NO_WARNINGS: "1", EVALS_STATE_DIR: stateDir },
  stdio: ["pipe", "ignore", "ignore"],
  timeout: 1500
});

if (previous && previous.type === "command" && typeof previous.command === "string") {
  const delegated = spawnSync(previous.command, {
    input: stdin,
    encoding: "utf8",
    env: process.env,
    shell: true,
    timeout: 1500
  });
  if (delegated.stdout && delegated.stdout.trim().length > 0) {
    process.stdout.write(delegated.stdout);
    process.exit(0);
  }
}

process.stdout.write(formatFallback(stdin) + "\\n");

function readPreviousStatusline() {
  try {
    const settingsPath = new URL("./settings.json", import.meta.url);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return settings[${JSON.stringify(PREVIOUS_STATUSLINE_KEY)}] ?? null;
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formatFallback(text) {
  try {
    const data = JSON.parse(text);
    const model = data.model?.display_name ?? data.model?.id ?? "Claude";
    const cost = Number(data.cost?.total_cost_usd ?? 0);
    const pct = Number(data.context_window?.used_percentage ?? 0);
    const limits = data.rate_limits?.five_hour?.used_percentage === undefined
      ? ""
      : " | 5h " + Math.round(Number(data.rate_limits.five_hour.used_percentage)) + "%";
    return "[" + model + "] $" + cost.toFixed(2) + " | " + Math.round(pct) + "% context" + limits;
  } catch {
    return "[Claude]";
  }
}
`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
