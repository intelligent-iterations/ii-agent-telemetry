import type { EvalDatabase } from "../storage/evalDb.js";

export function createSimpleSelfEvaluation(input: {
  db: EvalDatabase;
  sessionId: string;
  rubric: string;
}): { reportId: string; score: number; reportMarkdown: string } {
  const events = input.db.listEvents(500).filter((event) => event.sessionId === input.sessionId || input.sessionId === "all");
  const toolEvents = events.filter((event) => /tool|PreToolUse|PostToolUse/i.test(event.eventType)).length;
  const errorEvents = events.filter((event) => /error|fail/i.test(JSON.stringify(event.payload))).length;
  const score = Math.max(1, Math.min(5, 3 + Math.min(1, toolEvents) - Math.min(2, errorEvents)));
  const reportMarkdown = [
    `# Agent Evaluation: ${input.sessionId}`,
    "",
    `Rubric: ${input.rubric}`,
    `Score: ${score}/5`,
    "",
    `Events reviewed: ${events.length}`,
    `Tool events: ${toolEvents}`,
    `Error-like events: ${errorEvents}`
  ].join("\n");
  const reportId = input.db.recordReport({ sessionId: input.sessionId, rubric: input.rubric, score, reportMarkdown });
  return { reportId, score, reportMarkdown };
}
