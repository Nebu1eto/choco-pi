import { stat } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelEntry } from "../model-resolver.ts";
import { checkModelScope } from "../model-scope.ts";
import { providerUnavailableMessage } from "../provider-health.ts";
import {
  buildInterruptionPrompt,
  buildJournalData,
  CAPPED_REVIVAL_ERROR,
  isJournalAgentSnapshot,
  startupDisposition,
  usageClassificationOf,
  type InterruptedChildRun,
  type JournalAgentSnapshot,
} from "../revival-journal.ts";
import {
  claimSessionFile,
  releaseSessionFile,
  waitForSessionFileRelease,
} from "../session-file-ownership.ts";
import { probeWorktree } from "../worktree-probe.ts";
import type { AgentRecord, SubagentType } from "../types.ts";
import {
  REARM_RESET_GRACE_MS,
  SUSPEND_SETTLE_TIMEOUT_MS,
  SESSION_FILE_RELEASE_TIMEOUT_MS,
  SUSPEND_REASON,
  USAGE_LIMIT_RESUME_PROMPT,
  type UsageWait,
  type RevivalReportKind,
  type RevivalReport,
  type RevivalTypeResolution,
  type RevivalContext,
  type RevivalSnapshot,
  type SuspendSummary,
  type QueuedFinalizer,
  type SuspendPlan,
  type SuspendPlanResult,
  type SpawnArgs,
  type RunBudgetState,
  type SpawnOptions,
  type AdoptedWorktree,
  type RevivalIdentity,
  type SessionClaim,
  type PreparedRevival,
  type PrepareOutcome,
  type ManagerState,
  transition,
  publishTerminal,
  ownerToken,
} from "./state.ts";
import {
  applyAdoptedWorktree,
  finishDeferredWorktreeThen,
  cleanupRecordWorktree,
} from "./worktree-lifecycle.ts";
import { accountFor, providerBlock } from "./provider-recheck.ts";
import {
  setRevivals,
  hydrateDormant,
  flushJournal,
  journalSinkFor,
  noteJournalFailure,
  writeSuspendedJournal,
  putDormant,
} from "./revival-journal.ts";
import { armUsageWake, armWakeTimer } from "./usage-limit-park.ts";
import { drainQueue } from "./admission-queue.ts";
import { spawnWith } from "./spawn-execution.ts";
import { removeRecord, abortAll } from "./stop-cancellation.ts";

export function finishSuspendedRun(
  mgr: ManagerState,
  record: AgentRecord,
  session: AgentSession | undefined,
): void {
  if (session !== undefined) record.session = session;
  if (record.outputCleanup) {
    try {
      record.outputCleanup();
    } catch {}
    record.outputCleanup = undefined;
  }
  if (mgr.agents.get(record.id) === record) {
    removeRecord(mgr, record.id, record, { suspended: true });
  }
  if (!mgr.disposed) drainQueue(mgr);
}

export function settleSuspendedResume(
  mgr: ManagerState,
  id: string,
  generation: number,
  runBudget: RunBudgetState,
  detach: () => void,
  releaseSlot: () => void,
): void {
  if (mgr.wakeRuns.get(id) === generation) mgr.wakeRuns.delete(id);
  runBudget.controller?.dispose();
  detach();
  releaseSlot();
  const record = mgr.agents.get(id);
  if (record !== undefined) finishSuspendedRun(mgr, record, undefined);
}

export function suspendNow(mgr: ManagerState): SuspendPlanResult {
  mgr.revivalEpoch++;
  flushJournal(mgr);
  const plans: SuspendPlan[] = [];
  for (const record of mgr.agents.values()) {
    if (journalSinkFor(mgr, record) === undefined) continue;
    const generation = record.resultGeneration ?? 1;
    if (record.cancellation?.generation === generation) continue;
    if (record.status === "waiting_for_reset") {
      plans.push({ record, status: "waiting_for_reset", wait: mgr.usageWaits.get(record.id) });
    } else if (record.status === "queued") {
      const queueEntry = mgr.queue.find((entry) => entry.id === record.id);
      if (queueEntry?.wait === undefined) {
        plans.push({ record, status: "interrupted", queueEntry });
      } else {
        plans.push({ record, status: "waiting_for_reset", wait: queueEntry.wait, queueEntry });
      }
    } else if (record.status === "running") {
      plans.push({ record, status: "interrupted" });
    }
  }
  for (const plan of plans) writeSuspendedJournal(mgr, plan.record, plan.status, plan.wait);

  const running: AgentRecord[] = [];
  for (const plan of plans) {
    const record = plan.record;
    const generation = record.resultGeneration ?? 1;
    record.cancellation = {
      generation,
      cause: "suspend",
      reason: SUSPEND_REASON,
      requestedAt: Date.now(),
    };
    transition(mgr, record, "interrupted");
    mgr.deferredWorktrees.delete(record.id);
    if (plan.queueEntry !== undefined) {
      const entry = plan.queueEntry;
      mgr.queue = mgr.queue.filter((queued) => queued !== entry);
    }
    const wait = plan.wait ?? mgr.usageWaits.get(record.id);
    if (wait !== undefined) {
      if (wait.timer !== undefined) clearTimeout(wait.timer);
      wait.timer = undefined;
      mgr.usageWaits.delete(record.id);
    }
    const hasRun = plan.status === "interrupted" && plan.queueEntry === undefined;
    if (hasRun) {
      record.pendingSteers = undefined;
      record.abortController?.abort();
      running.push(record);
    } else {
      if (mgr.wakeRuns.get(record.id) === generation) mgr.wakeRuns.delete(record.id);
      wait?.release(record.result ?? "");
      removeRecord(mgr, record.id, record, { suspended: true });
    }
  }
  return { suspended: plans.map((plan) => plan.record), running };
}

export async function suspendAll(mgr: ManagerState): Promise<SuspendSummary> {
  const { suspended, running } = suspendNow(mgr);
  const aborted = abortAll(mgr);
  const settled = new Set<string>();
  const pending = running.map((record) =>
    Promise.resolve(record.promise)
      .catch(() => undefined)
      .then(() => {
        settled.add(record.id);
      }),
  );
  if (pending.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUSPEND_SETTLE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.all(pending), bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return {
    suspended: suspended.map((record) => record.id),
    unsettled: running.filter((record) => !settled.has(record.id)).map((record) => record.id),
    aborted,
  };
}

export function journalRevivalFailure(
  mgr: ManagerState,
  snapshot: JournalAgentSnapshot,
  reason: string,
): void {
  const sink = mgr.journalSink;
  const failed: JournalAgentSnapshot = {
    ...snapshot,
    status: "error",
    error: reason,
    usageWait: undefined,
    steers: undefined,
  };
  if (sink !== undefined) {
    try {
      sink.append(
        buildJournalData({ rootSessionId: sink.rootSessionId, suspended: false, agent: failed }),
      );
    } catch (err) {
      noteJournalFailure(
        mgr,
        sink,
        snapshot.id,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
  putDormant(mgr, failed);
}

export async function fileExists(mgr: ManagerState, path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function directoryExists(mgr: ManagerState, path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function prepareRevival(
  mgr: ManagerState,
  snapshot: JournalAgentSnapshot,
  mode: PreparedRevival["mode"],
  clean: boolean | undefined,
  revivals: number,
  context: RevivalContext,
  isCurrent: () => boolean,
): Promise<PrepareOutcome> {
  const permanent = (reason: string): PrepareOutcome => ({
    kind: "failed",
    reason,
    journal: true,
  });
  if (snapshot.options.workflowId !== undefined || snapshot.options.sideConversation === true) {
    return permanent("Workflow steps and /btw answers are not revivable.");
  }
  let type: SubagentType = snapshot.type;
  if (context.resolveType !== undefined) {
    let resolved: RevivalTypeResolution;
    try {
      resolved = await context.resolveType(snapshot.type);
    } catch (err) {
      if (!isCurrent()) return { kind: "stale" };
      return permanent(err instanceof Error ? err.message : String(err));
    }
    if (!isCurrent()) return { kind: "stale" };
    if (!resolved.ok) return permanent(resolved.message);
    type = resolved.type;
  }
  let model: Model<Api> | undefined;
  const ctx = context.ctx;
  if (snapshot.model !== undefined) {
    const key = `${snapshot.model.provider}/${snapshot.model.id}`;
    let available: ModelEntry[] = [];
    try {
      model = ctx.modelRegistry.find(snapshot.model.provider, snapshot.model.id);
      available = ctx.modelRegistry.getAvailable();
    } catch {
      model = undefined;
    }
    const wanted = key.toLowerCase();
    if (
      model === undefined ||
      !available.some((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === wanted)
    ) {
      return permanent(
        `Model not available: "${key}" (unknown to the registry or missing authentication).`,
      );
    }
    const verdict = checkModelScope({
      model,
      cwd: ctx.cwd,
      modelRegistry: ctx.modelRegistry,
      callerSupplied: true,
      agentLabel: snapshot.type,
      modelInput: key,
    });
    if (verdict.kind === "error") return permanent(verdict.message);
  }
  if (mode !== "rearm") {
    const target = model ?? ctx.model;
    const providerKey = (target?.provider ?? "unknown").toLowerCase();
    const block = providerBlock(mgr, providerKey, mgr.journalSink?.rootSessionId, target?.id);
    if (block !== undefined) {
      return permanent(
        providerUnavailableMessage(providerKey, block.closure, target?.id, block.modelOnly),
      );
    }
  }
  const steers = [...(snapshot.steers ?? []), ...(snapshot.usageWait?.steers ?? [])];
  if (
    snapshot.inMemorySession === true &&
    snapshot.sessionFile === undefined &&
    snapshot.status !== "queued"
  ) {
    return permanent(
      "Not revivable: its session was kept in memory (persist_session: false), so there is nothing to continue from.",
    );
  }

  let adopt: AdoptedWorktree | undefined;
  const worktree = snapshot.worktree;
  if (worktree !== undefined) {
    if (worktree.hookManaged === true) {
      const present = await directoryExists(mgr, worktree.path);
      if (!isCurrent()) return { kind: "stale" };
      if (!present) {
        return permanent(
          `Isolated worktree ${worktree.path} (branch "${worktree.branch}") no longer exists.`,
        );
      }
    } else {
      const probe = await probeWorktree(worktree);
      if (!isCurrent()) return { kind: "stale" };
      if (!probe.present) return permanent(probe.message);
    }
    adopt = { ...worktree };
  }

  const file = snapshot.sessionFile;
  let freshPrompt: string | undefined;
  let claim: SessionClaim | undefined;
  if (file !== undefined && (await fileExists(mgr, file))) {
    if (!isCurrent()) return { kind: "stale" };
    const outcome = await waitForSessionFileRelease(file, {
      timeoutMs: SESSION_FILE_RELEASE_TIMEOUT_MS,
    });
    if (!isCurrent()) return { kind: "stale" };
    const token = ownerToken(mgr, snapshot.id, 1);
    if (outcome !== "released" || !claimSessionFile(file, token)) {
      return {
        kind: "failed",
        reason: `Session file ${file} is still in use by another owner; it was not reopened.`,
        journal: false,
      };
    }
    claim = { file, token };
  } else {
    if (!isCurrent()) return { kind: "stale" };
    if (mode === "rearm" || mode === "resume") {
      return permanent(
        file === undefined
          ? "No saved session file to continue from."
          : `Session file ${file} is missing.`,
      );
    }
    if (snapshot.prompt === undefined) {
      return permanent(
        file === undefined
          ? "No saved session file or original prompt to continue from."
          : `Session file ${file} is missing and the original prompt was not kept.`,
      );
    }
    freshPrompt = snapshot.prompt;
  }
  return {
    kind: "ok",
    prepared: { snapshot, mode, clean, revivals, type, model, adopt, claim, freshPrompt, steers },
  };
}

export function revivalSpawnOptions(
  mgr: ManagerState,
  prepared: PreparedRevival,
  context: RevivalContext,
): SpawnOptions {
  const snapshot = prepared.snapshot;
  const saved = snapshot.options;
  const callbacks = context.callbacksFor?.(snapshot) ?? {};
  return {
    description: snapshot.description,
    model: prepared.model,
    maxTurns: saved.maxTurns,
    budgets: saved.budgets,
    thinkingLevel: saved.thinkingLevel,
    isolated: saved.isolated,
    inheritContext: prepared.claim === undefined ? saved.inheritContext : false,
    isolation: saved.isolation,
    cwd: saved.cwd,
    configCwd: saved.configCwd,
    isBackground: true,
    readOnly: saved.readOnly,
    maxSubagentDepth: saved.maxSubagentDepth,
    fastModeRequested: saved.fastModeRequested,
    daybreakRequested: saved.daybreakRequested,
    invocation:
      saved.invocation === undefined ? undefined : { ...saved.invocation, runInBackground: true },
    depth: snapshot.depth,
    parentAgentId: snapshot.parentAgentId,
    rootSessionId: mgr.journalSink?.rootSessionId,
    resumeSessionFile: prepared.claim?.file,
    adoptWorktree: prepared.adopt,
    onToolActivity: callbacks.onToolActivity,
    onTextDelta: callbacks.onTextDelta,
    onSessionCreated: callbacks.onSessionCreated,
    onTurnEnd: callbacks.onTurnEnd,
    onAssistantUsage: callbacks.onAssistantUsage,
    onCompaction: callbacks.onCompaction,
  };
}

export function startPreparedRevival(
  mgr: ManagerState,
  prepared: PreparedRevival,
  context: RevivalContext,
  prompt: string,
): AgentRecord {
  const snapshot = prepared.snapshot;
  const options = revivalSpawnOptions(mgr, prepared, context);
  const identity: RevivalIdentity = {
    id: snapshot.id,
    handle: snapshot.handle,
    alias: snapshot.alias,
    revivals: prepared.revivals,
    steers: prepared.claim === undefined ? prepared.steers : undefined,
    scoped: snapshot.options.scopedModels ?? [],
    outputFile: snapshot.options.outputFile,
    claim: prepared.claim,
    rearm:
      prepared.mode === "rearm" && prepared.claim !== undefined
        ? { snapshot, sessionFile: prepared.claim.file }
        : undefined,
  };
  const id = spawnWith(mgr, context.pi, context.ctx, prepared.type, prompt, options, identity);
  const record = mgr.agents.get(id);
  if (record === undefined) throw new Error(`Revived agent ${id} disappeared while starting.`);
  setRevivals(mgr, id, prepared.revivals);
  try {
    context.onRevived?.(record);
  } catch {}
  return record;
}

export function armRevivedWait(
  mgr: ManagerState,
  record: AgentRecord,
  args: SpawnArgs,
  snapshot: JournalAgentSnapshot,
  sessionFile: string,
): void {
  const saved = snapshot.usageWait;
  if (saved === undefined) throw new Error(`Agent ${record.id} has no journaled usage wait.`);
  const owner = mgr.journalSink?.rootSessionId ?? mgr.usageScopes.get(record.id)?.owner ?? "";
  const classification = usageClassificationOf(saved.classification);
  const providerKey = saved.providerKey.toLowerCase();
  const accountId = accountFor(mgr, owner, providerKey);
  const accountIds =
    classification.accountId === undefined || classification.accountId === accountId
      ? [accountId]
      : [accountId, classification.accountId];
  let release: (value: string | PromiseLike<string>) => void = () => undefined;
  const parkedPromise = new Promise<string>((resolve) => {
    release = resolve;
  });
  record.sessionFile = sessionFile;
  mgr.sessionFileConfirmed.add(record.id);
  record.spawnPrompt = undefined;
  record.pendingSteers = undefined;
  record.isBackground = true;
  record.promise = parkedPromise;
  const resetAt = saved.resetAt ?? classification.resetAt;
  record.usageLimit = {
    provider: classification.provider,
    accountId: classification.accountId ?? accountId,
    kind: classification.kind,
    resetAt,
    status: "waiting_for_reset",
    ...(classification.scope !== undefined && { scope: classification.scope }),
  };
  const wait: UsageWait = {
    generation: record.resultGeneration ?? 1,
    owner,
    providerKey,
    accountIds,
    classification,
    resumeOptions: {
      budgets: args.options.budgets,
      onToolActivity: args.options.onToolActivity,
      onAssistantUsage: args.options.onAssistantUsage,
      onCompaction: args.options.onCompaction,
    },
    continuation: [...saved.steers],
    parkedPromise,
    release,
    revived: true,
  };
  mgr.usageWaits.set(record.id, wait);
  mgr.revivalArgs.set(record.id, args);
  const adopt = args.options.adoptWorktree;
  if (adopt !== undefined) {
    applyAdoptedWorktree(mgr, record, adopt);
    const customCwd = args.options.cwd ?? undefined;
    mgr.deferredWorktrees.set(record.id, () =>
      cleanupRecordWorktree(mgr, args.pi, record, adopt.repo, customCwd, record.description),
    );
  }
  transition(mgr, record, "waiting_for_reset");
  if (resetAt !== undefined && resetAt > Date.now()) {
    armUsageWake(mgr, record, wait, resetAt);
  } else {
    armWakeTimer(mgr, record, wait, REARM_RESET_GRACE_MS);
  }
}

export function startRevivedContinuation(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  args: SpawnArgs,
  prompt: string,
  finalize: QueuedFinalizer | undefined,
): void {
  record.abortController = new AbortController();
  const deferredCleanup = mgr.deferredWorktrees.get(id);
  mgr.deferredWorktrees.delete(id);
  try {
    mgr.invokeStartAgent(id, record, {
      ...args,
      prompt,
      options: {
        ...args.options,
        resumeSessionFile: record.sessionFile,
        inheritContext: false,
      },
    });
    mgr.revivalArgs.delete(id);
  } catch (err) {
    if (deferredCleanup !== undefined) mgr.deferredWorktrees.set(id, deferredCleanup);
    transition(mgr, record, "error");
    record.error = err instanceof Error ? err.message : String(err);
    record.completedAt = Date.now();
    if (finalize === undefined) {
      finishDeferredWorktreeThen(mgr, record, () => {
        publishTerminal(mgr, record);
        if (mgr.disposed) return;
        try {
          mgr.onComplete?.(record);
        } catch {}
      });
    } else finalize(true);
  }
}

export async function reviveFromJournal(
  mgr: ManagerState,
  snapshots: Iterable<RevivalSnapshot>,
  context: RevivalContext,
): Promise<RevivalReport[]> {
  const reports: RevivalReport[] = [];
  const report = (
    kind: RevivalReportKind,
    snapshot: JournalAgentSnapshot,
    message: string,
  ): void => {
    const entry: RevivalReport = {
      kind,
      agentId: snapshot.id,
      handle: snapshot.handle,
      description: snapshot.description,
      parentAgentId: snapshot.parentAgentId,
      message,
    };
    reports.push(entry);
    try {
      context.onRevivalReport?.(entry);
    } catch {}
  };
  const sink = mgr.journalSink;
  const inputs = [...snapshots].filter((input) => isJournalAgentSnapshot(input.agent));
  if (sink === undefined || mgr.disposed) {
    for (const input of inputs) {
      if (startupDisposition(input).kind !== "dormant") {
        report("skipped", input.agent, "No journal is active for this session; not revived.");
      }
    }
    return reports;
  }
  const epoch = mgr.revivalEpoch;
  const isCurrent = () => !mgr.disposed && mgr.revivalEpoch === epoch && mgr.journalSink === sink;

  interface Candidate {
    snapshot: JournalAgentSnapshot;
    mode: "revive" | "rearm";
    clean: boolean | undefined;
    revivals: number;
  }
  const dormant: JournalAgentSnapshot[] = [];
  const candidates: Candidate[] = [];
  for (const input of inputs) {
    const snapshot = input.agent;
    if (mgr.agents.has(snapshot.id) || mgr.revivalReservations.has(snapshot.id)) continue;
    const disposition = startupDisposition(input);
    if (disposition.kind === "dormant") {
      dormant.push(snapshot);
    } else if (disposition.kind === "capped") {
      journalRevivalFailure(mgr, snapshot, CAPPED_REVIVAL_ERROR);
      report(
        "capped",
        snapshot,
        `Not revived: its run ended unexpectedly ${disposition.revivals + 1} times in a row. Resume it explicitly to continue.`,
      );
    } else if (disposition.kind === "revive") {
      candidates.push({
        snapshot,
        mode: "revive",
        clean: disposition.clean,
        revivals: disposition.revivals,
      });
    } else {
      candidates.push({ snapshot, mode: "rearm", clean: true, revivals: snapshot.revivals });
    }
  }
  hydrateDormant(mgr, dormant);
  for (const candidate of candidates) mgr.revivalReservations.add(candidate.snapshot.id);

  const prepared = new Map<string, PreparedRevival>();
  const releasePrepared = (item: PreparedRevival): void => {
    if (item.claim !== undefined && mgr.sessionClaims.get(item.snapshot.id) !== item.claim) {
      releaseSessionFile(item.claim.file, item.claim.token);
    }
  };
  try {
    const depths = [...new Set(candidates.map((c) => c.snapshot.depth))].sort((a, b) => a - b);
    for (const depth of depths) {
      const level = candidates.filter((candidate) => candidate.snapshot.depth === depth);
      const outcomes = await Promise.all(
        level.map(async (candidate): Promise<[Candidate, PrepareOutcome]> => {
          const parentId = candidate.snapshot.parentAgentId;
          if (parentId !== undefined && !prepared.has(parentId) && !mgr.agents.has(parentId)) {
            return [
              candidate,
              {
                kind: "failed",
                reason: `Not revived: its parent agent ${parentId} is not being revived.`,
                journal: false,
              },
            ];
          }
          const outcome = await prepareRevival(
            mgr,
            candidate.snapshot,
            candidate.mode,
            candidate.clean,
            candidate.revivals,
            context,
            isCurrent,
          );
          return [candidate, outcome];
        }),
      );
      for (const [candidate, outcome] of outcomes) {
        const snapshot = candidate.snapshot;
        if (outcome.kind === "ok") {
          prepared.set(snapshot.id, outcome.prepared);
        } else if (outcome.kind === "stale") {
          putDormant(mgr, snapshot);
        } else if (outcome.journal) {
          journalRevivalFailure(mgr, snapshot, outcome.reason);
          report("failed", snapshot, outcome.reason);
        } else {
          putDormant(mgr, snapshot);
          const parentSkip =
            snapshot.parentAgentId !== undefined &&
            !prepared.has(snapshot.parentAgentId) &&
            !mgr.agents.has(snapshot.parentAgentId) &&
            outcome.reason.startsWith("Not revived: its parent");
          report(parentSkip ? "skipped" : "failed", snapshot, outcome.reason);
        }
      }
    }

    if (!isCurrent()) {
      for (const item of prepared.values()) {
        releasePrepared(item);
        putDormant(mgr, item.snapshot);
        report("skipped", item.snapshot, "Revival cancelled: the session changed or shut down.");
      }
      return reports;
    }

    const ordered = [...prepared.values()].sort((a, b) => a.snapshot.depth - b.snapshot.depth);
    for (const item of ordered) {
      const snapshot = item.snapshot;
      const parentId = snapshot.parentAgentId;
      if (parentId !== undefined && !mgr.agents.has(parentId)) {
        releasePrepared(item);
        putDormant(mgr, snapshot);
        report("skipped", snapshot, `Not revived: its parent agent ${parentId} did not start.`);
        continue;
      }
      const children: InterruptedChildRun[] = ordered
        .filter((other) => other.snapshot.parentAgentId === snapshot.id)
        .map((other) => ({
          id: other.snapshot.id,
          handle: other.snapshot.handle,
          description: other.snapshot.description,
        }));
      const prompt =
        item.mode === "rearm"
          ? USAGE_LIMIT_RESUME_PROMPT
          : item.claim === undefined
            ? (item.freshPrompt ?? "")
            : buildInterruptionPrompt({
                unclean: item.clean === undefined ? undefined : !item.clean,
                steers: item.steers,
                children,
              });
      try {
        startPreparedRevival(mgr, item, context, prompt);
      } catch (err) {
        releasePrepared(item);
        const reason = err instanceof Error ? err.message : String(err);
        journalRevivalFailure(mgr, snapshot, reason);
        report("failed", snapshot, reason);
        continue;
      }
      if (item.mode === "rearm") {
        report(
          "rearmed",
          snapshot,
          "Waiting for the provider usage window to reset again; it continues automatically.",
        );
      } else {
        const how =
          item.claim === undefined
            ? "restarts from its original prompt"
            : `continues from its saved session${item.clean === false ? ` (unclean exit, revival ${item.revivals} of 2)` : ""}`;
        report("revived", snapshot, `Revived: ${how}.`);
      }
    }
    return reports;
  } finally {
    for (const candidate of candidates) mgr.revivalReservations.delete(candidate.snapshot.id);
  }
}
