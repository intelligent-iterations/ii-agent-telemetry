import fs from "node:fs";
import path from "node:path";

import type { InstallManifestEntry } from "./manifest.js";

export interface InstallContext {
  home: string;
  packageRoot: string;
  stateDir: string;
  manifestPath: string;
  dryRun: boolean;
  force: boolean;
  now?: Date;
}

export function copyTreePhase(input: {
  context: InstallContext;
  phase: string;
  sourceDir: string;
  targetDir: string;
}): InstallManifestEntry[] {
  const entries: InstallManifestEntry[] = [];
  for (const sourcePath of listFiles(input.sourceDir)) {
    const relative = path.relative(input.sourceDir, sourcePath);
    const targetPath = path.join(input.targetDir, relative);
    const content = fs.readFileSync(sourcePath, "utf8");
    entries.push(writeManagedFile({ context: input.context, phase: input.phase, targetPath, content }));
  }
  return entries;
}

export function writeManagedFile(input: {
  context: InstallContext;
  phase: string;
  targetPath: string;
  content: string;
  mode?: number;
}): InstallManifestEntry {
  const installedAt = (input.context.now ?? new Date()).toISOString();
  const exists = fs.existsSync(input.targetPath);
  const previousContent = exists ? fs.readFileSync(input.targetPath, "utf8") : undefined;

  if (exists && previousContent !== input.content && !input.context.force) {
    throw new Error(`Refusing to overwrite existing file without --force: ${input.targetPath}`);
  }

  if (!input.context.dryRun) {
    fs.mkdirSync(path.dirname(input.targetPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(input.targetPath, input.content, { mode: input.mode ?? 0o600 });
  }

  return {
    phase: input.phase,
    path: input.targetPath,
    action: exists && previousContent === input.content ? "skipped" : "copied",
    previousContent,
    installedAt
  };
}

export function modifyJsonFile(input: {
  context: InstallContext;
  phase: string;
  targetPath: string;
  mutate: (value: Record<string, unknown>) => Record<string, unknown>;
}): InstallManifestEntry {
  const installedAt = (input.context.now ?? new Date()).toISOString();
  const previousContent = fs.existsSync(input.targetPath) ? fs.readFileSync(input.targetPath, "utf8") : "{}\n";
  const parsed = previousContent.trim() ? (JSON.parse(previousContent) as Record<string, unknown>) : {};
  const next = `${JSON.stringify(input.mutate(parsed), null, 2)}\n`;
  if (!input.context.dryRun) {
    fs.mkdirSync(path.dirname(input.targetPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(input.targetPath, next, { mode: 0o600 });
  }
  return {
    phase: input.phase,
    path: input.targetPath,
    action: previousContent === next ? "skipped" : "modified",
    previousContent,
    installedAt
  };
}

export function modifyTextFile(input: {
  context: InstallContext;
  phase: string;
  targetPath: string;
  mutate: (value: string) => string;
}): InstallManifestEntry {
  const installedAt = (input.context.now ?? new Date()).toISOString();
  const previousContent = fs.existsSync(input.targetPath) ? fs.readFileSync(input.targetPath, "utf8") : "";
  const next = input.mutate(previousContent);
  if (!input.context.dryRun) {
    fs.mkdirSync(path.dirname(input.targetPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(input.targetPath, next, { mode: 0o600 });
  }
  return {
    phase: input.phase,
    path: input.targetPath,
    action: previousContent === next ? "skipped" : "modified",
    previousContent,
    installedAt
  };
}

export function restoreManifestEntries(entries: InstallManifestEntry[], dryRun: boolean): void {
  for (const entry of [...entries].reverse()) {
    if (entry.action === "skipped") {
      continue;
    }
    if (dryRun) {
      continue;
    }
    if (entry.previousContent === undefined) {
      if (fs.existsSync(entry.path)) {
        fs.rmSync(entry.path);
      }
      pruneEmptyParents(path.dirname(entry.path));
    } else {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true, mode: 0o700 });
      fs.writeFileSync(entry.path, entry.previousContent, { mode: 0o600 });
    }
  }
}

function listFiles(root: string): string[] {
  const output: string[] = [];
  for (const child of fs.readdirSync(root, { withFileTypes: true })) {
    const childPath = path.join(root, child.name);
    if (child.isDirectory()) {
      output.push(...listFiles(childPath));
    } else if (child.isFile()) {
      output.push(childPath);
    }
  }
  return output;
}

function pruneEmptyParents(dir: string): void {
  let current = dir;
  for (let i = 0; i < 3; i += 1) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) {
      return;
    }
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}
