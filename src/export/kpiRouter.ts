import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface KpiArtifact {
  fileName: string;
  contentType: string;
  body: string;
}

export interface KpiSinkResult {
  sink: string;
  destinations: string[];
}

export interface KpiSink {
  readonly name: string;
  write(artifacts: KpiArtifact[]): Promise<KpiSinkResult>;
}

export class KpiRouter {
  constructor(private readonly sinks: KpiSink[]) {}

  async write(artifacts: KpiArtifact[]): Promise<KpiSinkResult[]> {
    const results: KpiSinkResult[] = [];
    for (const sink of this.sinks) {
      results.push(await sink.write(artifacts));
    }
    return results;
  }
}

export class LocalKpiSink implements KpiSink {
  readonly name = "local";

  constructor(private readonly outputDir: string) {}

  async write(artifacts: KpiArtifact[]): Promise<KpiSinkResult> {
    fs.mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
    const destinations: string[] = [];
    for (const artifact of artifacts) {
      const destination = path.join(this.outputDir, artifact.fileName);
      fs.writeFileSync(destination, artifact.body, { mode: 0o600 });
      destinations.push(destination);
    }
    return { sink: this.name, destinations };
  }
}

export class GcsKpiSink implements KpiSink {
  readonly name = "gcs";
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(input: { bucketUri: string; prefix?: string | null; credentialsJson?: string | null }) {
    const parsed = parseGcsUri(input.bucketUri);
    this.bucket = parsed.bucket;
    this.prefix = joinObjectName(parsed.prefix, input.prefix ?? "");
    this.credentialsJson = input.credentialsJson ?? null;
  }

  private readonly credentialsJson: string | null;

  async write(artifacts: KpiArtifact[]): Promise<KpiSinkResult> {
    const token = await gcpAccessToken(this.credentialsJson, [
      "https://www.googleapis.com/auth/devstorage.read_write"
    ]);
    const destinations: string[] = [];
    for (const artifact of artifacts) {
      const objectName = joinObjectName(this.prefix, artifact.fileName);
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
      url.searchParams.set("uploadType", "media");
      url.searchParams.set("name", objectName);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": artifact.contentType
        },
        body: artifact.body
      });
      if (!response.ok) {
        throw new Error(`GCS upload failed for gs://${this.bucket}/${objectName}: ${response.status} ${await response.text()}`);
      }
      destinations.push(`gs://${this.bucket}/${objectName}`);
    }
    return { sink: this.name, destinations };
  }
}

export function artifactsForDailyKpis(input: { jsonFileName: string; json: string; markdownFileName: string; markdown: string }): KpiArtifact[] {
  return [
    { fileName: input.jsonFileName, contentType: "application/json; charset=utf-8", body: input.json },
    { fileName: input.markdownFileName, contentType: "text/markdown; charset=utf-8", body: input.markdown }
  ];
}

export function parseSinkList(value: string | null | undefined): string[] {
  const sinks = (value ?? "local")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return sinks.length > 0 ? sinks : ["local"];
}

export function objectPrefixForDate(date: string): string {
  const [year, month, day] = date.split("-");
  return joinObjectName("daily", year, month, day);
}

function parseGcsUri(value: string): { bucket: string; prefix: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--gcs-bucket is required for the GCS KPI sink");
  }
  if (!trimmed.startsWith("gs://")) {
    return { bucket: trimmed, prefix: "" };
  }
  const withoutScheme = trimmed.slice("gs://".length);
  const slash = withoutScheme.indexOf("/");
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? "" : withoutScheme.slice(slash + 1);
  if (!bucket) {
    throw new Error(`Invalid GCS bucket URI: ${value}`);
  }
  return { bucket, prefix };
}

function joinObjectName(...parts: Array<string | null | undefined>): string {
  return parts
    .flatMap((part) => (part ?? "").split("/"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

export async function gcpAccessToken(credentialsJson: string | null, scopes: string[]): Promise<string> {
  if (scopes.length === 0) {
    throw new Error("At least one GCP OAuth scope is required");
  }
  const credentials = readServiceAccount(credentialsJson);
  const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(credentials.private_key, "base64url");
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`
    })
  });
  if (!response.ok) {
    throw new Error(`GCP token exchange failed: ${response.status} ${await response.text()}`);
  }
  const parsed = await response.json() as { access_token?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("GCP token exchange did not return access_token");
  }
  return parsed.access_token;
}

function readServiceAccount(credentialsJson: string | null): { client_email: string; private_key: string; token_uri?: string } {
  const raw =
    nonEmpty(credentialsJson) ??
    nonEmpty(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) ??
    nonEmpty(process.env.GCP_SERVICE_ACCOUNT_JSON) ??
    readCredentialsFile();
  if (!raw) {
    throw new Error("GCP KPI sinks require GOOGLE_APPLICATION_CREDENTIALS_JSON, GCP_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS");
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new Error("GCP service account JSON must include client_email and private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: typeof parsed.token_uri === "string" ? parsed.token_uri : undefined
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

function readCredentialsFile(): string | null {
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!filePath) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
