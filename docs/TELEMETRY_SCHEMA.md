# Telemetry Schema

Events are stored as normalized rows:

```text
id
source              # claude-code | codex | harness | agent | unknown
kind                # otel.logs | otel.metrics | otel.traces | hook | transcript
event_type
session_id
turn_id
timestamp
payload_json
redaction_version
schema_version
dedup_key
created_at
```

OpenTelemetry payloads are stored as received. JSON payloads remain JSON; protobuf payloads are base64 encoded with content-type metadata.

Transcript events are fallback/backfill only and use `(path, byte_offset)` as the deduplication key.

`codex.token_count` events are normalized from Codex transcript `event_msg` rows whose payload type is `token_count`.
