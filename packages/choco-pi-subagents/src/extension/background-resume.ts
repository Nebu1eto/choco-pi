/**
 * Background resume and batch joins.
 */
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

/** Background batch joins, background resume, and hook continuations. */
export function installBackgroundResume(pi: ExtensionAPI, rt: SubagentsRuntime) {
  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    rt.state.batchFinalizeTimer = undefined;
    const batchAgents = [...rt.state.currentBatchAgents];
    rt.state.currentBatchAgents = [];

    const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++rt.state.batchCounter}`;
      const ids = smartAgents.map((a) => a.id);
      rt.notifications.groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = rt.core.manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          rt.notifications.groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = rt.core.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          rt.notifications.sendIndividualNudge(record);
        }
      }
    }
  }

  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking, join-mode
   * batching, the widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` + `run_in_background` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: {
      /** Admission ticket for a review-role agent; refunded here when no run starts. */
      reviewTicket?: ReviewTicket;
      outputTranscript: boolean;
      maxTurns?: number;
      toolCallId?: string;
      name?: string;
      /** `provider/id` to switch to before the resumed run (Agent tool only). */
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
    // Every refusal the manager can decide synchronously (live run, invalid or
    // closed model, closed provider) comes before any record or file change;
    // a closed provider throws the same ResumeModelError resume() would.
    // Anything that stops the run before the manager starts it refunds the round.
    const refund = async (): Promise<void> => {
      if (opts.reviewTicket !== undefined)
        await rt.registry.reviewRounds.release(opts.reviewTicket);
    };
    // A stored usage-limit closure is re-checked before the synchronous gate reads it.
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
    // Assigned unconditionally: the completion notification carries this as
    // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
    // id left by the spawn that created the record. Keeping it would point the
    // orchestrator's new result at a tool call that was answered runs ago.
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    // resumeAgent has no onSessionCreated — the session predates this run —
    // so seed it directly, or the widget shows no context % for the agent.
    bgState.session = existing.session;

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
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
        // Fires when the run actually starts — immediately, or on queue
        // drain. Wiring it here (rather than after resume() returns) means a
        // resume stopped while still queued never started streaming, so
        // there is no subscription left behind for a later run to trip over.
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
      // Only a refusal before the run started is refunded; other failures stay counted.
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
    // This agent already finished once, so the widget holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    rt.views.fleet.markRunning(id);
    rt.views.fleet.ensureTimer();
    rt.views.fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
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
            // Continues the round the hook's agent was admitted under.
            reviewTicket: issueExemptTicket("hook-continuation"),
            outputTranscript: getOutputTranscriptDefault(),
          });
        } catch (error) {
          // A closed provider refuses the continuation with the usage-limit details.
          if (!(error instanceof ResumeModelError)) throw error;
          ctx.ui.notify(`Could not continue agent ${id}: ${error.message}`, "warning");
        }
      })();
    },
  );

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    // SAFETY: Pi's UI context implements the FleetPanel UI surface consumed here.
    const fleetContext = ctx as FleetPanelUIContext;
    rt.views.fleet.setUICtx(fleetContext.ui);
    rt.views.fleet.onTurnStart();
  });

  return { startBackgroundResume, removeHookContinuationListener, finalizeBatch };
}
