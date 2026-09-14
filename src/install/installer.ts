import fs from "node:fs";
import path from "node:path";

import { resolveStatePaths } from "../state_paths.js";
import { installClaudeHooks } from "./claudeHooksInstaller.js";
import { installClaudeOtel } from "./claudeOtelInstaller.js";
import { installClaudeStatusline } from "./claudeStatuslineInstaller.js";
import { installCodexHooks } from "./codexHooksInstaller.js";
import { installCodexOtel } from "./codexOtelInstaller.js";
import { type InstallContext } from "./fileOps.js";
import { installLaunchAgent } from "./launchAgentInstaller.js";
import { appendManifestEntries, type InstallManifestEntry } from "./manifest.js";
import { installPrompts } from "./promptsInstaller.js";
import { installSkills } from "./skillsInstaller.js";

export type InstallPhase =
  | "skills"
  | "prompts"
  | "claude-hooks"
  | "codex-hooks"
  | "claude-otel"
  | "codex-otel"
  | "claude-statusline"
  | "launch-agent";

export interface InstallOptions {
  home?: string;
  packageRoot?: string;
  dryRun?: boolean;
  force?: boolean;
  phases?: InstallPhase[];
  portFile?: string;
}

export function installAll(options: InstallOptions = {}): InstallManifestEntry[] {
  const packageRoot = options.packageRoot ?? findPackageRoot(import.meta.dirname);
  const state = resolveStatePaths({ create: false });
  const context: InstallContext = {
    home: options.home ?? process.env.HOME ?? "",
    packageRoot,
    stateDir: state.root,
    manifestPath: state.installManifest,
    dryRun: options.dryRun ?? false,
    force: options.force ?? false
  };
  if (!context.home) {
    throw new Error("Unable to resolve HOME for installer");
  }
  const phases = options.phases ?? [
    "skills",
    "prompts",
    "claude-hooks",
    "codex-hooks",
    "claude-otel",
    "codex-otel",
    "claude-statusline",
    "launch-agent"
  ];
  const entries: InstallManifestEntry[] = [];
  ensureAgentHomes(context.home, phases);

  for (const phase of phases) {
    if (phase === "skills") entries.push(...installSkills(context));
    if (phase === "prompts") entries.push(...installPrompts(context));
    if (phase === "claude-hooks") entries.push(...installClaudeHooks(context));
    if (phase === "codex-hooks") entries.push(...installCodexHooks(context));
    if (phase === "claude-otel") entries.push(...installClaudeOtel(context, options.portFile ?? state.activePortFile));
    if (phase === "codex-otel") entries.push(...installCodexOtel(context, options.portFile ?? state.activePortFile));
    if (phase === "claude-statusline") entries.push(...installClaudeStatusline(context));
    if (phase === "launch-agent") entries.push(...installLaunchAgent(context));
  }

  if (!context.dryRun) {
    appendManifestEntries(context.manifestPath, entries);
  }
  return entries;
}

function findPackageRoot(start: string): string {
  let current = start;
  for (let index = 0; index < 8; index += 1) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { name?: string };
      if (parsed.name === "ii-agent-evaluations") {
        return current;
      }
    }
    current = path.dirname(current);
  }
  throw new Error(`Unable to locate ii-agent-evaluations package root from ${start}`);
}

function ensureAgentHomes(home: string, phases: InstallPhase[]): void {
  if (phases.some((phase) => phase.startsWith("claude") || phase === "skills") && !fs.existsSync(path.join(home, ".claude"))) {
    throw new Error(`Claude Code home not found: ${path.join(home, ".claude")}`);
  }
  if (phases.some((phase) => phase.startsWith("codex") || phase === "prompts") && !fs.existsSync(path.join(home, ".codex"))) {
    throw new Error(`Codex home not found: ${path.join(home, ".codex")}`);
  }
}
