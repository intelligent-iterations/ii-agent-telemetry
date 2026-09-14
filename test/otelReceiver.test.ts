import assert from "node:assert/strict";
import path from "node:path";

import { authorizationHeader } from "../src/portFile.js";
import { startEvalServer } from "../src/server.js";
import { EventPipeline } from "../src/pipeline/eventPipeline.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-otel-receiver-");
try {
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  const pipeline = new EventPipeline({ db });
  const server = await startEvalServer({
    pipeline,
    portFile: path.join(temp, "port.json"),
    token: "test-token-abcdefghijklmnopqrstuvwxyz"
  });

  try {
    // Only JSON OTLP can be expanded into events. A protobuf body is retained
    // verbatim but is not decodable, and must say so rather than being stored
    // as an ordinary, apparently-empty OTLP delivery.
    const protobuf = await fetch(`http://127.0.0.1:${server.port}/v1/logs`, {
      method: "POST",
      headers: {
        authorization: authorizationHeader(server.token),
        "content-type": "application/x-protobuf",
        "x-ii-agent-source": "codex"
      },
      body: Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74])
    });
    assert.equal(protobuf.status, 202);

    const undecodable = db.queryEvents({ source: "codex", limit: 10 });
    assert.equal(undecodable.length, 1);
    assert.equal(undecodable[0]?.eventType, "otel.logs.undecodable");

    // The equivalent JSON delivery expands normally and keeps the plain kind.
    const json = await fetch(`http://127.0.0.1:${server.port}/v1/logs`, {
      method: "POST",
      headers: {
        authorization: authorizationHeader(server.token),
        "content-type": "application/json",
        "x-ii-agent-source": "claude-code"
      },
      body: JSON.stringify({ resourceLogs: [] })
    });
    assert.equal(json.status, 202);

    const decoded = db.queryEvents({ source: "claude-code", limit: 10 });
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0]?.eventType, "otel.logs");
  } finally {
    await server.close();
    db.close();
  }
} finally {
  cleanup(temp);
}
