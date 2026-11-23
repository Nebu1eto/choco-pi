/**
 * AgentManager construction and its listeners.
 */
import { DescendantFailureReporter } from "../subagent-tree.ts";
import { AgentManager } from "../agent-manager.ts";
import { TERMINAL_RESULT_RETRIEVAL_GUIDANCE } from "../result-read.ts";
import { mayTriggerTurn } from "@choco-pi/shared/stop-control";
import { formatModelLine } from "../invocation-config.ts";
import { registerSubagentStatusMessage } from "../limits.ts";
import { getMaxSubagentDepth } from "../nested-tools.ts";
import {
  type SubagentsUsageLimitEvent,
  SUBAGENTS_USAGE_LIMIT_EVENT,
  formatResetAt,
  scopeNote,
} from "../usage-limit-seam.ts";
import { formatProviderLabel } from "../../../choco-pi-ui/extensions/zentui/model-display.ts";
import { formatTaskNotification, buildNotificationDetails } from "./notification-format.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

/** Constructs the AgentManager and wires its status and usage-limit listeners. */
export function installAgentManager(pi: ExtensionAPI, rt: SubagentsRuntime) {
  // One root-visible line per failed nested generation (owner delivery is unchanged).
  const descendantFailures = new DescendantFailureReporter();

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager(
    (record) => {
      // Nested children report only through their owning parent's scoped tools.
      // Deliver their completion to the owning child session, not the root
      // lifecycle/UI channels. Delivery is best effort: the generation-pinned
      // result remains on the manager record if this notification is missed.
      if (record.parentAgentId) {
        const parent = manager.getRecord(record.parentAgentId);
        const failureLine = descendantFailures.report(record, parent);
        if (failureLine !== undefined) {
          // Informational, like usage-limit notices: rides the next root
          // delivery and never starts a root turn by itself.
          try {
            pi.sendMessage(
              {
                customType: "subagent-descendant-failure",
                content: `<task-notification>${failureLine}</task-notification>`,
                display: true,
              },
              { deliverAs: "steer", triggerTurn: false },
            );
          } catch (error) {
            console.error("[choco-pi-subagents] Descendant failure notice failed", error);
          }
        }
        const parentSession = parent?.session;
        const parentIsActive =
          parent !== undefined &&
          (parent.status === "running" || parent.status === "queued") &&
          parent.cancellation?.generation !== (parent.resultGeneration ?? 1);
        const generation = record.terminalResultGeneration;
        if (parentSession && parentIsActive && generation !== undefined && !record.resultConsumed) {
          const content =
            formatTaskNotification(record, 500) + `\n\n${TERMINAL_RESULT_RETRIEVAL_GUIDANCE}`;
          void parentSession
            .sendCustomMessage(
              {
                customType: "subagent-notification",
                content,
                display: true,
                details: buildNotificationDetails(record, 500),
              },
              {
                deliverAs: "steer",
                triggerTurn: mayTriggerTurn(record.admissionRoot, record.admissionEpoch),
              },
            )
            .catch(() => {
              /* missed delivery never consumes or removes the durable record */
            });
        }
        return;
      }

      // Emit lifecycle event based on terminal status
      const isError =
        record.status === "error" ||
        record.status === "stopped" ||
        record.status === "aborted" ||
        record.status === "budget_exceeded" ||
        record.status === "watchdog_stopped";
      const eventData = rt.notifications.buildEventData(record);
      if (isError) {
        rt.notifications.emitLifecycle("subagents:failed", eventData);
      } else {
        rt.notifications.emitLifecycle("subagents:completed", eventData);
      }

      // Persist final record for cross-extension history reconstruction
      pi.appendEntry("subagents:record", {
        id: record.id,
        type: record.type,
        description: record.description,
        status: record.status,
        result: record.result,
        error: record.error,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        ...(record.alias && { alias: record.alias }),
        ...(record.modelProvenance && {
          modelProvenance: record.modelProvenance,
          modelLine: formatModelLine(record.modelProvenance),
        }),
        ...(record.sideConversation && { sideConversation: true }),
        ...(record.workflowId && {
          workflowId: record.workflowId,
          workflowStepId: record.workflowStepId,
        }),
      });

      // Workflow steps remain ordinary top-level records for FleetView/focus and
      // lifecycle events, but static workflows deliver one aggregate result. A
      // dynamic workflow relays step completions so the orchestrator can adjust
      // the still-open graph from the result.
      if (record.workflowId) {
        if (rt.state.workflows?.shouldNotifySteps(record.workflowId)) {
          rt.notifications.sendIndividualNudge(record);
        } else {
          record.resultConsumed = true;
          manager.journalRecord(record.id);
          rt.agentActivity.delete(record.id);
          rt.views.fleet.markFinished(record.id);
          rt.views.fleet.onAgentFinished(record.id);
          rt.views.fleet.update();
        }
        return;
      }

      // Side answers stay out of the orchestrator transcript. Their controller
      // keeps an open overlay live, or emits a non-turn-triggering UI notice when
      // the user dismissed it. Shared lifecycle, widget and fleet bookkeeping
      // still applies because this is an ordinary top-level record.
      if (record.sideConversation) {
        rt.agentActivity.delete(record.id);
        rt.views.fleet.markFinished(record.id);
        rt.views.fleet.onAgentFinished(record.id);
        rt.views.sideConversations.onAgentComplete(record);
        rt.views.fleet.update();
        return;
      }

      // Skip notification if result was already consumed via get_subagent_result
      if (record.resultConsumed) {
        rt.agentActivity.delete(record.id);
        rt.views.fleet.markFinished(record.id);
        rt.views.fleet.onAgentFinished(record.id);
        rt.views.fleet.update();
        return;
      }

      // If this agent is pending batch finalization (debounce window still open),
      // don't send an individual nudge — finalizeBatch will pick it up retroactively.
      if (rt.state.currentBatchAgents.some((a) => a.id === record.id)) {
        rt.views.fleet.update();
        return;
      }

      const result = rt.notifications.groupJoin.onAgentComplete(record);
      if (result === "pass") {
        rt.notifications.sendIndividualNudge(record);
      }
      // 'held' → do nothing, group will fire later
      // 'delivered' → group callback already fired
      rt.views.fleet.update();
    },
    undefined,
    (record) => {
      if (record.parentAgentId) return;
      // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
      // and scheduler spawns enter through the manager directly.
      if (rt.state.currentCtx?.hasUI) {
        rt.views.fleet.ensureTimer();
        rt.views.fleet.update();
      }
      // Emit started event when agent transitions to running (including from queue)
      rt.notifications.emitLifecycle("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
        ...(record.workflowId && {
          workflowId: record.workflowId,
          workflowStepId: record.workflowStepId,
        }),
      });
    },
    (record, info) => {
      if (record.parentAgentId) return;
      // Emit compacted event when agent's session compacts (preserves count on record).
      rt.notifications.emitLifecycle("subagents:compacted", {
        id: record.id,
        type: record.type,
        description: record.description,
        reason: info.reason,
        tokensBefore: info.tokensBefore,
        compactionCount: record.compactionCount,
      });
    },
  );

  registerSubagentStatusMessage(pi, {
    getActiveCount: () => manager.getActiveCount(),
    getScheduledActiveCount: () => manager.getScheduledActiveCount(),
    getMaxConcurrent: () => manager.getMaxConcurrent(),
    getMaxSubagentDepth,
  });

  // Usage-limit transitions: an informational event on every transition, plus
  // one nudge to the owning parent when a child parks. The final outcome (with
  // the usageLimit block) travels through the ordinary completion notification.
  manager.setUsageLimitListener((record) => {
    const usageLimit = record.usageLimit;
    if (!usageLimit) return;
    const event: SubagentsUsageLimitEvent = {
      agentId: record.id,
      provider: usageLimit.provider,
      resetAt: usageLimit.resetAt,
      status: usageLimit.status,
    };
    pi.events.emit(SUBAGENTS_USAGE_LIMIT_EVENT, event);
    if (record.status !== "waiting_for_reset") return;
    const name = record.alias ?? record.handle ?? record.id;
    const until =
      usageLimit.resetAt === undefined
        ? "the provider reports capacity again (reset time unknown)"
        : formatResetAt(usageLimit.resetAt);
    const content =
      `child ${name} paused until ${until}: ${formatProviderLabel(usageLimit.provider)} usage limit (${usageLimit.kind})${scopeNote(usageLimit.scope)}. ` +
      `It resumes on the same model after the reset; its result will arrive as a notification. ` +
      `Suggested model: ${usageLimit.suggestedModel ?? "none available"}. ` +
      `To continue elsewhere now, stop it with stop_subagent and resume it with a model.`;
    const message = { customType: "subagent-usage-limit", content, display: true };
    if (record.parentAgentId) {
      const parent = manager.getRecord(record.parentAgentId);
      if (parent?.session && parent.status === "running") {
        void parent.session
          .sendCustomMessage(message, { deliverAs: "steer", triggerTurn: false })
          .catch(() => {
            /* informational only; the final notification still follows */
          });
      }
      return;
    }
    pi.sendMessage(message, { deliverAs: "steer", triggerTurn: false });
  });

  return { manager };
}
