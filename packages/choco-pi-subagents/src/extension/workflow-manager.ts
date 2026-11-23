import { WorkflowManager } from "../workflow.ts";
import { mayTriggerTurn } from "@choco-pi/shared/stop-control";
import type { NotificationDetails } from "../types.ts";
import { escapeXml } from "./notification-format.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

export function installWorkflowManager(pi: ExtensionAPI, rt: SubagentsRuntime) {
  const workflowAdmissions = new Map<string, { root: string | undefined; epoch: number }>();
  const workflowManager = new WorkflowManager((result) => {
    pi.events.emit("subagents:workflow_completed", result);
    pi.appendEntry("subagents:workflow_record", result);
    rt.notifications.scheduleNudge(`workflow:${result.workflowId}`, () => {
      const admission = workflowAdmissions.get(result.workflowId);
      workflowAdmissions.delete(result.workflowId);
      if (workflowManager.isConsumed(result.workflowId)) return;
      const counts = new Map<string, number>();
      for (const step of result.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
      const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
      const cancelled = result.status === "cancelled";
      const failed = result.status === "error" || result.status === "completed_with_errors";
      const workflowTriggerTurn = mayTriggerTurn(
        admission?.root ?? rt.state.activeRootSessionId,
        admission?.epoch,
      );
      if (workflowTriggerTurn) rt.state.programStatus?.hold.expectWake();
      pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content:
            `<workflow-notification>\n` +
            `<workflow-id>${escapeXml(result.workflowId)}</workflow-id>\n` +
            `<status>${escapeXml(result.status)}</status>\n` +
            `<summary>Workflow "${escapeXml(result.name)}" ${escapeXml(result.status)}: ${escapeXml(summary)}</summary>\n` +
            `</workflow-notification>\nUse get_workflow_result for per-step outputs.`,
          display: true,
          details: {
            id: result.workflowId,
            description: `Workflow: ${result.name}`,
            status: cancelled ? "stopped" : failed ? "error" : "completed",
            toolUses: 0,
            turnCount: 0,
            totalTokens: 0,
            durationMs: (result.completedAt ?? Date.now()) - result.startedAt,
            resultPreview: summary,
          },
        },
        {
          deliverAs: "steer",
          triggerTurn: workflowTriggerTurn,
        },
      );
      rt.state.completionDeliveries += 1;
    });
  });
  rt.state.workflows = workflowManager;

  return { workflowManager, workflowAdmissions };
}
