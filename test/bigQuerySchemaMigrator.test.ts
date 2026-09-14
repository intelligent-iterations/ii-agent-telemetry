import assert from "node:assert/strict";

import {
  migrateBigQuerySchema,
  type BigQuerySchemaField
} from "../src/export/bigQuerySchemaMigrator.js";

const base: BigQuerySchemaField[] = [
  { name: "scope_id", type: "STRING", mode: "REQUIRED", description: "existing metadata stays intact" }
];
const expected: BigQuerySchemaField[] = [
  ...base,
  { name: "host_id", type: "STRING", mode: "NULLABLE" },
  { name: "api_equivalent_cost_usd", type: "NUMERIC", mode: "NULLABLE" }
];

{
  const calls: Array<{ url: string; method: string; body: unknown; ifMatch: string | null }> = [];
  let fields = [...base];
  const result = await migrateBigQuerySchema({
    table: "example-project.ii_os.agent_usage_daily",
    expectedFields: expected,
    accessToken: "test-token",
    fetchImpl: async (input, init) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      calls.push({ url: String(input), method, body, ifMatch: headers.get("if-match") });
      assert.equal(headers.get("authorization"), "Bearer test-token");
      if (method === "PATCH") {
        fields = (body as { schema: { fields: BigQuerySchemaField[] } }).schema.fields;
        return Response.json({ schema: { fields } });
      }
      return Response.json({ etag: "etag-1", schema: { fields } });
    }
  });
  assert.deepEqual(result, {
    table: "example-project.ii_os.agent_usage_daily",
    addedFields: ["host_id", "api_equivalent_cost_usd"],
    changed: true
  });
  assert.deepEqual(calls.map((call) => call.method), ["GET", "PATCH", "GET"]);
  assert.equal(calls[1]?.ifMatch, "etag-1");
  assert.deepEqual(
    ((calls[1]?.body as { schema: { fields: BigQuerySchemaField[] } }).schema.fields).map((field) => field.name),
    ["scope_id", "host_id", "api_equivalent_cost_usd"]
  );
  assert.equal(
    (calls[1]?.body as { schema: { fields: BigQuerySchemaField[] } }).schema.fields[0]?.description,
    "existing metadata stays intact"
  );
}

{
  const methods: string[] = [];
  const result = await migrateBigQuerySchema({
    table: "example-project.ii_os.agent_usage_daily",
    expectedFields: expected,
    accessToken: "test-token",
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ schema: { fields: expected } });
    }
  });
  assert.equal(result.changed, false);
  assert.deepEqual(methods, ["GET"]);
}

await assert.rejects(
  migrateBigQuerySchema({
    table: "example-project.ii_os.agent_usage_daily",
    expectedFields: expected,
    accessToken: "test-token",
    fetchImpl: async () => Response.json({
      schema: { fields: [{ name: "scope_id", type: "INTEGER", mode: "REQUIRED" }] }
    })
  }),
  /scope_id drifted/
);

await assert.rejects(
  migrateBigQuerySchema({
    table: "example-project.ii_os.agent_usage_daily",
    expectedFields: [
      ...base,
      { name: "new_required", type: "STRING", mode: "REQUIRED" }
    ],
    accessToken: "test-token",
    fetchImpl: async () => Response.json({ schema: { fields: base } })
  }),
  /refuses missing non-nullable fields: new_required/
);
