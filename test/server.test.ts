import assert from "node:assert/strict";
import path from "node:path";

import { authorizationHeader, readPortFile } from "../src/portFile.js";
import { startEvalServer } from "../src/server.js";
import { EventPipeline } from "../src/pipeline/eventPipeline.js";
import { EvalDatabase } from "../src/storage/evalDb.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-server-");
try {
  const db = new EvalDatabase(path.join(temp, "evals.sqlite"));
  db.init();
  const pipeline = new EventPipeline({ db });
  const server = await startEvalServer({ pipeline, portFile: path.join(temp, "port.json"), token: "test-token-abcdefghijklmnopqrstuvwxyz" });
  const previousMaxBodyBytes = process.env.EVALS_MAX_BODY_BYTES;
  try {
    // The port file records which sinks the running server wired up; this is
    // the only way a separate `doctor` process can tell whether the daemon has
    // usage reporting active, since sink selection reads the server's own env.
    assert.deepEqual(readPortFile(path.join(temp, "port.json")).sinks, []);

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/hook-events`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    const hook = await fetch(`http://127.0.0.1:${server.port}/v1/hook-events`, {
      method: "POST",
      headers: { authorization: authorizationHeader(server.token), "content-type": "application/json" },
      body: JSON.stringify({ source: "codex", event_type: "Stop", payload: { Authorization: "secret" } })
    });
    assert.equal(hook.status, 202);

    const otlp = await fetch(`http://127.0.0.1:${server.port}/v1/logs`, {
      method: "POST",
      headers: {
        authorization: authorizationHeader(server.token),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1777900000000000000",
                    attributes: [
                      { key: "event.name", value: { stringValue: "api_request" } },
                      { key: "session.id", value: { stringValue: "session-1" } },
                      { key: "model", value: { stringValue: "claude-sonnet-4-6" } },
                      { key: "input_tokens", value: { intValue: "100" } }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })
    });
    assert.equal(otlp.status, 202);
    assert.equal(db.countEvents(), 2);
    const latest = db.listEvents(2);
    assert.equal(db.queryEvents({ source: "claude-code", eventType: "claude_code.api_request", limit: 1 })[0]?.sessionId, "session-1");
    assert.equal(JSON.stringify(latest).includes("secret"), false);

    process.env.EVALS_MAX_BODY_BYTES = "16";
    const oversized = await fetch(`http://127.0.0.1:${server.port}/v1/hook-events`, {
      method: "POST",
      headers: { authorization: authorizationHeader(server.token), "content-type": "application/json" },
      body: JSON.stringify({ source: "codex", payload: "this body is too large" })
    });
    assert.equal(oversized.status, 413);
    assert.equal(db.countEvents(), 2);
  } finally {
    if (previousMaxBodyBytes === undefined) {
      delete process.env.EVALS_MAX_BODY_BYTES;
    } else {
      process.env.EVALS_MAX_BODY_BYTES = previousMaxBodyBytes;
    }
    await server.close();
    db.close();
  }
} finally {
  cleanup(temp);
}
