import fs from "node:fs";
import path from "node:path";

export interface InstallManifestEntry {
  phase: string;
  path: string;
  action: "copied" | "modified" | "skipped";
  backupPath?: string;
  previousContent?: string;
  installedAt: string;
}

export interface InstallManifest {
  version: 1;
  entries: InstallManifestEntry[];
}

export function readManifest(filePath: string): InstallManifest {
  if (!fs.existsSync(filePath)) {
    return { version: 1, entries: [] };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as InstallManifest;
}

export function writeManifest(filePath: string, manifest: InstallManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function appendManifestEntries(filePath: string, entries: InstallManifestEntry[]): void {
  const manifest = readManifest(filePath);
  manifest.entries.push(...entries);
  writeManifest(filePath, manifest);
}

export function latestEntriesByPath(manifest: InstallManifest): Map<string, InstallManifestEntry> {
  const output = new Map<string, InstallManifestEntry>();
  for (const entry of manifest.entries) {
    output.set(entry.path, entry);
  }
  return output;
}
