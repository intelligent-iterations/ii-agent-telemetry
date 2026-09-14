import fs from "node:fs";

import { gcpAccessToken } from "./kpiRouter.js";

export interface BigQuerySchemaField {
  name: string;
  type: string;
  mode: string;
  fields?: BigQuerySchemaField[];
  description?: string;
  [key: string]: unknown;
}

interface BigQueryTableRef {
  project: string;
  dataset: string;
  table: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BigQuerySchemaMigrationResult {
  table: string;
  addedFields: string[];
  changed: boolean;
}

export function readBigQuerySchema(filePath: string): BigQuerySchemaField[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("BigQuery schema must be a JSON array");
  }
  return validateFields(parsed, "expected schema");
}

export async function migrateBigQuerySchema(input: {
  table: string;
  expectedFields: BigQuerySchemaField[];
  credentialsJson?: string | null;
  accessToken?: string;
  fetchImpl?: FetchLike;
}): Promise<BigQuerySchemaMigrationResult> {
  const table = parseBigQueryTable(input.table);
  const expected = validateFields(input.expectedFields, "expected schema");
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = input.accessToken ?? await gcpAccessToken(input.credentialsJson ?? null, [
    "https://www.googleapis.com/auth/bigquery"
  ]);
  const endpoint = tableEndpoint(table);
  const current = await readTable(fetchImpl, endpoint, token);
  const currentRawFields = current.schema?.fields;
  if (!Array.isArray(currentRawFields)) {
    throw new Error("deployed schema fields must be an array");
  }
  const currentFields = validateFields(currentRawFields, "deployed schema");
  const missing = missingFields(currentFields, expected);
  if (missing.length === 0) {
    return { table: input.table, addedFields: [], changed: false };
  }
  const nonNullable = missing.filter((field) => field.mode !== "NULLABLE");
  if (nonNullable.length > 0) {
    throw new Error(
      `BigQuery schema migration refuses missing non-nullable fields: ${nonNullable.map((field) => field.name).join(", ")}`
    );
  }
  const response = await fetchImpl(endpoint, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      ...(current.etag ? { "if-match": current.etag } : {})
    },
    body: JSON.stringify({ schema: { fields: [...currentRawFields, ...missing] } })
  });
  if (!response.ok) {
    throw new Error(`BigQuery schema patch failed: ${response.status} ${await response.text()}`);
  }
  const verified = await readTable(fetchImpl, endpoint, token);
  const verifiedFields = validateFields(verified.schema?.fields, "verified schema");
  const stillMissing = missingFields(verifiedFields, expected);
  if (stillMissing.length > 0) {
    throw new Error(`BigQuery schema verification is missing: ${stillMissing.map((field) => field.name).join(", ")}`);
  }
  return {
    table: input.table,
    addedFields: missing.map((field) => field.name),
    changed: true
  };
}

function missingFields(
  current: BigQuerySchemaField[],
  expected: BigQuerySchemaField[]
): BigQuerySchemaField[] {
  const currentByName = new Map(current.map((field) => [field.name, field]));
  const missing: BigQuerySchemaField[] = [];
  for (const field of expected) {
    const deployed = currentByName.get(field.name);
    if (!deployed) {
      missing.push(field);
      continue;
    }
    if (deployed.type !== field.type || deployed.mode !== field.mode) {
      throw new Error(
        `BigQuery field ${field.name} drifted: deployed=${deployed.type}/${deployed.mode} expected=${field.type}/${field.mode}`
      );
    }
  }
  return missing;
}

async function readTable(fetchImpl: FetchLike, endpoint: string, token: string): Promise<{
  etag?: string;
  schema?: { fields?: unknown };
}> {
  const response = await fetchImpl(endpoint, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`BigQuery table read failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as { etag?: string; schema?: { fields?: unknown } };
}

function validateFields(value: unknown, label: string): BigQuerySchemaField[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} fields must be an array`);
  }
  const names = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" ||
        typeof entry.type !== "string" || typeof entry.mode !== "string") {
      throw new Error(`${label} contains an invalid field`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,299}$/.test(entry.name) || names.has(entry.name)) {
      throw new Error(`${label} contains an invalid or duplicate field name: ${entry.name}`);
    }
    names.add(entry.name);
    return {
      name: entry.name,
      type: entry.type.toUpperCase(),
      mode: entry.mode.toUpperCase(),
      ...(Array.isArray(entry.fields)
        ? { fields: validateFields(entry.fields, `${label}.${entry.name}`) }
        : {})
    };
  });
}

function parseBigQueryTable(value: string): BigQueryTableRef {
  const parts = value.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]{1,128}$/.test(part))) {
    throw new Error("BigQuery table must be project.dataset.table");
  }
  const [project, dataset, table] = parts;
  return { project: project!, dataset: dataset!, table: table! };
}

function tableEndpoint(table: BigQueryTableRef): string {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(table.project)}` +
    `/datasets/${encodeURIComponent(table.dataset)}/tables/${encodeURIComponent(table.table)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
