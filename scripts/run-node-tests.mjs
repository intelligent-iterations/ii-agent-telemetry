#!/usr/bin/env node

import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = process.cwd();
const args = process.argv.slice(2);
const roots = args.length > 0 ? args : ["test"];

function listTests(entry) {
  const absolute = path.resolve(repoRoot, entry);
  const relative = path.normalize(path.relative(repoRoot, absolute));
  if (relative.endsWith(".test.ts")) {
    return [relative];
  }
  const files = [];
  for (const child of readdirSync(absolute, { withFileTypes: true })) {
    const childRelative = path.join(relative, child.name);
    if (child.isDirectory()) {
      files.push(...listTests(childRelative));
    } else if (child.isFile() && child.name.endsWith(".test.ts")) {
      files.push(childRelative);
    }
  }
  return files;
}

const files = [...new Set(roots.flatMap(listTests))].sort((left, right) => left.localeCompare(right));
if (files.length === 0) {
  console.error("No test files matched.");
  process.exit(1);
}

let passed = 0;
const failed = [];

for (const file of files) {
  process.stdout.write(`RUN ${file}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", file], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }
  });
  if (result.status === 0) {
    passed += 1;
    process.stdout.write(`PASS ${file}\n`);
  } else {
    failed.push(file);
    process.stdout.write(`FAIL ${file}\n`);
  }
}

process.stdout.write(`\nSummary: ${passed}/${files.length} passed\n`);
if (failed.length > 0) {
  process.stderr.write(`Failed files:\n${failed.map((file) => `- ${file}`).join("\n")}\n`);
  process.exit(1);
}
