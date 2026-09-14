import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { authorizationHeader, createToken, isAuthorized, readPortFile, writePortFile } from "../src/portFile.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-port-");
try {
  const token = createToken();
  const filePath = path.join(temp, "port.json");
  writePortFile(filePath, { port: 4318, token, bind: "127.0.0.1", pid: process.pid });
  const stat = fs.statSync(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
  const parsed = readPortFile(filePath);
  assert.equal(parsed.port, 4318);
  assert.equal(isAuthorized(authorizationHeader(token), token), true);
  assert.equal(isAuthorized("Bearer wrong", token), false);
} finally {
  cleanup(temp);
}
