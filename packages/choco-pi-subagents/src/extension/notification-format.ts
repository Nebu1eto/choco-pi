/**
 * Completion-notification formatting: the model-facing XML and the renderer details.
 */
import type { AgentRecord, NotificationDetails } from "../types.ts";
import { formatTaskNotificationStatus } from "../notification-status.ts";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.ts";
import { verdictLineMissingFrom } from "../verdict-record.ts";
import { describeUsageLimit } from "../usage-limit-seam.ts";
import { getStatusNote } from "../status-note.ts";
import { formatModelLine } from "../invocation-config.ts";
import type { AgentActivity } from "../ui/agent-widget.ts";
import { notificationVerdictReply } from "../delegation-render.ts";
import type { JournalAgentSnapshot } from "../revival-journal.ts";

/** Escape XML special characters to prevent injection in structured notifications. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
export function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = formatTaskNotificationStatus(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml =
    contextPercent === null
      ? ""
      : `<context_percent>${Math.round(contextPercent)}</context_percent>`;
  const compactXml = record.compactionCount
    ? `<compactions>${record.compactionCount}</compactions>`
    : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) +
        "\n...(truncated; after this terminal notification, retrieve the full result exactly once with get_subagent_result)"
      : record.result
    : "No output.";
  // A truncated preview can cut off the verdict-record line appended to the result; repeat it.
  const verdictRecord = verdictLineMissingFrom(record, resultPreview);

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    `<generation>${record.terminalResultGeneration ?? record.resultGeneration ?? 1}</generation>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    record.usageLimit
      ? `<usage-limit>${escapeXml(
          describeUsageLimit(record.usageLimit) +
            // The contract has no "stopped" usage status; a stopped wait reads as
            // exhausted, and the notification says why.
            (record.status === "stopped" && record.usageLimit.status === "exhausted"
              ? "; stopped before reset"
              : ""),
        )}</usage-limit>`
      : null,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    record.modelProvenance ? escapeXml(formatModelLine(record.modelProvenance)) : null,
    `<result>${escapeXml(resultPreview)}</result>`,
    verdictRecord === undefined
      ? null
      : `<verdict-record>${escapeXml(verdictRecord)}</verdict-record>`,
    record.pendingDependents
      ? `Pending dependents (terminal-boundary snapshot): ${escapeXml(record.pendingDependents.map((child) => child.handle ?? child.id).join(", "))}.`
      : null,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails(
  record: AgentRecord,
  resultMaxLen: number,
  activity?: AgentActivity,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "…"
      : record.result
    : "No output.";
  const details: NotificationDetails = {
    id: record.id,
    description: record.description,
    type: record.type,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    usageLimit: record.usageLimit,
    resultPreview,
  };
  // Display only (details never reach the model): this run's reply, for its verdict summary.
  const verdictReply = notificationVerdictReply(record.result, resultPreview);
  return verdictReply === undefined ? details : Object.assign(details, { verdictReply });
}

/**
 * Notification view of a dormant (journal-only) terminal agent, so a pending
 * completion notification saved before a restart can still be delivered.
 * Live-only fields (session, usage, timing) read as empty.
 */
export function dormantNotificationRecord(snapshot: JournalAgentSnapshot): AgentRecord {
  return {
    id: snapshot.id,
    type: snapshot.type,
    handle: snapshot.handle,
    alias: snapshot.alias,
    description: snapshot.description,
    status: snapshot.status,
    result: snapshot.result,
    error: snapshot.error,
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    resultConsumed: snapshot.resultConsumed,
    outputFile: snapshot.options.outputFile,
    sessionFile: snapshot.sessionFile,
  };
}
