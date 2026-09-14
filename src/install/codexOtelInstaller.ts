import path from "node:path";

import { readPortFile } from "../portFile.js";
import { type InstallContext } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";
import { mergeTomlLines } from "./codexHooksInstaller.js";

export function installCodexOtel(context: InstallContext, portFilePath: string): InstallManifestEntry[] {
  const portFile = readPortFile(portFilePath);
  return [
    mergeTomlLines({
      context,
      phase: "codex-otel",
      targetPath: path.join(context.home, ".codex", "config.toml"),
      lines: [
        "[otel]",
        "log_user_prompt = false",
        'environment = "dev"',
        // The collector only decodes JSON OTLP (see parseOtlpPayload). "binary"
        // makes Codex send protobuf, which is stored as an opaque blob and then
        // dropped during expansion, so no Codex token usage is ever recorded.
        `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${portFile.port}", protocol = "json", headers = { Authorization = "Bearer ${portFile.token}" } } }`
      ]
    })
  ];
}
