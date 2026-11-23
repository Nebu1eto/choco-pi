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

export function setMaxConcurrent(mgr: ManagerState, n: number) {
  mgr.maxConcurrent = normalizeMaxConcurrent(n);
  drainQueue(mgr);
}

export function getMaxConcurrent(mgr: ManagerState): number {
  return mgr.maxConcurrent;
}

export function getSchedulingMaxConcurrent(mgr: ManagerState): number {
  return schedulingMaxConcurrent(mgr.maxConcurrent);
}

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

export function publishStoppedQueued(mgr: ManagerState, record: AgentRecord): void {
  let deferred = false;
  finishDeferredWorktreeThen(mgr, record, () => {
    publishTerminal(mgr, record);
    if (mgr.disposed) return;
    if (record.workflowId === undefined && !deferred) return;
    try {
      mgr.onComplete?.(record);
    } catch {}
  });
  deferred = true;
}

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

export function resumeBlockedByRun(mgr: ManagerState, id: string, record: AgentRecord): boolean {
  return (
    record.status === "running" ||
    record.status === "queued" ||
    (record.resultGeneration !== undefined &&
      record.terminalResultGeneration !== record.resultGeneration) ||
    mgr.resumeReservations.has(id)
  );
}

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

export function assertResumable(
  mgr: ManagerState,
  id: string,
  model?: string,
  options?: { dormant?: boolean; ctx?: ExtensionContext },
): boolean {
  const record = mgr.agents.get(id);
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
  record.stoppedByUser = undefined;
  record.result = undefined;
  record.error = undefined;
  record.cancellation = undefined;
  record.completedAt = undefined;
  transition(mgr, record, "queued");

  const start = () => {
    if (!isAdmissionOpen(recordRoot(mgr, record))) {
      refuseClosedStart(mgr, record, hooks.finalize);
      return;
    }
    const before = record.promise;
    const revival = record.session === undefined ? mgr.revivalArgs.get(id) : undefined;
    if (revival === undefined) {
      startResume(mgr, id, record, prompt, signal, options);
    } else {
      startRevivedContinuation(mgr, id, record, revival, prompt, hooks.finalize);
    }
    if (record.promise !== undefined && (revival === undefined || record.promise !== before)) {
      hooks.onRunStarted?.(record.promise);
    }
  };
  if (occupiesPoolSlot(record) && mgr.runningBackground >= getSchedulingMaxConcurrent(mgr)) {
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

export function drainQueue(mgr: ManagerState) {
  while (mgr.queue.length > 0 && mgr.runningBackground < getSchedulingMaxConcurrent(mgr)) {
    const next = mgr.queue.shift()!;
    const record = mgr.agents.get(next.id);
    if (!record || record.status !== "queued") continue;
    const owner = mgr.usageScopes.get(next.id)?.owner;
    if (!isAdmissionOpen(recordRoot(mgr, record))) {
      refuseClosedStart(mgr, record, next.finalize);
      continue;
    }
    const block = providerBlock(mgr, next.providerKey, owner, next.modelId);
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
        } catch {}
      });
      continue;
    }
    try {
      next.start();
    } catch (err) {
      transition(mgr, record, "error");
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      if (next.finalize === undefined) {
        finishDeferredWorktreeThen(mgr, record, () => {
          publishTerminal(mgr, record);
          if (mgr.disposed) return;
          try {
            mgr.onComplete?.(record);
          } catch {}
        });
      } else next.finalize(true);
    }
  }
}
