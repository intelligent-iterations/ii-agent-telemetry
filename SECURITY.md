# Security

Report security issues to security@intelligentiterations.com.

`ii-agent-telemetry` ingests agent telemetry that can contain sensitive prompts, command lines, paths, and tool payloads. The default deployment is local-only:

- Collector binds to `127.0.0.1`.
- Ingest endpoints require a bearer token.
- Port/token discovery file is written with mode `0600`.
- Redaction runs before durable storage.

Do not enable raw pre-redaction logs unless you are debugging locally and understand the data sensitivity.
