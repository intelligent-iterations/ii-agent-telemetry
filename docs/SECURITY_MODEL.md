# Security Model

The collector is local-only by default:

- Bind address is `127.0.0.1`.
- Ingest endpoints require `Authorization: Bearer <token>`.
- The active port and token are written to `port.json` with mode `0600`.
- Redaction runs before durable storage.

This protects against accidental remote exposure and unauthenticated local spoofing. It does not protect against a compromised user account on the same host.

Raw pre-redaction logging is intentionally not part of the default path.
