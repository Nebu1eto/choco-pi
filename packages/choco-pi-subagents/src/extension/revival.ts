import { ensureEnabledModels } from "../enabled-models.ts";
import { type AgentActivity, getDisplayName } from "../ui/agent-widget.ts";
import type { ExtensionContext, AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type JournalAgentSnapshot, reduceJournal } from "../revival-journal.ts";
import {
  type RevivalRunCallbacks,
  type RevivalReport,
  type RevivalContext,
  ResumeModelError,
} from "../agent-manager.ts";
import { streamToOutputFile } from "../output-file.ts";
import type { AgentRecord } from "../types.ts";
import { resolveJoinMode } from "../invocation-config.ts";
import {
  dormantResumeHint,
  TERMINAL_RESULT_RETRIEVAL_GUIDANCE,
  isDormantRunUnfinished,
  formatDormantNotRunning,
  formatDormantResultConsumed,
} from "../result-read.ts";
import { resolveSpawnType } from "../agent-types.ts";
import { formatConcurrencyCap } from "../limits.ts";
import { buildRecordDetails } from "../delegation-render.ts";
import { getStatusNote } from "../status-note.ts";
import { createActivityTracker, textResult, errorResult } from "./helpers.ts";
import type { SubagentsRuntime } from "./runtime.ts";

export function installRevival(pi: ExtensionAPI, rt: SubagentsRuntime) {
  const REVIVAL_START_DELAY_MS = 250;

  async function refreshAgentsForSession(): Promise<boolean> {
    const generation = rt.state.revivalGeneration;
    const cwd = rt.state.currentCtx?.cwd;
    await Promise.all([
      rt.reloadCustomAgents(),
      cwd === undefined ? undefined : ensureEnabledModels(cwd),
    ]);
    return generation === rt.state.revivalGeneration;
  }
  const revivalTrackers = new Map<string, AgentActivity>();

  function journalEligible(ctx: ExtensionContext): boolean {
    if (!rt.registry.ownsManagerRegistry) return false;
    if (ctx.mode === "print" || ctx.mode === "json") return false;
    let file: string | undefined;
    try {
      file = ctx.sessionManager.getSessionFile();
    } catch {
      return false;
    }
    return file !== undefined && file.length > 0;
  }

  function findTopLevelDormant(ref: string): JournalAgentSnapshot | undefined {
    const byId = rt.core.manager.getDormant(ref);
    if (byId !== undefined) return byId.parentAgentId === undefined ? byId : undefined;
    return rt.core.manager.findDormantByHandle(ref);
  }

  function revivalCallbacks(
    snapshot: JournalAgentSnapshot,
    ctx: ExtensionContext,
  ): RevivalRunCallbacks {
    const { state, callbacks } = createActivityTracker(snapshot.options.maxTurns);
    const reopened = snapshot.sessionFile !== undefined;
    const onSessionCreated = (session: AgentSession): void => {
      callbacks.onSessionCreated(session);
      const record = rt.core.manager.getRecord(snapshot.id);
      if (record?.outputFile) {
        record.outputCleanup = streamToOutputFile(
          session,
          record.outputFile,
          snapshot.id,
          ctx.cwd,
          reopened ? session.messages.length : undefined,
        );
      }
    };
    if (snapshot.parentAgentId !== undefined) return { onSessionCreated };
    revivalTrackers.set(snapshot.id, state);
    return {
      onToolActivity: callbacks.onToolActivity,
      onTextDelta: callbacks.onTextDelta,
      onTurnEnd: callbacks.onTurnEnd,
      onAssistantUsage: callbacks.onAssistantUsage,
      onSessionCreated,
    };
  }

  function onAgentRevived(record: AgentRecord): void {
    const state = revivalTrackers.get(record.id);
    revivalTrackers.delete(record.id);
    if (record.parentAgentId !== undefined) return;
    record.toolCallId = undefined;
    const joinMode = resolveJoinMode(rt.state.defaultJoinMode, true);
    if (joinMode) record.joinMode = joinMode;
    if (state !== undefined) rt.agentActivity.set(record.id, state);
    rt.views.fleet.markRunning(record.id);
    if (rt.state.currentCtx?.hasUI) {
      rt.views.fleet.ensureTimer();
      rt.views.fleet.update();
    }
    rt.notifications.emitLifecycle("subagents:created", {
      id: record.id,
      type: record.type,
      description: record.description,
      isBackground: true,
    });
  }

  function deliverRevivalReport(report: RevivalReport, ctx: ExtensionContext): void {
    const name = report.handle === undefined ? report.agentId : `@${report.handle}`;
    if (report.kind === "revived" || report.kind === "rearmed") {
      if (ctx.hasUI) ctx.ui.notify(`Subagent ${name}: ${report.message}`, "info");
      return;
    }
    const label =
      report.handle === undefined ? report.agentId : `${report.agentId} (@${report.handle})`;
    const howToContinue =
      report.parentAgentId === undefined
        ? dormantResumeHint({ id: report.agentId, handle: report.handle })
        : `It belongs to agent ${report.parentAgentId}; continue that agent instead.`;
    const content =
      `Subagent ${label} "${report.description}" was not revived after the restart ` +
      `(${report.kind}): ${report.message}\n${howToContinue}`;
    pi.sendMessage(
      { customType: "subagent-revival", content, display: true },
      { deliverAs: "steer", triggerTurn: false },
    );
  }

  function revivalContext(ctx: ExtensionContext, generation: number): RevivalContext {
    const revivalCwd = ctx.cwd;
    return {
      pi,
      ctx,
      resolveType: async (type) => {
        await Promise.all([rt.reloadCustomAgents(), ensureEnabledModels(revivalCwd)]);
        const dispatch = resolveSpawnType(type);
        if (!dispatch.ok) return { ok: false, message: dispatch.message };
        if (dispatch.fellBackFrom !== undefined) {
          return { ok: false, message: `The ${type} agent is no longer available.` };
        }
        return { ok: true, type: dispatch.type };
      },
      callbacksFor: (snapshot) => revivalCallbacks(snapshot, ctx),
      onRevived: (record) => {
        if (generation === rt.state.revivalGeneration) onAgentRevived(record);
      },
      onRevivalReport: (report) => {
        if (generation === rt.state.revivalGeneration) deliverRevivalReport(report, ctx);
      },
    };
  }

  function scheduleRevival(ctx: ExtensionContext, rootSessionId: string, generation: number) {
    if (rt.state.revivalTimer !== undefined) clearTimeout(rt.state.revivalTimer);
    rt.state.revivalTimer = setTimeout(() => {
      rt.state.revivalTimer = undefined;
      if (generation !== rt.state.revivalGeneration) return;
      const snapshots = [...reduceJournal(ctx.sessionManager.getEntries(), rootSessionId).values()];
      rt.core.manager
        .reviveFromJournal(snapshots, revivalContext(ctx, generation))
        .catch((error) => {
          if (generation !== rt.state.revivalGeneration) return;
          console.error("[choco-pi-subagents] Subagent revival failed", error);
        });
    }, REVIVAL_START_DELAY_MS);
  }

  async function resumeDormantFromTool(
    ctx: ExtensionContext,
    dormant: JournalAgentSnapshot,
    prompt: string,
    model: string | undefined,
    toolCallId: string,
    workTask: string | undefined,
  ) {
    const id = dormant.id;
    if (rt.core.manager.isRevivalPending(id)) {
      return textResult(
        `Agent "${id}" is being revived right now. ${TERMINAL_RESULT_RETRIEVAL_GUIDANCE}`,
      );
    }
    await rt.core.manager.refreshResumeProvider(id, model, ctx);
    let resumable: boolean;
    try {
      resumable = rt.core.manager.assertResumable(id, model, { dormant: true, ctx });
    } catch (error) {
      if (error instanceof ResumeModelError) {
        return textResult(`Failed to resume agent "${id}": ${error.message}`);
      }
      throw error;
    }
    if (!resumable) {
      return textResult(
        `Agent "${id}" has no saved session to resume (saved status: ${dormant.status}).`,
      );
    }
    const admission = await rt.registry.admitReviewRound(
      ctx,
      dormant.type,
      workTask,
      "agent-resume",
    );
    if (admission.kind === "refused") return textResult(admission.message);
    let record: AgentRecord;
    try {
      record = await rt.core.manager.resumeDormant(
        id,
        prompt,
        revivalContext(ctx, rt.state.revivalGeneration),
        {
          model,
          reviewTicket: rt.registry.ticketOf(admission),
        },
      );
    } catch (error) {
      if (admission.kind === "admitted") await rt.registry.reviewRounds.release(admission.ticket);
      return textResult(
        `Failed to resume agent "${id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    record.toolCallId = toolCallId;
    const isQueued = record.status === "queued";
    const address = record.alias ?? record.handle ?? record.id;
    return textResult(
      `${rt.registry.noticeOf(admission)}Agent ${isQueued ? "queued" : "resumed"} in background from its saved session (it was not running: ${dormant.status}).\n` +
        `Agent ID: ${id}\n` +
        `Alias: @${address}\n` +
        `Type: ${record.type}\n` +
        (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        (isQueued
          ? `Position: queued (cap ${formatConcurrencyCap(rt.core.manager.getMaxConcurrent())})\n`
          : "") +
        `\nYou will be notified when this agent completes.\n` +
        `${TERMINAL_RESULT_RETRIEVAL_GUIDANCE} Use steer_subagent to send it messages.`,
      buildRecordDetails(record, true, true),
    );
  }

  function readDormantResult(dormant: JournalAgentSnapshot, verbose: boolean | undefined) {
    if (isDormantRunUnfinished(dormant.status)) {
      return textResult(formatDormantNotRunning(dormant));
    }
    if (dormant.resultConsumed) return errorResult(formatDormantResultConsumed(dormant));
    rt.core.manager.markDormantResultConsumed(dormant.id);
    rt.notifications.cancelNudge(dormant.id);
    let output =
      `Agent: ${dormant.id}\n` +
      `Type: ${getDisplayName(dormant.type)} | Status: ${dormant.status}${getStatusNote(dormant.status)} | Not running (saved result)\n` +
      `Description: ${dormant.description}\n\n`;
    output +=
      dormant.status === "error"
        ? `Error: ${dormant.error ?? "unknown error"}`
        : dormant.result?.trim() || dormant.error?.trim() || "No output.";
    if (verbose && dormant.sessionFile !== undefined) {
      output += `\n\nFull conversation: ${dormant.sessionFile}`;
    }
    return textResult(output);
  }

  function stopDormantAgent(ref: string, dormant: JournalAgentSnapshot) {
    if (!isDormantRunUnfinished(dormant.status)) {
      return textResult(
        `Agent "${ref}" is not running (status: ${dormant.status}); nothing to stop.` +
          (dormant.resultConsumed ? "" : " Its result is readable once with get_subagent_result."),
      );
    }
    if (rt.core.manager.isRevivalPending(dormant.id)) {
      return errorResult(
        `Agent "${ref}" is being revived right now; call stop_subagent again in a moment.`,
      );
    }
    if (rt.core.manager.stopDormant(dormant.id) === undefined) {
      return errorResult(`Failed to stop agent ${dormant.id}.`);
    }
    return textResult(
      `Agent ${dormant.id} was not running (saved status: ${dormant.status}). ` +
        "It is now marked stopped and will not be revived. Resume it later with Agent resume if needed.",
    );
  }

  return {
    journalEligible,
    scheduleRevival,
    revivalContext,
    refreshAgentsForSession,
    revivalTrackers,
    findTopLevelDormant,
    resumeDormantFromTool,
    readDormantResult,
    stopDormantAgent,
  };
}
