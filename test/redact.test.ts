import assert from "node:assert/strict";

import { redactPayload } from "../src/redact.js";

const result = redactPayload({
  apiKey: "api-key-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  privateKey: "private-key-value",
  bearerToken: "bearer-token-value",
  nested: {
    password: "password-value",
    github_token: "github-token-value",
    ordinary: "visible"
  }
});

assert.equal(result.dropped, false);
assert.equal((result.value as Record<string, unknown>).apiKey, "[redacted]");
assert.equal((result.value as Record<string, unknown>).accessToken, "[redacted]");
assert.equal((result.value as Record<string, unknown>).refreshToken, "[redacted]");
assert.equal((result.value as Record<string, unknown>).privateKey, "[redacted]");
assert.equal((result.value as Record<string, unknown>).bearerToken, "[redacted]");
assert.equal(((result.value as { nested: Record<string, unknown> }).nested).password, "[redacted]");
assert.equal(((result.value as { nested: Record<string, unknown> }).nested).github_token, "[redacted]");
assert.equal(((result.value as { nested: Record<string, unknown> }).nested).ordinary, "visible");
