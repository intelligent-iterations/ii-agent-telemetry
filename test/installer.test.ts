import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { writePortFile } from "../src/portFile.js";
import { installAll } from "../src/install/installer.js";
import { uninstallAll } from "../src/install/uninstall.js";
import { resolveStatePaths } from "../src/state_paths.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-install-");
const previousStateDir = process.env.EVALS_STATE_DIR;
try {
  process.env.EVALS_STATE_DIR = path.join(temp, "state");
  const home = path.join(temp, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const initialClaudeSettings = JSON.stringify({ statusLine: { type: "command", command: "printf previous" } }, null, 2) + "\n";
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), initialClaudeSettings);
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "# existing\n\n[features]\ncodex_hooks = true\n");
  const state = resolveStatePaths();
  writePortFile(state.portFile, {
    port: 5555,
    token: "test-token-abcdefghijklmnopqrstuvwxyz",
    bind: "127.0.0.1",
    pid: process.pid
  });

  const entries = installAll({ home, packageRoot: process.cwd(), portFile: state.portFile });
  assert.equal(entries.length >= 6, true);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "ii-evaluations-emit", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, ".codex", "prompts", "ii-evaluations", "self-evaluate-last-session.md")), true);
  const codexConfig = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /hooks = true/);
  assert.doesNotMatch(codexConfig, /codex_hooks/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /log_user_prompt = false/);
  assert.match(codexConfig, /exporter = \{ otlp-http = \{ endpoint = "http:\/\/127\.0\.0\.1:5555", protocol = "json", headers = \{ Authorization = "Bearer test-token-abcdefghijklmnopqrstuvwxyz" \} \} \}/);
  const hooks = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.Stop[0].hooks[0].type, "command");
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /EVALS_STATE_DIR=/);
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(claudeSettings.hooks.Stop[0].hooks[0].type, "command");
  assert.match(claudeSettings.hooks.Stop[0].hooks[0].command, /EVALS_STATE_DIR=/);
  assert.equal(claudeSettings.hooks.StopFailure[0].hooks[0].type, "command");
  assert.equal(claudeSettings.env.OTEL_METRICS_EXPORTER, "otlp");
  assert.equal(claudeSettings.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(claudeSettings.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, "http://127.0.0.1:5555/v1/metrics");
  assert.equal(claudeSettings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "http://127.0.0.1:5555/v1/logs");
  assert.equal(claudeSettings.env.OTEL_LOG_TOOL_DETAILS, "0");
  assert.equal(claudeSettings.statusLine._iiEvaluations, true);
  assert.equal(claudeSettings._iiEvaluationsStatusLinePrevious.command, "printf previous");
  assert.equal(fs.existsSync(path.join(home, ".claude", "ii-evaluations-statusline.mjs")), true);
  const launchAgentPath = path.join(home, "Library", "LaunchAgents", "com.ii.agent-evaluations.plist");
  const launchAgent = fs.readFileSync(launchAgentPath, "utf8");
  assert.match(launchAgent, /<string>server<\/string>/);
  assert.match(launchAgent, /<key>EVALS_RUN_ID<\/key>\s*<string>default<\/string>/);
  assert.match(launchAgent, /<key>EVALS_STATE_DIR<\/key>/);
  assert.match(launchAgent, /Library\/Logs\/ii-agent-evaluations\/server\.log/);
  assert.doesNotMatch(launchAgent, /ii-agent-evaluations\/default\/logs\/server\.log/);
  assert.equal(fs.statSync(launchAgentPath).mode & 0o777, 0o644);

  const restored = uninstallAll({ manifestPath: state.installManifest, dryRun: false });
  assert.equal(restored, entries.length);
  assert.equal(fs.existsSync(state.installManifest), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "ii-evaluations-emit", "SKILL.md")), false);
  assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), initialClaudeSettings);
} finally {
  if (previousStateDir === undefined) {
    delete process.env.EVALS_STATE_DIR;
  } else {
    process.env.EVALS_STATE_DIR = previousStateDir;
  }
  cleanup(temp);
}
