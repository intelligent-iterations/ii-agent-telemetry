import type { EventMiddleware, PipelineEnvelope } from "./types.js";

export class RequiredFieldsMiddleware implements EventMiddleware {
  readonly name = "required-fields";

  async handle(envelope: PipelineEnvelope): Promise<PipelineEnvelope | null> {
    if (!envelope.event.source || !envelope.event.kind || !envelope.event.eventType) {
      return null;
    }
    return envelope;
  }
}

export class AddRouteMetadataMiddleware implements EventMiddleware {
  readonly name = "route-metadata";

  async handle(envelope: PipelineEnvelope): Promise<PipelineEnvelope> {
    return {
      ...envelope,
      event: {
        ...envelope.event,
        payload:
          typeof envelope.event.payload === "object" && envelope.event.payload !== null && !Array.isArray(envelope.event.payload)
            ? {
                ...(envelope.event.payload as Record<string, unknown>),
                _pipeline: {
                  route: envelope.context.route,
                  receivedAt: envelope.context.receivedAt
                }
              }
            : {
                value: envelope.event.payload,
                _pipeline: {
                  route: envelope.context.route,
                  receivedAt: envelope.context.receivedAt
                }
              }
      }
    };
  }
}
