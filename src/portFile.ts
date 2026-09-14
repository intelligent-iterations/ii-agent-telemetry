import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PortFile {
  port: number;
  token: string;
  bind: "127.0.0.1";
  pid: number;
  updatedAt: string;
  runId?: string;
  runDir?: string;
  /**
   * Names of the sinks the running server actually wired up. Written by the
   * server so `doctor` can report what the *daemon* is doing: sink selection
   * depends on that process's environment, which a separate CLI invocation
   * cannot see.
   */
  sinks?: string[];
}

export function createToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function writePortFile(filePath: string, input: Omit<PortFile, "updatedAt">): PortFile {
  const record: PortFile = { ...input, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
  return record;
}

export function readPortFile(filePath: string): PortFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PortFile>;
  if (
    parsed.bind !== "127.0.0.1" ||
    !Number.isInteger(parsed.port) ||
    typeof parsed.port !== "number" ||
    parsed.port <= 0 ||
    typeof parsed.token !== "string" ||
    parsed.token.length < 32 ||
    !Number.isInteger(parsed.pid)
  ) {
    throw new Error(`Invalid evaluations port file: ${filePath}`);
  }
  return parsed as PortFile;
}

export function authorizationHeader(token: string): string {
  return `Bearer ${token}`;
}

export function isAuthorized(header: string | string[] | undefined, token: string): boolean {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate === authorizationHeader(token);
}
