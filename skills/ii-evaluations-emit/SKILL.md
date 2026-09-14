---
name: ii-evaluations-emit
description: Emit structured self-evaluation telemetry and report artifacts for the current agent session. Use when asked to evaluate the current run, record a self-review, or persist evidence for agent quality analysis.
---

# ii-evaluations-emit

Emit a structured self-evaluation artifact for the current session.

## Contract

- Write concise, evidence-backed observations.
- Include the user goal, actions taken, tools used, verification performed, unresolved risks, and follow-up recommendations.
- Do not include secrets, credentials, or private environment values.
- Prefer structured JSON when calling `evals emit`; prefer Markdown only for human report artifacts.

## Suggested Event Shape

```json
{
  "event_type": "self_evaluation.created",
  "source": "agent",
  "payload": {
    "goal": "...",
    "actions": [],
    "verification": [],
    "risks": [],
    "score_notes": {}
  }
}
```
