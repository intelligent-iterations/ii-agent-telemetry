import fs from "node:fs";
import path from "node:path";

import { type InstallContext, writeManagedFile } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

const LABEL = "com.ii.agent-evaluations";

export function installLaunchAgent(context: InstallContext): InstallManifestEntry[] {
  const logsDir = path.join(context.home, "Library", "Logs", "ii-agent-evaluations");
  const plistPath = path.join(context.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (!context.dryRun) {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  }
  return [
    writeManagedFile({
      context,
      phase: "launch-agent",
      targetPath: plistPath,
      mode: 0o644,
      content: launchAgentPlist({
        nodePath: process.execPath,
        cliPath: path.join(context.packageRoot, "dist", "src", "cli.js"),
        stateDir: context.stateDir,
        stdoutPath: path.join(logsDir, "server.log"),
        stderrPath: path.join(logsDir, "server.err.log"),
        home: context.home
      })
    })
  ];
}

function launchAgentPlist(input: {
  nodePath: string;
  cliPath: string;
  stateDir: string;
  stdoutPath: string;
  stderrPath: string;
  home: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.nodePath)}</string>
    <string>${xmlEscape(input.cliPath)}</string>
    <string>server</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EVALS_RUN_ID</key>
    <string>default</string>
    <key>EVALS_STATE_DIR</key>
    <string>${xmlEscape(input.stateDir)}</string>
    <key>EVALS_CODEX_TRANSCRIPT_DIR</key>
    <string>${xmlEscape(path.join(input.home, ".codex", "sessions"))}</string>
    <key>NODE_NO_WARNINGS</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.home)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
