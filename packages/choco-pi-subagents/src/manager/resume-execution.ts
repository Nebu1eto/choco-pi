/**
 * resume-execution.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import type { ReviewTicket } from "../review-rounds.ts";
import { resolveAgentMaxTurns } from "../agent-runner.ts";
import { setSessionFastMode } from "../fast-mode-bridge.ts";
import { assignHandle, handleBase } from "../mention.ts";
import { beginResultGeneration } from "../result-read.ts";
import {
  buildInterruptionPrompt,
  CAPPED_REVIVAL_ERROR,
  type JournalAgentSnapshot,
} from "../revival-journal.ts";
import { releaseSessionFile } from "../session-file-ownership.ts";
import {
  ADMISSION_CLOSED_MESSAGE,
  isAdmissionOpen,
  readStopState,
  requireAdmissionOpen,
} from "@choco-pi/shared/stop-control";
import type { AgentRecord } from "../types.ts";
import { addUsage } from "../usage.ts";
import {
  type RevivalContext,
  modelRefOf,
  withUsageLimitNote,
  canParkForReset,
  sessionRootOf,
  occupiesPoolSlot,
  isBudgetedToolActivity,
  ownsUnsettledGeneration,
  cancellationForGeneration,
  requireReviewAdmission,
  terminalStatusFor,
  type ResumeOptions,
  type ManagerState,
  transition,
  publishTerminal,
  markTerminalConsumed,
  recordRoot,
  requestCancellation,
  armRunBudgets,
  isSuspendedGeneration,
} from "./state.ts";
import { recordsVerdict, recordRunVerdict } from "./verdict-recording.ts";
import { finishDeferredWorktree } from "./worktree-lifecycle.ts";
import { resumeRecheck } from "./provider-recheck.ts";
import { getDormant } from "./revival-journal.ts";
import {
  notifyUsageLimit,
  evaluateRunUsageLimit,
  currentUsageDecision,
  parkForReset,
} from "./usage-limit-park.ts";
import {
  resolveDormantModel,
  resumeBlockedByRun,
  assertResumeProviderOpen,
  queueBackgroundResume,
  drainQueue,
} from "./admission-queue.ts";
import { dependencyCompletionGuard } from "./spawn-execution.ts";
import { abortOwnedChildren, removeRecord } from "./stop-cancellation.ts";
import {
  finishSuspendedRun,
  settleSuspendedResume,
  prepareRevival,
  startPreparedRevival,
} from "./suspend-revival.ts";
import { takenHandles, setDaybreak } from "./tree-status.ts";

/**
 * Resume an existing agent session with a new prompt.
 */
export async function resume(
  mgr: ManagerState,
  id: string,
  prompt: string,
  signal?: AbortSignal,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined> {
  // Re-check a stored usage-limit closure before the synchronous gates below
  // read it; nothing about the record is captured or changed before this.
  // Without a closure this stays synchronous, as concurrent resumes rely on.
  const recheck = resumeRecheck(mgr, id, options?.model, undefined);
  if (recheck !== undefined) await recheck;
  const record = mgr.agents.get(id);
  if (!record?.session) return undefined;
  requireAdmissionOpen(recordRoot(mgr, record));
  const verdictTask = requireReviewAdmission(record.type, options?.reviewTicket);

  // A live run cannot be resumed safely in either mode: it owns the record's
  // abort controller and session prompt. Refuse before changing its alias or
  // any run state so a failed attempt leaves every address intact.
  // Another resume may also hold this record across its asynchronous model
  // switch. Refuse before any side effect: the host applies a model after
  // async authentication with no running check, so two switches must never
  // overlap.
  if (resumeBlockedByRun(mgr, id, record)) return undefined;

  // Model switch first, before any alias or run state changes, so a refused
  // or failed switch leaves the record exactly as it was.
  // A model equal to the session's current one is no switch at all: skip the
  // re-authentication and scope round trip instead of re-applying it.
  const currentModel = record.session.model;
  const sameModel =
    currentModel !== undefined && options?.model === `${currentModel.provider}/${currentModel.id}`;
  if (options?.model !== undefined && !sameModel) {
    const session = record.session;
    const generation = record.resultGeneration;
    // Reserved synchronously, before the first await; released only after the
    // switch settles, and everything from there to the new generation's
    // running/queued state is synchronous.
    mgr.resumeReservations.add(id);
    try {
      await mgr.invokeApplyResumeModel(record, session, options.model);
    } finally {
      mgr.resumeReservations.delete(id);
    }
    if (
      mgr.disposed ||
      mgr.agents.get(id) !== record ||
      record.session !== session ||
      record.resultGeneration !== generation ||
      ownsUnsettledGeneration(record)
    ) {
      return undefined;
    }
    // A /stop during the model switch must not let the resume run.
    requireAdmissionOpen(recordRoot(mgr, record));
    // The completion notification and journal read this provenance; refresh
    // it to what the session now runs. The host may clamp thinking on switch.
    if (record.modelProvenance !== undefined) {
      const switched = session.model;
      record.modelProvenance = {
        ...record.modelProvenance,
        model: switched ? `${switched.provider}/${switched.id}` : options.model,
        source: "caller",
        thinking: session.thinkingLevel ?? record.modelProvenance.thinking,
      };
    }
  }
  // Same owner-scoped availability gate as spawn, for every resumed dispatch
  // (with or without a model, foreground or background). Synchronous and
  // before any state change; with a model it re-checks the switched target.
  assertResumeProviderOpen(mgr, id, record.session);
  // Final admission boundary: everything from here to the new generation is synchronous.
  const resumeRoot = recordRoot(mgr, record);
  requireAdmissionOpen(resumeRoot);
  if (resumeRoot !== undefined) record.admissionEpoch = readStopState(resumeRoot).epoch;
  // A caller-initiated resume starts a new task outcome; the previous
  // chain's usage-limit block no longer describes it.
  record.usageLimit = undefined;
  mgr.wakeRuns.delete(id);

  if (options?.name !== undefined) {
    const previousAlias = record.alias;
    const nextAlias = assignHandle(
      handleBase(options.name),
      takenHandles(mgr, record.parentAgentId, record),
    );
    const ownTombstone = record.handle ? mgr.tombstones.get(record.handle) : undefined;
    if (
      ownTombstone?.id === record.id &&
      ownTombstone.handle === record.handle &&
      ownTombstone.alias === previousAlias
    ) {
      ownTombstone.alias = nextAlias;
    }
    record.alias = nextAlias;
  }
  if (options?.fastModeRequested !== undefined) {
    record.fastModeRequested = options.fastModeRequested;
    record.fastModeSource = "explicit";
    record.fastModeRevision = (record.fastModeRevision ?? 0) + 1;
    const state = setSessionFastMode(
      record.session.sessionManager?.getSessionId?.(),
      options.fastModeRequested,
    );
    if (state) record.fastModeRevision = state.revision;
  }

  if (options?.daybreakRequested !== undefined) {
    setDaybreak(mgr, id, options.daybreakRequested);
  }
  // An exempt continuation keeps the work task the agent was admitted under.
  if (verdictTask !== undefined) record.verdictTask = verdictTask;

  // Background resume: settle asynchronously and notify on completion exactly
  // like a background spawn, returning immediately with the record still
  // "running" — or "queued" when at the concurrency limit. Previously
  // run_in_background was ignored on resume (the Agent tool's resume branch
  // returned before its background branch, and resume() only ever awaited
  // inline), so a resumed agent always blocked the caller until it finished.
  if (options?.isBackground) {
    queueBackgroundResume(mgr, id, record, prompt, signal, options);
    return record;
  }

  // Foreground resume: run inline and return the settled record.
  const runGeneration = beginResultGeneration(record);
  // A new generation is a new request: an earlier explicit stop no longer applies.
  record.stoppedByUser = undefined;
  transition(mgr, record, "running");
  record.startedAt = Date.now();
  record.completedAt = undefined;
  record.result = undefined;
  record.error = undefined;
  record.cancellation = undefined;
  const abortController = new AbortController();
  record.abortController = abortController;
  const onParentAbort = () =>
    requestCancellation(
      mgr,
      record,
      runGeneration,
      "parent_signal",
      "Parent run was cancelled.",
      abortController,
    );
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener("abort", onParentAbort, { once: true });
  const runBudget = armRunBudgets(mgr, record, runGeneration, options?.budgets, abortController);
  const session = record.session;
  const resumeProviderKey = (session.model?.provider ?? "unknown").toLowerCase();

  const resumePromise = (async (): Promise<AgentRecord> => {
    try {
      const { text, failure, aborted, steered } = await mgr.runner.resumeAgent(session, prompt, {
        onFinishAttempt: dependencyCompletionGuard(mgr, record, runGeneration),
        maxTurns: resolveAgentMaxTurns(record.type, options?.maxTurns),
        onToolActivity: (activity) => {
          if (isBudgetedToolActivity(activity)) {
            runBudget.controller?.noteToolActivity(activity.type);
          }
          if (activity.type === "end") record.toolUses++;
          options?.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          runBudget.controller?.noteUsage(usage);
          addUsage(record.lifetimeUsage, usage);
          options?.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          mgr.onCompact?.(record, info);
          options?.onCompaction?.(info);
        },
        signal: abortController.signal,
      });
      if (isSuspendedGeneration(mgr, record, runGeneration)) {
        finishSuspendedRun(mgr, record, undefined);
        return record;
      }
      // A limit under auto-resume parks exactly like a foreground spawn: the
      // caller gets the paused record now and the outcome as a notification.
      const evaluated = await evaluateRunUsageLimit(
        mgr,
        record,
        runGeneration,
        runBudget,
        failure,
        resumeProviderKey,
        modelRefOf(session.model),
        session,
        canParkForReset(record),
        "reported",
      );
      const usageDecision = currentUsageDecision(mgr, record, runGeneration, runBudget, evaluated);
      if (record.resultGeneration !== runGeneration) return record;
      // A suspend during the evaluation settles without an outcome.
      if (isSuspendedGeneration(mgr, record, runGeneration)) {
        finishSuspendedRun(mgr, record, undefined);
        return record;
      }
      if (mgr.disposed) {
        abortOwnedChildren(mgr, id);
        removeRecord(mgr, id, record);
        return record;
      }
      if (usageDecision?.park === true) {
        record.result = text;
        record.error = failure;
        abortOwnedChildren(mgr, id);
        // The caller's streaming callbacks belong to a call that returns now.
        parkForReset(mgr, record, runGeneration, usageDecision, resumeProviderKey, {
          budgets: options?.budgets,
        });
        return record;
      }
      // Verdict record: the status and error mirror what is published below.
      const settling = cancellationForGeneration(record, runGeneration);
      const verdictLine = recordsVerdict(mgr, record)
        ? await recordRunVerdict(
            mgr,
            record,
            runGeneration,
            text,
            runBudget.forcedStatus ??
              (settling ? "stopped" : terminalStatusFor({ aborted, failure, steered })),
            runBudget.forcedReason ?? settling?.reason ?? failure,
          )
        : undefined;
      if (record.resultGeneration !== runGeneration) return record;
      if (isSuspendedGeneration(mgr, record, runGeneration)) {
        finishSuspendedRun(mgr, record, undefined);
        return record;
      }
      if (mgr.disposed) {
        abortOwnedChildren(mgr, id);
        removeRecord(mgr, id, record);
        return record;
      }
      // Same contract as the spawn path (#144): a failed final turn is an
      // error, not a completion — but the resumed text stays available.
      const cancellation = cancellationForGeneration(record, runGeneration);
      if (runBudget.forcedStatus !== undefined) transition(mgr, record, runBudget.forcedStatus);
      else if (cancellation) transition(mgr, record, "stopped");
      else transition(mgr, record, terminalStatusFor({ aborted, failure, steered }));
      if (cancellation) {
        record.error = cancellation.reason;
      }
      if (runBudget.forcedReason !== undefined) record.error = runBudget.forcedReason;
      else if (failure) {
        record.error =
          usageDecision === undefined
            ? failure
            : withUsageLimitNote(failure, usageDecision.usageLimit);
      }
      if (usageDecision !== undefined) record.usageLimit = usageDecision.usageLimit;
      record.result = verdictLine === undefined ? text : `${text}\n\n${verdictLine}`;
      record.completedAt = Date.now();
      markTerminalConsumed(mgr, record);
      if (usageDecision !== undefined) notifyUsageLimit(mgr, record);
    } catch (err) {
      if (record.resultGeneration !== runGeneration) return record;
      if (isSuspendedGeneration(mgr, record, runGeneration)) {
        finishSuspendedRun(mgr, record, undefined);
        return record;
      }
      if (mgr.disposed) {
        abortOwnedChildren(mgr, id);
        removeRecord(mgr, id, record);
        return record;
      }
      const caught = cancellationForGeneration(record, runGeneration);
      const verdictLine = recordsVerdict(mgr, record)
        ? await recordRunVerdict(
            mgr,
            record,
            runGeneration,
            undefined,
            runBudget.forcedStatus ?? (caught ? "stopped" : "error"),
            runBudget.forcedReason ??
              caught?.reason ??
              (err instanceof Error ? err.message : String(err)),
          )
        : undefined;
      if (record.resultGeneration !== runGeneration) return record;
      if (isSuspendedGeneration(mgr, record, runGeneration)) {
        finishSuspendedRun(mgr, record, undefined);
        return record;
      }
      if (mgr.disposed) {
        abortOwnedChildren(mgr, id);
        removeRecord(mgr, id, record);
        return record;
      }
      const cancellation = cancellationForGeneration(record, runGeneration);
      transition(mgr, record, runBudget.forcedStatus ?? (cancellation ? "stopped" : "error"));
      record.error =
        runBudget.forcedReason ??
        cancellation?.reason ??
        (err instanceof Error ? err.message : String(err));
      if (verdictLine !== undefined) {
        record.result =
          record.result === undefined ? verdictLine : `${record.result}\n\n${verdictLine}`;
      }
      record.completedAt = Date.now();
      markTerminalConsumed(mgr, record);
    } finally {
      runBudget.controller?.dispose();
      signal?.removeEventListener("abort", onParentAbort);
    }

    // Same contract as the spawn settle paths: children spawned during the
    // resumed turn must not outlive it — nothing else can see or reach them.
    abortOwnedChildren(mgr, id);

    return record;
  })();
  record.promise = resumePromise.then((settledRecord) => settledRecord.result ?? "");
  return resumePromise;
}

/**
 * Start a background resume run: detached, settling and notifying like
 * startAgent's background path. Invoked immediately, or from drainQueue when
 * a concurrency slot frees. The session already exists (resume reuses it), so
 * there is no onSessionCreated to hang per-run wiring off — callers use
 * `options.onStarted`, which fires on both the immediate and the drained path.
 */
export function startResume(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  prompt: string,
  parentSignal: AbortSignal | undefined,
  options: ResumeOptions,
) {
  if (!record.session) return;

  transition(mgr, record, "running");
  record.startedAt = Date.now();
  const runGeneration = record.resultGeneration ?? 1;
  const resumeProviderKey = (record.session.model?.provider ?? "unknown").toLowerCase();
  const runTookPoolSlot = occupiesPoolSlot(record);
  let runPoolSlotHeld = runTookPoolSlot;
  if (runTookPoolSlot) mgr.runningBackground++;
  mgr.onStart?.(record);

  // Fresh abort controller so /agents stop and steering target THIS run rather
  // than the previous one's settled controller.
  const abortController = new AbortController();
  record.abortController = abortController;
  // Optional, and NOT what the Agent tool passes for a detached resume: a
  // parent signal aborts on the parent's own interrupt (user Esc), which is
  // right for a foreground run whose result the caller is awaiting, and wrong
  // for a detached one — background spawns omit it for exactly this reason.
  let detachParentSignal: (() => void) | undefined;
  if (parentSignal) {
    const onParentAbort = () => {
      if (
        requestCancellation(
          mgr,
          record,
          runGeneration,
          "parent_signal",
          "Parent run was cancelled.",
        )
      ) {
        transition(mgr, record, "stopped");
        record.completedAt ??= Date.now();
      }
    };
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
  }
  const detach = () => {
    detachParentSignal?.();
    detachParentSignal = undefined;
  };
  const releaseRunPoolSlot = () => {
    if (!runPoolSlotHeld) return;
    runPoolSlotHeld = false;
    mgr.runningBackground--;
  };
  let staleRunSettled = false;
  let currentRunSettled = false;
  const settleStaleRun = () => {
    if (staleRunSettled) return;
    staleRunSettled = true;
    runBudget.controller?.dispose();
    detach();
    abortOwnedChildren(mgr, id);
    releaseRunPoolSlot();
    drainQueue(mgr);
  };
  const runBudget = armRunBudgets(mgr, record, runGeneration, options.budgets, abortController);

  // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
  // After the record is in its running shape, before the run is kicked off.
  try {
    options.onStarted?.();
  } catch {
    /* ignore caller wiring errors */
  }

  const settle = () => {
    if (mgr.wakeRuns.get(id) === runGeneration) mgr.wakeRuns.delete(id);
    runBudget.controller?.dispose();
    detach();
    // Final flush of streaming output file
    if (record.outputCleanup) {
      try {
        record.outputCleanup();
      } catch {
        /* ignore */
      }
      record.outputCleanup = undefined;
    }
    // Children spawned during the resumed turn must not outlive it.
    abortOwnedChildren(mgr, id);
    releaseRunPoolSlot();
    currentRunSettled = true;
    if (mgr.disposed) {
      removeRecord(mgr, id, record);
      return;
    }
    try {
      mgr.onComplete?.(record);
    } catch {
      /* ignore completion side-effect errors */
    }
    drainQueue(mgr);
  };

  const promise = mgr.runner
    .resumeAgent(record.session, prompt, {
      onFinishAttempt: dependencyCompletionGuard(mgr, record, runGeneration),
      maxTurns: resolveAgentMaxTurns(record.type, options.maxTurns),
      onToolActivity: (activity) => {
        if (isBudgetedToolActivity(activity)) {
          runBudget.controller?.noteToolActivity(activity.type);
        }
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        runBudget.controller?.noteUsage(usage);
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        mgr.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
    })
    .then(async ({ text, failure, aborted, steered }) => {
      try {
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedResume(mgr, id, runGeneration, runBudget, detach, () => {
            releaseRunPoolSlot();
            currentRunSettled = true;
          });
          return text;
        }
        runBudget.controller?.dispose();
        // A post-reset continuation that hits the limit again is exhausted;
        // any other resumed run may park like a fresh spawn.
        const isWakeRun = mgr.wakeRuns.get(id) === runGeneration;
        const evaluated = await evaluateRunUsageLimit(
          mgr,
          record,
          runGeneration,
          runBudget,
          failure,
          resumeProviderKey,
          modelRefOf(record.session?.model),
          record.session,
          !isWakeRun && canParkForReset(record),
          isWakeRun ? "exhausted" : "reported",
        );
        const usageDecision = currentUsageDecision(
          mgr,
          record,
          runGeneration,
          runBudget,
          evaluated,
        );
        if (record.resultGeneration !== runGeneration) return text;
        // A suspend during the evaluation settles without an outcome.
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedResume(mgr, id, runGeneration, runBudget, detach, () => {
            releaseRunPoolSlot();
            currentRunSettled = true;
          });
          return text;
        }
        if (mgr.disposed) {
          settle();
          return text;
        }
        if (usageDecision?.park === true) {
          detach();
          record.result = text;
          record.error = failure;
          abortOwnedChildren(mgr, id);
          releaseRunPoolSlot();
          currentRunSettled = true;
          parkForReset(mgr, record, runGeneration, usageDecision, resumeProviderKey, {
            budgets: options.budgets,
            onToolActivity: options.onToolActivity,
            onAssistantUsage: options.onAssistantUsage,
            onCompaction: options.onCompaction,
          });
          drainQueue(mgr);
          return text;
        }
        // Don't overwrite status if externally stopped via abort().
        if (record.status !== "stopped") {
          const forcedStatus = runBudget.forcedStatus;
          if (forcedStatus === undefined) {
            // Same contract as the spawn path (#144): a failed final turn is an
            // error, not a completion — but the resumed text stays available.
            transition(mgr, record, terminalStatusFor({ aborted, failure, steered }));
            if (failure) {
              record.error =
                usageDecision === undefined
                  ? failure
                  : withUsageLimitNote(failure, usageDecision.usageLimit);
            }
          } else {
            transition(mgr, record, forcedStatus);
            record.error = runBudget.forcedReason;
          }
        }
        if (usageDecision !== undefined) record.usageLimit = usageDecision.usageLimit;
        if (record.cancellation?.generation === runGeneration && record.error === undefined) {
          record.error = record.cancellation.reason;
        }
        record.result = text;
        record.completedAt ??= Date.now();
        await finishDeferredWorktree(mgr, record);
        if (record.resultGeneration !== runGeneration) return text;
        const verdictLine = recordsVerdict(mgr, record)
          ? await recordRunVerdict(mgr, record, runGeneration, text, record.status, record.error)
          : undefined;
        if (record.resultGeneration !== runGeneration) return text;
        if (verdictLine !== undefined) {
          record.result = `${record.result ?? ""}\n\n${verdictLine}`;
        }
        publishTerminal(mgr, record);
        if (usageDecision !== undefined) notifyUsageLimit(mgr, record);
        settle();
        return text;
      } finally {
        if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
      }
    })
    .catch(async (err) => {
      try {
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedResume(mgr, id, runGeneration, runBudget, detach, () => {
            releaseRunPoolSlot();
            currentRunSettled = true;
          });
          return "";
        }
        runBudget.controller?.dispose();
        if (record.resultGeneration !== runGeneration) return "";
        if (mgr.disposed) {
          settle();
          return "";
        }
        if (record.status !== "stopped") {
          transition(mgr, record, runBudget.forcedStatus ?? "error");
          record.error =
            runBudget.forcedReason ?? (err instanceof Error ? err.message : String(err));
        }
        if (record.cancellation?.generation === runGeneration && record.error === undefined) {
          record.error = record.cancellation.reason;
        }
        record.completedAt ??= Date.now();
        await finishDeferredWorktree(mgr, record);
        if (record.resultGeneration !== runGeneration) return "";
        const verdictLine = recordsVerdict(mgr, record)
          ? await recordRunVerdict(
              mgr,
              record,
              runGeneration,
              undefined,
              record.status,
              record.error,
            )
          : undefined;
        if (record.resultGeneration !== runGeneration) return "";
        if (verdictLine !== undefined) {
          record.result =
            record.result === undefined ? verdictLine : `${record.result}\n\n${verdictLine}`;
        }
        publishTerminal(mgr, record);
        settle();
        return "";
      } finally {
        if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
      }
    });

  record.promise = promise;
}

/**
 * Whether `id` is a dormant (evicted or never-revived) agent whose saved
 * session `resumeDormant` could reopen. Side-effect free.
 */
export function canResumeDormant(mgr: ManagerState, id: string): boolean {
  if (mgr.disposed || mgr.agents.has(id) || mgr.revivalReservations.has(id)) return false;
  return getDormant(mgr, id)?.sessionFile !== undefined;
}

/**
 * Continue a dormant or interrupted agent from its saved session file under
 * the same id, in the background, with the user's prompt (prefixed by the
 * interruption notice when it was interrupted). Throws with the reason when
 * it cannot: unknown id, live, no file, validation failure, or the file
 * still owned elsewhere. Nothing is journaled on failure.
 */
export async function resumeDormant(
  mgr: ManagerState,
  id: string,
  prompt: string,
  context: RevivalContext,
  options?: { model?: string; reviewTicket?: ReviewTicket },
): Promise<AgentRecord> {
  // Re-check a stored usage-limit closure before the synchronous checks below read it.
  const recheck = resumeRecheck(mgr, id, options?.model, context.ctx);
  if (recheck !== undefined) await recheck;
  if (mgr.disposed) throw new Error("The subagent manager is shut down.");
  if (mgr.agents.has(id) || mgr.revivalReservations.has(id)) {
    throw new Error(`Agent ${id} is live; resume it directly.`);
  }
  const saved = getDormant(mgr, id);
  if (saved === undefined) throw new Error(`No saved agent ${id} in this session.`);
  const dormantRoot = mgr.journalSink?.rootSessionId ?? sessionRootOf(context.ctx);
  requireAdmissionOpen(dormantRoot);
  const verdictTask = requireReviewAdmission(saved.type, options?.reviewTicket);
  // A caller-selected model is validated like a live resume's (format,
  // availability, scope, provider closure; throws ResumeModelError) and
  // replaces the journaled one, so the revived run and its journal use it.
  const switched =
    options?.model === undefined
      ? undefined
      : resolveDormantModel(mgr, saved, options.model, context.ctx);
  const snapshot: JournalAgentSnapshot =
    switched === undefined
      ? saved
      : { ...saved, model: { provider: switched.provider, id: switched.id } };
  const sink = mgr.journalSink;
  const epoch = mgr.revivalEpoch;
  const isCurrent = () => !mgr.disposed && mgr.revivalEpoch === epoch && mgr.journalSink === sink;
  mgr.revivalReservations.add(id);
  try {
    const outcome = await prepareRevival(mgr, snapshot, "resume", undefined, 0, context, isCurrent);
    if (outcome.kind === "stale")
      throw new Error("Resume cancelled: the session changed or shut down.");
    if (outcome.kind === "failed") throw new Error(outcome.reason);
    const item = outcome.prepared;
    if (mgr.agents.has(id)) {
      if (item.claim !== undefined) releaseSessionFile(item.claim.file, item.claim.token);
      throw new Error(`Agent ${id} became live while resuming.`);
    }
    // A /stop during preparation must not start the revived run.
    if (!isAdmissionOpen(dormantRoot)) {
      if (item.claim !== undefined) releaseSessionFile(item.claim.file, item.claim.token);
      throw new Error(ADMISSION_CLOSED_MESSAGE);
    }
    const fullPrompt =
      snapshot.status === "interrupted" || snapshot.error === CAPPED_REVIVAL_ERROR
        ? `${buildInterruptionPrompt({ unclean: undefined, steers: item.steers })}\n\n${prompt}`
        : prompt;
    try {
      const revived = startPreparedRevival(mgr, item, context, fullPrompt);
      // Synchronous after the start: the run cannot have settled yet.
      if (verdictTask !== undefined) revived.verdictTask = verdictTask;
      return revived;
    } catch (err) {
      if (item.claim !== undefined) releaseSessionFile(item.claim.file, item.claim.token);
      throw err;
    }
  } finally {
    mgr.revivalReservations.delete(id);
  }
}
