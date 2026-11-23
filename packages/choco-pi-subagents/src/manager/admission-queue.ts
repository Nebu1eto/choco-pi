/**
 * admission-queue.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeMaxConcurrent, schedulingMaxConcurrent } from "../limits.ts";
import type { ModelEntry } from "../model-resolver.ts";
import { checkModelScope } from "../model-scope.ts";
import { ResumeModelError } from "../resume-model-error.ts";
import { providerUnavailableMessage } from "../provider-health.ts";
import { beginResultGeneration } from "../result-read.ts";
import type { JournalAgentSnapshot } from "../revival-journal.ts";
import { ADMISSION_CLOSED_MESSAGE, isAdmissionOpen } from "@choco-pi/shared/stop-control";
import type { AgentRecord } from "../types.ts";
import {
  type UsageModelRegistry,
  type UsageWait,
  type QueuedFinalizer,
  occupiesPoolSlot,
  type CancellationCause,
  type ResumeOptions,
  type ManagerState,
  transition,
  publishTerminal,
  recordRoot,
  requestCancellation,
} from "./state.ts";
import { finishDeferredWorktreeThen } from "./worktree-lifecycle.ts";
import { providerBlock } from "./provider-recheck.ts";
import { getDormant } from "./revival-journal.ts";
import { startResume, canResumeDormant } from "./resume-execution.ts";
import { startRevivedContinuation } from "./suspend-revival.ts";

/** Update the max concurrent background agents limit. */
export function setMaxConcurrent(mgr: ManagerState, n: number) {
  mgr.maxConcurrent = normalizeMaxConcurrent(n);
  // Start queued agents if the new limit allows
  drainQueue(mgr);
}

export function getMaxConcurrent(mgr: ManagerState): number {
  return mgr.maxConcurrent;
}

/** Concrete scheduler bound; configured 0 remains displayable as unlimited. */
export function getSchedulingMaxConcurrent(mgr: ManagerState): number {
  return schedulingMaxConcurrent(mgr.maxConcurrent);
}

/**
 * A queued item reached its start while the root's latch is closed: settle it `stopped`
 * with cause `user_stop` instead of starting it. A post-reset continuation settles through
 * its finalizer so the parked task's promise and final notification are still owed once.
 */
export function refuseClosedStart(
  mgr: ManagerState,
  record: AgentRecord,
  finalize: QueuedFinalizer | undefined,
): void {
  record.stoppedByUser = true;
  stopQueuedRecord(mgr, record, "user_stop", "Stopped by user request.");
  record.error = ADMISSION_CLOSED_MESSAGE;
  if (finalize !== undefined) {
    finalize(true);
    return;
  }
  publishStoppedQueued(mgr, record);
}

/**
 * Terminal state for a queued record that will never start. The caller
 * publishes: a post-reset continuation through its finalizer, any other
 * record through `publishStoppedQueued`.
 */
export function stopQueuedRecord(
  mgr: ManagerState,
  record: AgentRecord,
  cause: CancellationCause,
  reason: string,
): void {
  transition(mgr, record, "stopped");
  requestCancellation(mgr, record, record.resultGeneration ?? 1, cause, reason);
  record.completedAt = Date.now();
}

/**
 * Publish a stopped queued record that has no finalizer: at once, or for a
 * verdict-role run after its verdict record. A record published at once is
 * reported settled by the stop (stop_subagent: "stopped and settled") and,
 * like any ordinary queued Agent call, gets no completion nudge; workflow
 * controllers still need it for their aggregate/UI bookkeeping. A record
 * published later was reported pending ("until the terminal completion
 * notification arrives"), so it notifies once, after publication.
 */
export function publishStoppedQueued(mgr: ManagerState, record: AgentRecord): void {
  let deferred = false;
  finishDeferredWorktreeThen(mgr, record, () => {
    publishTerminal(mgr, record);
    // Ownership ended while publication was deferred: waiters settle, the host is not touched.
    if (mgr.disposed) return;
    if (record.workflowId === undefined && !deferred) return;
    try {
      mgr.onComplete?.(record);
    } catch {
      /* ignore completion side-effect errors */
    }
  });
  // Set before an asynchronous publish runs, never before a synchronous one.
  deferred = true;
}

/** Validate and apply a caller-selected model to an idle child session. */
export async function applyResumeModel(
  mgr: ManagerState,
  record: AgentRecord,
  session: AgentSession,
  input: string,
): Promise<void> {
  const model = resolveResumeModel(mgr, record, input);
  try {
    if (mgr.runner.setSessionModel === undefined) {
      await session.setModel(model);
    } else {
      await mgr.runner.setSessionModel(session, model);
    }
  } catch (error) {
    throw new ResumeModelError(
      `Failed to switch agent to "${input}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Synchronous validation of a resume's `provider/id`: format, registry,
 * authentication, the parent's scope, and owner-scoped availability.
 */
export function resolveResumeModel(
  mgr: ManagerState,
  record: AgentRecord,
  input: string,
): Model<Api> {
  const scope = mgr.usageScopes.get(record.id);
  return validateResumeModel(mgr, input, {
    registry: scope?.modelRegistry,
    cwd: scope?.cwd,
    owner: scope?.owner,
    agentLabel: record.type,
  });
}

/** `resolveResumeModel` for a dormant agent, against the current root context. */
export function resolveDormantModel(
  mgr: ManagerState,
  snapshot: JournalAgentSnapshot,
  input: string,
  ctx: ExtensionContext | undefined,
): Model<Api> {
  return validateResumeModel(mgr, input, {
    registry: ctx?.modelRegistry,
    cwd: ctx?.cwd,
    owner: mgr.journalSink?.rootSessionId,
    agentLabel: snapshot.type,
  });
}

/**
 * Shared caller-model validation for live and dormant resumes: provider/id
 * format, registry availability, model scope (strict), provider closure.
 */
export function validateResumeModel(
  mgr: ManagerState,
  input: string,
  scope: {
    registry: UsageModelRegistry | undefined;
    cwd: string | undefined;
    owner: string | undefined;
    agentLabel: string;
  },
): Model<Api> {
  const slash = input.indexOf("/");
  if (slash <= 0 || slash === input.length - 1) {
    throw new ResumeModelError(`Invalid model "${input}": expected provider/id.`);
  }
  const provider = input.slice(0, slash);
  const modelId = input.slice(slash + 1);
  const registry = scope.registry;
  const cwd = scope.cwd;
  if (registry === undefined || cwd === undefined) {
    throw new ResumeModelError(
      `Cannot resolve model "${input}": no model registry is available for this agent.`,
    );
  }
  let model: Model<Api> | undefined;
  let available: ModelEntry[] = [];
  try {
    model = registry.find(provider, modelId);
    available = registry.getAvailable?.() ?? registry.getAll();
  } catch {
    model = undefined;
  }
  const wanted = input.toLowerCase();
  if (
    model === undefined ||
    !available.some((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === wanted)
  ) {
    throw new ResumeModelError(
      `Model not available: "${input}" (unknown to the registry or missing authentication).`,
    );
  }
  const verdict = checkModelScope({
    model,
    cwd,
    modelRegistry: registry,
    callerSupplied: true,
    agentLabel: scope.agentLabel,
    modelInput: input,
  });
  if (verdict.kind === "error") throw new ResumeModelError(verdict.message);
  const targetKey = model.provider.toLowerCase();
  const block = providerBlock(mgr, targetKey, scope.owner, model.id);
  if (block !== undefined) {
    throw new ResumeModelError(
      providerUnavailableMessage(targetKey, block.closure, model.id, block.modelOnly),
    );
  }
  return model;
}

/** A live or unsettled run owns the record; resume() refuses it silently. */
export function resumeBlockedByRun(mgr: ManagerState, id: string, record: AgentRecord): boolean {
  return (
    record.status === "running" ||
    record.status === "queued" ||
    (record.resultGeneration !== undefined &&
      record.terminalResultGeneration !== record.resultGeneration) ||
    mgr.resumeReservations.has(id)
  );
}

/** Throw the owner-scoped availability refusal for the record's current provider. */
export function assertResumeProviderOpen(
  mgr: ManagerState,
  id: string,
  session: AgentSession,
): void {
  const key = (session.model?.provider ?? "unknown").toLowerCase();
  const modelId = session.model?.id;
  const block = providerBlock(mgr, key, mgr.usageScopes.get(id)?.owner, modelId);
  if (block !== undefined) {
    throw new ResumeModelError(
      providerUnavailableMessage(key, block.closure, modelId, block.modelOnly),
    );
  }
}

/**
 * Side-effect-free pre-check for callers that prepare a resume (output file,
 * notification ids) before calling `resume()`. Returns false where `resume()`
 * would return undefined without starting (unknown, no session, live run,
 * pending model switch); throws the same `ResumeModelError` it would throw
 * for an invalid model or a closed provider. `resume()` re-checks everything.
 */
export function assertResumable(
  mgr: ManagerState,
  id: string,
  model?: string,
  options?: { dormant?: boolean; ctx?: ExtensionContext },
): boolean {
  const record = mgr.agents.get(id);
  // Opt-in: a dormant or interrupted agent resumes through `resumeDormant`,
  // which re-validates everything when it reopens the file. A caller model
  // is checked here against the current root context (`ctx`), exactly as a
  // live resume checks it, and throws the same ResumeModelError.
  if (record === undefined && options?.dormant === true) {
    if (!canResumeDormant(mgr, id)) return false;
    const snapshot = getDormant(mgr, id);
    if (model !== undefined && snapshot !== undefined) {
      resolveDormantModel(mgr, snapshot, model, options.ctx);
    }
    return true;
  }
  if (mgr.disposed || !record?.session || resumeBlockedByRun(mgr, id, record)) return false;
  if (model === undefined) assertResumeProviderOpen(mgr, id, record.session);
  else resolveResumeModel(mgr, record, model);
  return true;
}

/** Start (or queue) a detached resume generation; shared by resume() and wake-ups. */
export function queueBackgroundResume(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  prompt: string,
  signal: AbortSignal | undefined,
  options: ResumeOptions,
  hooks: {
    onRunStarted?: (promise: Promise<string>) => void;
    finalize?: QueuedFinalizer;
    repark?: () => void;
    wait?: UsageWait;
  } = {},
): void {
  record.isBackground = true;
  beginResultGeneration(record);
  // A new generation is a new request: an earlier explicit stop no longer applies.
  record.stoppedByUser = undefined;
  record.result = undefined;
  record.error = undefined;
  record.cancellation = undefined;
  record.completedAt = undefined;
  transition(mgr, record, "queued");

  const start = () => {
    // Final admission boundary before a session is created or a run restarts.
    if (!isAdmissionOpen(recordRoot(mgr, record))) {
      refuseClosedStart(mgr, record, hooks.finalize);
      return;
    }
    const before = record.promise;
    const revival = record.session === undefined ? mgr.revivalArgs.get(id) : undefined;
    if (revival === undefined) {
      startResume(mgr, id, record, prompt, signal, options);
    } else {
      // A re-armed record has no session yet: reopen its file (claimed at
      // re-arm) through the spawn path, as a wake continuation.
      startRevivedContinuation(mgr, id, record, revival, prompt, hooks.finalize);
    }
    if (record.promise !== undefined && (revival === undefined || record.promise !== before)) {
      hooks.onRunStarted?.(record.promise);
    }
  };
  if (occupiesPoolSlot(record) && mgr.runningBackground >= getSchedulingMaxConcurrent(mgr)) {
    // At the concurrency limit — queue it, drains when a slot frees.
    mgr.queue.push({
      id,
      providerKey: (
        record.session?.model?.provider ??
        record.spawnModel?.provider ??
        "unknown"
      ).toLowerCase(),
      modelId: record.session?.model?.id ?? record.spawnModel?.id,
      start,
      finalize: hooks.finalize,
      repark: hooks.repark,
      wait: hooks.wait,
    });
  } else {
    start();
  }
}

/** Start queued agents up to the concurrency limit. */
export function drainQueue(mgr: ManagerState) {
  while (mgr.queue.length > 0 && mgr.runningBackground < getSchedulingMaxConcurrent(mgr)) {
    const next = mgr.queue.shift()!;
    const record = mgr.agents.get(next.id);
    if (!record || record.status !== "queued") continue;
    const owner = mgr.usageScopes.get(next.id)?.owner;
    // Final admission boundary for queued spawns, resumes and post-reset continuations.
    if (!isAdmissionOpen(recordRoot(mgr, record))) {
      refuseClosedStart(mgr, record, next.finalize);
      continue;
    }
    const block = providerBlock(mgr, next.providerKey, owner, next.modelId);
    // A post-reset continuation whose account was closed again by a usage
    // limit waits for the new reset instead of dispatching or dropping; a
    // transient closure from another run must not hold or drop the task.
    if (block?.usage === true && next.repark !== undefined) {
      next.repark();
      continue;
    }
    if (next.finalize === undefined && block !== undefined) {
      transition(mgr, record, "error");
      record.error = providerUnavailableMessage(
        next.providerKey.toLowerCase(),
        block.closure,
        next.modelId,
        block.modelOnly,
      );
      record.completedAt = Date.now();
      finishDeferredWorktreeThen(mgr, record, () => {
        publishTerminal(mgr, record);
        if (mgr.disposed) return;
        try {
          mgr.onComplete?.(record);
        } catch {
          /* ignore completion side-effect errors */
        }
      });
      continue;
    }
    try {
      next.start();
    } catch (err) {
      // Late failure (e.g. strict worktree-isolation) — surface on the record
      // so the user/agent can see it via /agents, then keep draining.
      transition(mgr, record, "error");
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      if (next.finalize === undefined) {
        finishDeferredWorktreeThen(mgr, record, () => {
          publishTerminal(mgr, record);
          if (mgr.disposed) return;
          try {
            mgr.onComplete?.(record);
          } catch {
            /* ignore completion side-effect errors */
          }
        });
      } else next.finalize(true);
    }
  }
}
