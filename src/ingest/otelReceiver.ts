import type { IncomingMessage } from "node:http";

import type { EventPipeline } from "../pipeline/eventPipeline.js";
import type { AgentTelemetryKind, AgentTelemetrySource, EvalEventInput } from "./types.js";

export interface OtlpIngestResult {
  accepted: number;
  kind: AgentTelemetryKind;
}

export async function ingestOtlpRequest(input: {
  pipeline: EventPipeline;
  request: IncomingMessage;
  body: Buffer;
  kind: AgentTelemetryKind;
}): Promise<OtlpIngestResult> {
  const contentType = String(input.request.headers["content-type"] ?? "");
  const { payload, decoded } = parseOtlpPayload(input.body, contentType);
  const source = normalizeSource(input.request.headers["x-ii-agent-source"]) ?? inferSource(payload);
  const base = {
    source,
    kind: input.kind,
    sessionId: firstHeader(input.request.headers["x-ii-session-id"]),
    turnId: firstHeader(input.request.headers["x-ii-turn-id"])
  };

  const events = expandOtlpPayload(payload, input.kind, base);
  if (events.length === 0) {
    events.push({
      ...base,
      // A payload the collector cannot decode carries a distinct event type so
      // it is visible in storage instead of masquerading as a normal, empty
      // OTLP delivery. Protobuf OTLP lands here: it is retained verbatim but no
      // metrics can be read out of it.
      eventType: decoded ? input.kind : `${input.kind}.undecodable`,
      timestamp: new Date().toISOString(),
      payload
    });
  }

  let accepted = 0;
  for (const event of events) {
    const record = await input.pipeline.publish(event, "otel");
    if (record.accepted) {
      accepted += 1;
    }
  }
  return { accepted, kind: input.kind };
}

function parseOtlpPayload(body: Buffer, contentType: string): { payload: unknown; decoded: boolean } {
  if (/json/i.test(contentType)) {
    const text = body.toString("utf8").trim();
    return { payload: text ? JSON.parse(text) : {}, decoded: true };
  }
  // Only JSON OTLP is understood. Anything else (protobuf, most commonly) is
  // kept verbatim so nothing is lost, but it cannot be expanded into events.
  return {
    payload: {
      encoding: "base64",
      contentType: contentType || "application/x-protobuf",
      bytes: body.toString("base64")
    },
    decoded: false
  };
}

function expandOtlpPayload(
  payload: unknown,
  kind: AgentTelemetryKind,
  base: Pick<EvalEventInput, "source" | "kind" | "sessionId" | "turnId">
): EvalEventInput[] {
  if (!isRecord(payload)) {
    return [];
  }
  if (kind === "otel.logs") {
    return expandLogs(payload, base);
  }
  if (kind === "otel.metrics") {
    return expandMetrics(payload, base);
  }
  if (kind === "otel.traces") {
    return expandTraces(payload, base);
  }
  return [];
}

function expandLogs(payload: Record<string, unknown>, base: Pick<EvalEventInput, "source" | "kind" | "sessionId" | "turnId">): EvalEventInput[] {
  const events: EvalEventInput[] = [];
  for (const resourceLog of arrayOfRecords(payload.resourceLogs)) {
    const resource = attributesToRecord(recordPath(resourceLog, ["resource", "attributes"]));
    const source = inferSourceFromResource(resource) ?? base.source;
    for (const scopeLog of arrayOfRecords(resourceLog.scopeLogs)) {
      const scope = recordPath(scopeLog, ["scope"]);
      for (const logRecord of arrayOfRecords(scopeLog.logRecords)) {
        const attributes = attributesToRecord(logRecord.attributes);
        const eventName = stringAttribute(attributes, "event.name");
        const normalizedEventName = normalizeLogEventName(source, eventName);
        events.push({
          ...base,
          source,
          eventType: normalizedEventName ?? "otel.log_record",
          sessionId: stringAttribute(attributes, "session.id") ?? base.sessionId,
          turnId: stringAttribute(attributes, "prompt.id") ?? base.turnId,
          timestamp: otelTimestamp(logRecord.timeUnixNano) ?? stringAttribute(attributes, "event.timestamp") ?? new Date().toISOString(),
          payload: {
            resource,
            scope,
            attributes,
            body: otelValueToJs(recordPath(logRecord, ["body"])),
            severityText: logRecord.severityText,
            traceId: logRecord.traceId,
            spanId: logRecord.spanId
          }
        });
      }
    }
  }
  return events;
}

function normalizeLogEventName(source: AgentTelemetrySource, eventName: string | null): string | null {
  if (!eventName) return null;
  if (eventName.startsWith("codex.") || eventName.startsWith("claude_code.")) return eventName;
  if (source === "codex") return `codex.${eventName}`;
  if (source === "claude-code") return `claude_code.${eventName}`;
  return eventName;
}

function expandMetrics(payload: Record<string, unknown>, base: Pick<EvalEventInput, "source" | "kind" | "sessionId" | "turnId">): EvalEventInput[] {
  const events: EvalEventInput[] = [];
  for (const resourceMetric of arrayOfRecords(payload.resourceMetrics)) {
    const resource = attributesToRecord(recordPath(resourceMetric, ["resource", "attributes"]));
    const source = inferSourceFromResource(resource) ?? base.source;
    for (const scopeMetric of arrayOfRecords(resourceMetric.scopeMetrics)) {
      const scope = recordPath(scopeMetric, ["scope"]);
      for (const metric of arrayOfRecords(scopeMetric.metrics)) {
        const metricName = typeof metric.name === "string" ? metric.name : "otel.metric";
        for (const point of metricPoints(metric)) {
          const attributes = attributesToRecord(point.attributes);
          events.push({
            ...base,
            source,
            eventType: metricName,
            sessionId: stringAttribute(attributes, "session.id") ?? base.sessionId,
            timestamp: otelTimestamp(point.timeUnixNano) ?? new Date().toISOString(),
            payload: {
              resource,
              scope,
              metric: {
                name: metricName,
                description: metric.description,
                unit: metric.unit,
                type: point.type,
                value: point.value,
                attributes,
                startTimeUnixNano: point.startTimeUnixNano,
                timeUnixNano: point.timeUnixNano
              }
            }
          });
        }
      }
    }
  }
  return events;
}

function expandTraces(payload: Record<string, unknown>, base: Pick<EvalEventInput, "source" | "kind" | "sessionId" | "turnId">): EvalEventInput[] {
  const events: EvalEventInput[] = [];
  for (const resourceSpan of arrayOfRecords(payload.resourceSpans)) {
    const resource = attributesToRecord(recordPath(resourceSpan, ["resource", "attributes"]));
    const source = inferSourceFromResource(resource) ?? base.source;
    for (const scopeSpan of arrayOfRecords(resourceSpan.scopeSpans)) {
      const scope = recordPath(scopeSpan, ["scope"]);
      for (const span of arrayOfRecords(scopeSpan.spans)) {
        const attributes = attributesToRecord(span.attributes);
        events.push({
          ...base,
          source,
          eventType: typeof span.name === "string" ? span.name : "otel.span",
          sessionId: stringAttribute(attributes, "session.id") ?? base.sessionId,
          turnId: stringAttribute(attributes, "prompt.id") ?? base.turnId,
          timestamp: otelTimestamp(span.startTimeUnixNano) ?? new Date().toISOString(),
          payload: { resource, scope, span: { ...span, attributes } }
        });
      }
    }
  }
  return events;
}

function metricPoints(metric: Record<string, unknown>): Array<Record<string, unknown> & { type: string; value: unknown }> {
  const output: Array<Record<string, unknown> & { type: string; value: unknown }> = [];
  for (const [type, path] of [
    ["sum", ["sum", "dataPoints"]],
    ["gauge", ["gauge", "dataPoints"]],
    ["histogram", ["histogram", "dataPoints"]]
  ] as const) {
    for (const point of arrayOfRecords(recordPath(metric, path))) {
      output.push({ ...point, type, value: point.asDouble ?? point.asInt ?? point.count ?? point.sum });
    }
  }
  return output;
}

function inferSource(payload: unknown): AgentTelemetrySource {
  if (!isRecord(payload)) {
    return "unknown";
  }
  for (const key of ["resourceLogs", "resourceMetrics", "resourceSpans"]) {
    for (const item of arrayOfRecords(payload[key])) {
      const resource = attributesToRecord(recordPath(item, ["resource", "attributes"]));
      const source = inferSourceFromResource(resource);
      if (source !== null) {
        return source;
      }
    }
  }
  return "unknown";
}

function inferSourceFromResource(resource: Record<string, unknown>): AgentTelemetrySource | null {
  const serviceName = stringAttribute(resource, "service.name");
  if (serviceName === "claude-code") {
    return "claude-code";
  }
  if (serviceName === "codex") {
    return "codex";
  }
  return null;
}

function attributesToRecord(value: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const attr of arrayOfRecords(value)) {
    if (typeof attr.key === "string") {
      output[attr.key] = otelValueToJs(attr.value);
    }
  }
  return output;
}

function otelValueToJs(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bytesValue" in value) return value.bytesValue;
  if (isRecord(value.arrayValue)) return arrayOfRecords(value.arrayValue.values).map(otelValueToJs);
  if (isRecord(value.kvlistValue)) return attributesToRecord(value.kvlistValue.values);
  return value;
}

function otelTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  const ns = BigInt(value);
  return new Date(Number(ns / 1_000_000n)).toISOString();
}

function stringAttribute(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordPath(input: Record<string, unknown>, parts: readonly string[]): unknown {
  let current: unknown = input;
  for (const part of parts) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return current;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeSource(value: string | string[] | undefined): AgentTelemetrySource | null {
  const first = firstHeader(value);
  if (first === "claude-code" || first === "codex" || first === "harness" || first === "agent") {
    return first;
  }
  return null;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
