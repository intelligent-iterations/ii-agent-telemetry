import path from "node:path";

import { readPortFile } from "../portFile.js";
import { modifyJsonFile, type InstallContext } from "./fileOps.js";
import type { InstallManifestEntry } from "./manifest.js";

export function installClaudeOtel(context: InstallContext, portFilePath: string): InstallManifestEntry[] {
  const portFile = readPortFile(portFilePath);
  return [
    modifyJsonFile({
      context,
      phase: "claude-otel",
      targetPath: path.join(context.home, ".claude", "settings.json"),
      mutate: (settings) => {
        const env = typeof settings.env === "object" && settings.env !== null ? (settings.env as Record<string, unknown>) : {};
        return {
          ...settings,
          env: {
            ...env,
            CLAUDE_CODE_ENABLE_TELEMETRY: "1",
            OTEL_METRICS_EXPORTER: "otlp",
            OTEL_LOGS_EXPORTER: "otlp",
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${portFile.port}`,
            OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${portFile.port}/v1/metrics`,
            OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${portFile.port}/v1/logs`,
            OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${portFile.token}`,
            OTEL_SERVICE_NAME: "claude-code",
            OTEL_LOG_USER_PROMPTS: "0",
            OTEL_LOG_TOOL_DETAILS: "0",
            OTEL_LOG_TOOL_CONTENT: "0",
            OTEL_LOG_RAW_API_BODIES: "0"
          }
        };
      }
    })
  ];
}
