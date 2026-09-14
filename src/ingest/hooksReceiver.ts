import type { EventPipeline } from "../pipeline/eventPipeline.js";
import type { AgentTelemetryKind, AgentTelemetrySource } from "./types.js";

const EVENT_KIND_BY_TYPE = new Map<string, AgentTelemetryKind>([
  ["self_evaluation.created", "self_evaluation.created"]
]);

export interface HookEventPayload {
  source?: string;
  event_type?: string;
  eventType?: string;
  session_id?: string;
  sessionId?: string;
  turn_id?: string;
  turnId?: string;
  timestamp?: string;
  payload?: unknown;
  [key: string]: unknown;
}

export async function ingestHookEvent(pipeline: EventPipeline, event: HookEventPayload): Promise<{ accepted: boolean }> {
  const source = normalizeSource(event.source);
  const eventType = String(event.event_type ?? event.eventType ?? "hook.event");
  const accepted = await pipeline.publish({
    source,
    kind: kindForEventType(eventType),
    eventType,
    sessionId: stringOrNull(event.session_id ?? event.sessionId),
    turnId: stringOrNull(event.turn_id ?? event.turnId),
    timestamp: stringOrNull(event.timestamp),
    payload: event.payload ?? event
  }, "hook");
  return { accepted: accepted.accepted };
}

function kindForEventType(eventType: string): AgentTelemetryKind {
  return EVENT_KIND_BY_TYPE.get(eventType) ?? (eventType.startsWith("self_evaluation.") ? "self_evaluation" : "hook");
}

function normalizeSource(value: unknown): AgentTelemetrySource {
  if (value === "claude-code" || value === "codex" || value === "harness" || value === "agent") {
    return value;
  }
  return "unknown";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
