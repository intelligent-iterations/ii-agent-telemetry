# Product Boundary

`ii-agent-evaluations` owns local telemetry ingestion, redaction, storage, and self-evaluation reports for agent CLI sessions.

It does not own:

anything else.

Other packages may emit events into this package through OTel or hooks.
