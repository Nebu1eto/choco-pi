/**
 * Model-visible snake_case views of workflow snapshots. The in-memory WorkflowResult and the
 * `subagents:*` event payloads keep their camelCase names; only tool content text uses these.
 */
import type { WorkflowResult, WorkflowStepResult } from "./workflow.ts";

function workflowStepView(step: WorkflowStepResult) {
  return {
    id: step.id,
    ...(step.agentId !== undefined && { agent_id: step.agentId }),
    status: step.status,
    ...(step.output !== undefined && { output: step.output }),
    ...(step.error !== undefined && { error: step.error }),
    ...(step.startedAt !== undefined && { started_at: step.startedAt }),
    ...(step.completedAt !== undefined && { completed_at: step.completedAt }),
  };
}

export function workflowResultView(result: WorkflowResult) {
  return {
    workflow_id: result.workflowId,
    name: result.name,
    dynamic: result.dynamic,
    sealed: result.sealed,
    status: result.status,
    started_at: result.startedAt,
    ...(result.completedAt !== undefined && { completed_at: result.completedAt }),
    steps: result.steps.map((step) => workflowStepView(step)),
  };
}
