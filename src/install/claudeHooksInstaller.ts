import path from "node:path";

import { evalsCommand } from "./commandPath.js";
import { modifyJsonFile, type InstallContext } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

export function installClaudeHooks(context: InstallContext): InstallManifestEntry[] {
  const settingsPath = path.join(context.home, ".claude", "settings.json");
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "SubagentStart",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
    "Stop",
    "StopFailure",
    "PreCompact",
    "PostCompact",
    "Notification",
    "InstructionsLoaded",
    "ConfigChange",
    "CwdChanged",
    "SessionEnd"
  ];
  return [
    modifyJsonFile({
      context,
      phase: "claude-hooks",
      targetPath: settingsPath,
      mutate: (settings) => {
        const hooks = typeof settings.hooks === "object" && settings.hooks !== null ? (settings.hooks as Record<string, unknown>) : {};
        for (const eventName of events) {
          const current = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
          hooks[eventName] = [
            ...current.filter((entry) => !(typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)._iiEvaluations === true)),
            {
              ...(needsToolMatcher(eventName) ? { matcher: "*" } : {}),
              hooks: [
                {
                  type: "command",
                  command: evalsCommand(context, `emit --source claude-code --event ${eventName} --best-effort --quiet`),
                  timeout: 30
                }
              ],
              _iiEvaluations: true
            }
          ];
        }
        return { ...settings, hooks };
      }
    })
  ];
}

function needsToolMatcher(eventName: string): boolean {
  return [
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch"
  ].includes(eventName);
}
