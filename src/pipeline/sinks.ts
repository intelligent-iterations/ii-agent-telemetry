import fs from "node:fs";
import path from "node:path";

import type { EvalEventRecord } from "../ingest/types.js";
import type { EventSink, PipelineEnvelope, SinkResult } from "./types.js";

export class JsonlSink implements EventSink {
  readonly name = "jsonl";

  constructor(private readonly filePath: string) {}

  async publish(record: EvalEventRecord, envelope: PipelineEnvelope): Promise<SinkResult> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      this.filePath,
      `${JSON.stringify({ recordId: record.id, route: envelope.context.route, event: record })}\n`,
      { mode: 0o600 }
    );
    return { sink: this.name, ok: true };
  }
}

export class WebhookSink implements EventSink {
  readonly name = "webhook";

  constructor(
    private readonly input: {
      endpoint: string;
      token?: string | null;
      timeoutMs?: number;
    }
  ) {}

  async publish(record: EvalEventRecord, envelope: PipelineEnvelope): Promise<SinkResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.input.timeoutMs ?? 3000);
    try {
      const response = await fetch(this.input.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.input.token ? { authorization: `Bearer ${this.input.token}` } : {})
        },
        body: JSON.stringify({ record, route: envelope.context.route })
      });
      return response.ok
        ? { sink: this.name, ok: true }
        : { sink: this.name, ok: false, error: `http_${response.status}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
