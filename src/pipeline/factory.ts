import { AddRouteMetadataMiddleware, RequiredFieldsMiddleware } from "./middleware.js";
import { JsonlSink, WebhookSink } from "./sinks.js";
import { EventPipeline } from "./eventPipeline.js";
import type { EvalDatabase } from "../storage/evalDb.js";
import {
  AgentUsageWebhookSink,
  type AgentUsageBillingMode,
  type AgentUsageExecutionOrigin
} from "../export/agentUsageWebhookSink.js";

export interface PipelineFactoryOptions {
  db: EvalDatabase;
  logsDir: string;
}

export function createDefaultPipeline(options: PipelineFactoryOptions): EventPipeline {
  const sinks = [];
  if (process.env.EVALS_EVENT_JSONL_SINK === "1") {
    sinks.push(new JsonlSink(`${options.logsDir}/events-routed.jsonl`));
  }
  if (process.env.EVALS_WEBHOOK_URL) {
    sinks.push(
      new WebhookSink({
        endpoint: process.env.EVALS_WEBHOOK_URL,
        token: process.env.EVALS_WEBHOOK_TOKEN ?? null
      })
    );
  }
  if (process.env.EVALS_USAGE_WEBHOOK_URL) {
    const workspaceId = requiredEnvironment("EVALS_USAGE_WORKSPACE_ID");
    const base = process.env.EVALS_USAGE_WEBHOOK_URL.replace(/\/$/, "");
    sinks.push(
      new AgentUsageWebhookSink({
        endpoint: `${base}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-usage/events`,
        tokenFile: requiredEnvironment("EVALS_USAGE_BEARER_TOKEN_FILE"),
        executionOrigin: executionOrigin(process.env.EVALS_EXECUTION_ORIGIN),
        billing: {
          mode: billingMode(process.env.II_AGENT_BILLING_MODE),
          provider: process.env.II_AGENT_BILLING_PROVIDER ?? "unknown",
          plan: process.env.II_AGENT_BILLING_PLAN,
          subscriptionCostUsdMonthly: optionalNonNegativeNumber(
            process.env.II_AGENT_SUBSCRIPTION_COST_USD_MONTHLY,
            "II_AGENT_SUBSCRIPTION_COST_USD_MONTHLY"
          )
        },
        codexTelemetry: process.env.EVALS_CODEX_TRANSCRIPT_DIR?.trim()
          ? "transcript"
          : "otel",
        fleet: {
          jobId: process.env.IIF_JOB_ID,
          leaseId: process.env.IIF_LEASE_ID,
          streamId: process.env.II_AGENT_STREAM_ID
        }
      })
    );
  }

  return new EventPipeline({
    db: options.db,
    middleware: [new RequiredFieldsMiddleware(), new AddRouteMetadataMiddleware()],
    sinks,
    errorLogPath: `${options.logsDir}/pipeline-errors.jsonl`
  });
}

function billingMode(value: string | undefined): AgentUsageBillingMode {
  if (!value) return "unknown";
  if (["subscription_included", "metered_api", "metered_credits", "cloud_provider", "unknown"].includes(value)) {
    return value as AgentUsageBillingMode;
  }
  throw new Error("II_AGENT_BILLING_MODE is invalid");
}

function optionalNonNegativeNumber(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when agent usage reporting is enabled`);
  return value;
}

function executionOrigin(value: string | undefined): AgentUsageExecutionOrigin {
  if (value === "local" || value === "cloud" || value === "unknown") return value;
  throw new Error("EVALS_EXECUTION_ORIGIN must be local, cloud, or unknown");
}
