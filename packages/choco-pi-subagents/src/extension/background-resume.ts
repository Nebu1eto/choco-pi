import type { AgentRecord } from "../types.ts";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ReviewTicket, issueExemptTicket } from "../review-rounds.ts";
import { resolveJoinMode } from "../invocation-config.ts";
import {
  createOutputFilePath,
  ensureOutputFile,
  streamToOutputFile,
  getOutputTranscriptDefault,
} from "../output-file.ts";
import { ResumeModelError } from "../agent-manager.ts";
import { createActivityTracker, type FleetPanelUIContext } from "./helpers.ts";
import type { SubagentsRuntime } from "./runtime.ts";

export function installBackgroundResume(pi: ExtensionAPI, rt: SubagentsRuntime) {
  function finalizeBatch() {
    rt.state.batchFinalizeTimer = undefined;
    const batchAgents = [...rt.state.currentBatchAgents];
    rt.state.currentBatchAgents = [];

    const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++rt.state.batchCounter}`;
      const ids = smartAgents.map((a) => a.id);
      rt.notifications.groupJoin.registerGroup(groupId, ids);
      for (const id of ids) {
        const record = rt.core.manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          rt.notifications.groupJoin.onAgentComplete(record);
        }
      }
    } else {
      for (const { id } of batchAgents) {
        const record = rt.core.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          rt.notifications.sendIndividualNudge(record);
        }
      }
    }
  }

  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: {
      reviewTicket?: ReviewTicket;
      outputTranscript: boolean;
      maxTurns?: number;
      toolCallId?: string;
      name?: string;
      model?: string;
      fastModeRequested?: boolean;
      daybreakRequested?: boolean;
      budgets?: {
        timeoutMs?: number;
        maxToolCalls?: number;
        maxTokens?: number;
        idleTimeoutMs?: number;
      };
    },
  ): Promise<AgentRecord | undefined> {
    const id = existing.id;
    const refund = async (): Promise<void> => {
      if (opts.reviewTicket !== undefined)
        await rt.registry.reviewRounds.release(opts.reviewTicket);
    };
    await rt.core.manager.refreshResumeProvider(id, opts.model);
    let resumable: boolean;
    try {
      resumable = rt.core.manager.assertResumable(id, opts.model);
    } catch (error) {
      await refund();
      throw error;
    }
    if (!resumable) {
      await refund();
      return undefined;
    }
    const joinMode = resolveJoinMode(rt.state.defaultJoinMode, true);
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    bgState.session = existing.session;

    let record: AgentRecord | undefined;
    try {
      record = await rt.core.manager.resume(id, prompt, undefined, {
        reviewTicket: opts.reviewTicket,
        isBackground: true,
        name: opts.name,
        maxTurns: opts.maxTurns,
        model: opts.model,
        fastModeRequested: opts.fastModeRequested,
        daybreakRequested: opts.daybreakRequested,
        budgets: opts.budgets,
        onToolActivity: bgCallbacks.onToolActivity,
        onAssistantUsage: bgCallbacks.onAssistantUsage,
        onStarted: () => {
          const rec = rt.core.manager.getRecord(id);
          if (rec?.session && rec.outputFile) {
            rec.outputCleanup = streamToOutputFile(
              rec.session,
              rec.outputFile,
              id,
              ctx.cwd,
              transcriptAnchor,
            );
          }
        },
      });
    } catch (error) {
      if (error instanceof ResumeModelError) await refund();
      throw error;
    }
    if (!record) {
      await refund();
      return undefined;
    }

    if (joinMode != null && joinMode !== "async") {
      rt.state.currentBatchAgents.push({ id, joinMode });
      if (rt.state.batchFinalizeTimer) clearTimeout(rt.state.batchFinalizeTimer);
      rt.state.batchFinalizeTimer = setTimeout(finalizeBatch, 100);
    }

    rt.agentActivity.set(id, bgState);
    rt.views.fleet.markRunning(id);
    rt.views.fleet.ensureTimer();
    rt.views.fleet.update();

    rt.notifications.emitLifecycle("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  }

  const removeHookContinuationListener = pi.events.on(
    "choco-pi-hooks:subagent-continue",
    (payload) => {
      if (!(payload instanceof Object) || Array.isArray(payload)) return;
      // SAFETY: The private event-bus producer validates these two string members before emission.
      const request = payload as { id?: unknown; reason?: unknown };
      if (
        Object.prototype.toString.call(request.id) !== "[object String]" ||
        Object.prototype.toString.call(request.reason) !== "[object String]"
      )
        return;
      const id = String(request.id);
      const reason = String(request.reason);
      const ctx = rt.state.currentCtx;
      const existing = rt.core.manager.getRecord(id);
      if (
        !ctx ||
        !existing?.session ||
        existing.status === "running" ||
        existing.status === "queued"
      )
        return;
      void (async () => {
        try {
          await startBackgroundResume(ctx, existing, reason, {
            reviewTicket: issueExemptTicket("hook-continuation"),
            outputTranscript: getOutputTranscriptDefault(),
          });
        } catch (error) {
          if (!(error instanceof ResumeModelError)) throw error;
          ctx.ui.notify(`Could not continue agent ${id}: ${error.message}`, "warning");
        }
      })();
    },
  );

  pi.on("tool_execution_start", async (_event, ctx) => {
    // SAFETY: Pi's UI context implements the FleetPanel UI surface consumed here.
    const fleetContext = ctx as FleetPanelUIContext;
    rt.views.fleet.setUICtx(fleetContext.ui);
    rt.views.fleet.onTurnStart();
  });

  return { startBackgroundResume, removeHookContinuationListener, finalizeBatch };
}
