# Installer Contract

The installer is split into reversible phases:

- `skills`
- `prompts`
- `claude-hooks`
- `codex-hooks`
- `claude-otel`
- `codex-otel`
- `claude-statusline`
- `launch-agent`

Each phase writes a manifest entry under `~/ii/ii-agent-evaluations/installer/manifest.json`. `evals uninstall` restores the previous file contents or removes files that did not exist before install.

The installer does not create missing `~/.claude` or `~/.codex` homes. It exits with a clear error so users do not accidentally install into the wrong home.

The `launch-agent` phase writes
`~/Library/LaunchAgents/com.ii.agent-evaluations.plist` and uses
`~/Library/Logs/ii-agent-evaluations/` for stdout and stderr. The logs are kept
outside the evaluation state directory because launchd opens them before the
Node process starts.
