import type { NotificationDetails, AgentRecord } from "../types.ts";
import { renderVerdictNotification } from "../delegation-render.ts";
import { Text } from "@earendil-works/pi-tui";
import {
  renderSubagentNotification,
  renderAgentMessageEnvelope,
} from "../ui/notification-render.ts";
import { extractText } from "../context.ts";
import { NotificationGate, NUDGE_HOLD_MS } from "../notification-gate.ts";
import { isDormantRunUnfinished, TERMINAL_RESULT_RETRIEVAL_GUIDANCE } from "../result-read.ts";
import { mayTriggerTurn } from "@choco-pi/shared/stop-control";
import { GroupJoinManager } from "../group-join.ts";
import { buildLifecycleMetadata, finalReportSummary } from "../lifecycle-event.ts";
import { getLifetimeTotal } from "../usage.ts";
import {
  dormantNotificationRecord,
  buildNotificationDetails,
  formatTaskNotification,
} from "./notification-format.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

export function installMessageRenderers(pi: ExtensionAPI) {
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const details = message.details;
      if (!details) return undefined;
      return (
        renderVerdictNotification(details, expanded, theme) ??
        new Text(renderSubagentNotification(details, { expanded }, theme), 0, 0)
      );
    },
  );
  pi.registerMessageRenderer("subagent-message", (message, _options, theme) => {
    const content = Array.isArray(message.content) ? extractText(message.content) : message.content;
    const rendered = renderAgentMessageEnvelope(content, theme);
    return rendered === undefined ? undefined : new Text(rendered, 0, 0);
  });
}

export function installNotifications(pi: ExtensionAPI, rt: SubagentsRuntime) {
  const notificationGate = new NotificationGate<AgentRecord>({
    resolve: (key) => {
      const record = rt.core.manager.getRecord(key);
      if (record === undefined) {
        const dormant = rt.core.manager.getDormant(key);
        return dormant !== undefined &&
          dormant.parentAgentId === undefined &&
          !isDormantRunUnfinished(dormant.status)
          ? dormantNotificationRecord(dormant)
          : undefined;
      }
      return record.status !== "running" &&
        record.status !== "queued" &&
        record.status !== "waiting_for_reset" &&
        record.status !== "interrupted"
        ? record
        : undefined;
    },
    send: emitNudges,
    onError: (error) => console.error("[choco-pi-subagents] Notification delivery failed", error),
  });
  const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

  const workflowNudges = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleNudge(key: string, send: () => void) {
    cancelNudge(key);
    workflowNudges.set(
      key,
      setTimeout(() => {
        workflowNudges.delete(key);
        try {
          send();
        } catch {}
      }, NUDGE_HOLD_MS),
    );
  }

  function cancelNudge(key: string) {
    notificationGate.cancel(key);
    const timer = workflowNudges.get(key);
    if (timer !== undefined) clearTimeout(timer);
    workflowNudges.delete(key);
  }

  function emitNudges(records: AgentRecord[]) {
    const [first, ...rest] = records;
    if (!first) return;
    const limit = rest.length > 0 ? 300 : 500;
    const details = buildNotificationDetails(first, limit, rt.agentActivity.get(first.id));
    if (rest.length > 0) {
      details.others = rest.map((record) =>
        buildNotificationDetails(record, limit, rt.agentActivity.get(record.id)),
      );
    }
    const notifications = records.map((record) => {
      const footer = record.outputFile
        ? `\nFull transcript available at: ${record.outputFile}`
        : "";
      return formatTaskNotification(record, limit) + footer;
    });
    const triggerTurn = completionMayTriggerTurn(records);
    if (triggerTurn) rt.state.programStatus?.hold.expectWake();
    pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: `${notifications.join("\n\n")}\n\n${TERMINAL_RESULT_RETRIEVAL_GUIDANCE}`,
        display: true,
        details,
      },
      { deliverAs: "steer", triggerTurn },
    );
    rt.state.completionDeliveries += 1;
  }

  function completionMayTriggerTurn(records: readonly AgentRecord[]): boolean {
    return records.every((record) =>
      mayTriggerTurn(record.admissionRoot ?? rt.state.activeRootSessionId, record.admissionEpoch),
    );
  }

  function sendIndividualNudge(record: AgentRecord) {
    rt.agentActivity.delete(record.id);
    rt.views.fleet.markFinished(record.id);
    rt.views.fleet.onAgentFinished(record.id);
    notificationGate.enqueue(record.id);
    rt.views.fleet.update();
  }

  const groupJoin = new GroupJoinManager((records) => {
    for (const r of records) {
      rt.agentActivity.delete(r.id);
      rt.views.fleet.markFinished(r.id);
      rt.views.fleet.onAgentFinished(r.id);
    }

    for (const record of records) notificationGate.enqueue(record.id);
    rt.views.fleet.update();
  }, 30_000);

  function emitLifecycle<Payload extends { id: string }>(event: string, payload: Payload): void {
    const record = rt.core.manager.getRecord(payload.id);
    if (record !== undefined) {
      pi.events.emit(event, { ...payload, ...buildLifecycleMetadata(record) });
      return;
    }
    pi.events.emit(event, {
      toolCallId: null,
      outputFile: null,
      parentAgentId: null,
      description: null,
      model: null,
      cwd: null,
      ...payload,
    });
  }

  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt
      ? record.completedAt - record.startedAt
      : Date.now() - record.startedAt;
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      agentTranscriptPath: record.outputFile ?? record.sessionFile,
      summary: finalReportSummary(record.result),
      ...(record.usageLimit && { usageLimit: record.usageLimit }),
      ...(record.pendingDependents && { pendingDependents: record.pendingDependents }),
      ...(record.sideConversation && { sideConversation: true }),
      ...(record.workflowId && {
        workflowId: record.workflowId,
        workflowStepId: record.workflowStepId,
      }),
    };
  }

  return {
    buildEventData,
    emitLifecycle,
    sendIndividualNudge,
    groupJoin,
    cancelNudge,
    notificationGate,
    workflowNudges,
    scheduleNudge,
    QUEUE_WAIT_POLL_MS,
  };
}
