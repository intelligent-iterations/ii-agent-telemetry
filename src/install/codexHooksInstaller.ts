import path from "node:path";

import { evalsCommand } from "./commandPath.js";
import { type InstallContext, modifyJsonFile, modifyTextFile } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];

export function installCodexHooks(context: InstallContext): InstallManifestEntry[] {
  const hooksPath = path.join(context.home, ".codex", "hooks.json");
  return [
    modifyJsonFile({
      context,
      phase: "codex-hooks",
      targetPath: hooksPath,
      mutate: (existing) => {
        const existingHooks =
          typeof existing.hooks === "object" && existing.hooks !== null ? (existing.hooks as Record<string, unknown>) : {};
        const nextHooks: Record<string, unknown> = { ...existingHooks };
        for (const eventName of HOOK_EVENTS) {
          const current = Array.isArray(nextHooks[eventName]) ? (nextHooks[eventName] as unknown[]) : [];
          nextHooks[eventName] = [
            ...current.filter(
              (entry) => !(typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)._iiEvaluations === true)
            ),
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: evalsCommand(context, `emit --source codex --event ${eventName} --best-effort --quiet`),
                  timeout: 30
                }
              ],
              _iiEvaluations: true
            }
          ];
        }
        return { ...existing, hooks: nextHooks };
      }
    }),
    mergeTomlLines({
      context,
      phase: "codex-hooks",
      targetPath: path.join(context.home, ".codex", "config.toml"),
      lines: ["[features]", "hooks = true"],
      remove: [{ section: "features", key: "codex_hooks" }]
    })
  ];
}

export function mergeTomlLines(input: {
  context: InstallContext;
  phase: string;
  targetPath: string;
  lines: string[];
  remove?: Array<{ section: string; key: string }>;
}): InstallManifestEntry {
  return modifyTextFile({
    context: input.context,
    phase: input.phase,
    targetPath: input.targetPath,
    mutate: (previous) => {
      let next = previous;
      for (const removal of input.remove ?? []) {
        next = removeSectionAssignment(next, removal.section, removal.key);
      }
      let section = "";
      for (const line of input.lines) {
        if (line.startsWith("[") && line.endsWith("]")) {
          section = line.slice(1, -1);
          next = ensureSection(next, section);
          continue;
        }
        const [key, ...valueParts] = line.split("=");
        if (!key || valueParts.length === 0) {
          continue;
        }
        next = setSectionAssignment(next, section, key.trim(), valueParts.join("=").trim());
      }
      return next.endsWith("\n") ? next : `${next}\n`;
    }
  });
}

function removeSectionAssignment(content: string, section: string, key: string): string {
  const lines = content.split("\n");
  const header = `[${section}]`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) {
    return content;
  }
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*\[.*]\s*$/.test(line)) {
      break;
    }
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      lines.splice(index, 1);
      break;
    }
  }
  return lines.join("\n");
}

function ensureSection(content: string, section: string): string {
  const header = `[${section}]`;
  if (new RegExp(`^${escapeRegExp(header)}\\s*$`, "m").test(content)) {
    return content.endsWith("\n") ? content : `${content}\n`;
  }
  const prefix = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  return `${prefix}${prefix.length > 0 ? "\n" : ""}${header}\n`;
}

function setSectionAssignment(content: string, section: string, key: string, value: string): string {
  const lines = ensureSection(content, section).split("\n");
  const header = `[${section}]`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  let insertAt = lines.length - 1;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*\[.*]\s*$/.test(line)) {
      insertAt = index;
      break;
    }
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      lines[index] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(insertAt, 0, `${key} = ${value}`);
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
