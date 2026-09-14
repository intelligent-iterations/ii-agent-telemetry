import http from "node:http";

import { ingestHookEvent } from "./ingest/hooksReceiver.js";
import { ingestOtlpRequest } from "./ingest/otelReceiver.js";
import type { AgentTelemetryKind } from "./ingest/types.js";
import type { EventPipeline } from "./pipeline/eventPipeline.js";
import { createToken, isAuthorized, writePortFile } from "./portFile.js";

export interface EvalServer {
  server: http.Server;
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function startEvalServer(input: {
  pipeline: EventPipeline;
  portFile: string;
  activePortFile?: string;
  port?: number;
  token?: string;
  runId?: string;
  runDir?: string;
}): Promise<EvalServer> {
  const token = input.token ?? createToken();
  const server = http.createServer((request, response) => {
    void handleRequest({ request, response, pipeline: input.pipeline, token });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve evaluations server address");
  }

  const portRecord = {
    port: address.port,
    token,
    bind: "127.0.0.1" as const,
    pid: process.pid,
    runId: input.runId,
    runDir: input.runDir,
    sinks: input.pipeline.sinkNames()
  };
  writePortFile(input.portFile, portRecord);
  if (input.activePortFile) {
    writePortFile(input.activePortFile, portRecord);
  }

  return {
    server,
    port: address.port,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  pipeline: EventPipeline;
  token: string;
}): Promise<void> {
  const { request, response, pipeline, token } = input;
  try {
    if (request.method === "GET" && request.url === "/health/live") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (!isAuthorized(request.headers.authorization, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    const body = await readBody(request, maxBodyBytes());
    if (request.url === "/v1/hook-events") {
      const parsed = body.length ? JSON.parse(body.toString("utf8")) : {};
      const result = await ingestHookEvent(pipeline, parsed);
      sendJson(response, 202, result);
      return;
    }

    const otelKind = routeToOtelKind(request.url ?? "");
    if (otelKind) {
      const result = await ingestOtlpRequest({ pipeline, request, body, kind: otelKind });
      sendJson(response, 202, result);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(response, 413, { error: "payload_too_large", maxBytes: error.maxBytes });
      return;
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function routeToOtelKind(url: string): AgentTelemetryKind | null {
  if (url === "/v1/logs") {
    return "otel.logs";
  }
  if (url === "/v1/metrics") {
    return "otel.metrics";
  }
  if (url === "/v1/traces") {
    return "otel.traces";
  }
  return null;
}

class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
  }
}

function maxBodyBytes(): number {
  const parsed = Number.parseInt(process.env.EVALS_MAX_BODY_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024;
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}
