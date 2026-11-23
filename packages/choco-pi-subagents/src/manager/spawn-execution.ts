import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshotFastMode } from "../fast-mode-bridge.ts";
import { snapshotDaybreak } from "../daybreak-bridge.ts";
import { assignHandle, handleBase } from "../mention.ts";
import {
  classifyTerminalFailure,
  recordFailure,
  recordSuccess,
  retryAfterMsFromFailure,
} from "../provider-health.ts";
import { getSessionCostBaseline } from "../usage.ts";
import { readStopState, requireAdmissionOpen } from "@choco-pi/shared/stop-control";
import type { AgentRecord, SubagentType } from "../types.ts";
import { addUsage } from "../usage.ts";
import {
  adoptHookWorktree,
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  type WorktreeCleanupResult,
} from "../worktree.ts";
import {
  modelRefOf,
  withUsageLimitNote,
  canParkForReset,
  lastSuccessfulRequestStart,
  retainedWorktreeNotice,
  removeHookWorktree,
  assertAbsoluteSpawnCwd,
  assertSpawnCwdDirectory,
  occupiesPoolSlot,
  isBudgetedToolActivity,
  bootstrapEstimateOf,
  type SpawnArgs,
  providerKeyFor,
  modelIdFor,
  cancellationForGeneration,
  requireReviewAdmission,
  type SpawnOptions,
  type RevivalIdentity,
  terminalStatusFor,
  journalRunOptionsOf,
  type ResumeOptions,
  type ManagerState,
  transition,
  publishTerminal,
  markTerminalConsumed,
  recordRoot,
  requestCancellation,
  armRunBudgets,
  claimRecordSessionFile,
  isSuspendedGeneration,
  ownsPreparedRun,
} from "./state.ts";
import { recordsVerdict, recordRunVerdict } from "./verdict-recording.ts";
import {
  applyAdoptedWorktree,
  cleanupRecordWorktree,
  worktreeDispositionFor,
} from "./worktree-lifecycle.ts";
import {
  isProviderAvailable,
  unavailableError,
  reopenAfterSuccess,
  captureUsageScope,
} from "./provider-recheck.ts";
import {
  scheduleJournal,
  flushJournal,
  confirmSessionFile,
  forgetJournalState,
} from "./revival-journal.ts";
import {
  notifyUsageLimit,
  evaluateRunUsageLimit,
  currentUsageDecision,
  parkForReset,
} from "./usage-limit-park.ts";
import { getSchedulingMaxConcurrent, drainQueue } from "./admission-queue.ts";
import { abortOwnedChildren, removeRecord } from "./stop-cancellation.ts";
import { finishSuspendedRun, armRevivedWait } from "./suspend-revival.ts";
import { takenHandles } from "./tree-status.ts";

export function spawn(
  mgr: ManagerState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: SpawnOptions,
): string {
  return spawnWith(mgr, pi, ctx, type, prompt, options, undefined);
}

export function nameTakenByLive(mgr: ManagerState, name: string, id: string): boolean {
  for (const record of mgr.agents.values()) {
    if (record.id === id) continue;
    if (record.handle === name || record.alias === name) return true;
  }
  return false;
}

export function spawnWith(
  mgr: ManagerState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: SpawnOptions,
  identity: RevivalIdentity | undefined,
): string {
  assertAbsoluteSpawnCwd(options.cwd);
  const providerKey = providerKeyFor(options, ctx);
  const usageScope = captureUsageScope(mgr, ctx, options);
  if (identity?.scoped !== undefined) usageScope.scoped = [...identity.scoped];
  const modelId = modelIdFor(options, ctx);
  if (
    identity?.rearm === undefined &&
    !isProviderAvailable(mgr, providerKey, usageScope.owner, modelId)
  ) {
    throw unavailableError(mgr, providerKey, usageScope.owner, modelId);
  }
  if (identity !== undefined && mgr.agents.has(identity.id)) {
    throw new Error(`Agent ${identity.id} is already live.`);
  }
  requireAdmissionOpen(usageScope.owner);
  const verdictTask =
    identity === undefined ? requireReviewAdmission(type, options.reviewTicket) : undefined;

  const id = identity?.id ?? randomUUID().slice(0, 17);
  const revivedHandle =
    identity?.handle !== undefined && !nameTakenByLive(mgr, identity.handle, id)
      ? identity.handle
      : undefined;
  const inheritedFastMode = snapshotFastMode(ctx.sessionManager?.getSessionId?.());
  const fastModeRequested = options.fastModeRequested ?? inheritedFastMode.requested;
  const inheritedDaybreak = snapshotDaybreak(ctx.sessionManager?.getSessionId?.());
  const daybreakRequested = options.daybreakRequested ?? inheritedDaybreak.requested;
  const abortController = new AbortController();
  const record: AgentRecord = {
    id,
    type,
    handle:
      revivedHandle ??
      (options.parentAgentId === undefined && options.reclaim?.handle
        ? options.reclaim.handle
        : assignHandle(handleBase(type), takenHandles(mgr, options.parentAgentId))),
    description: options.description,
    alias:
      identity === undefined
        ? options.parentAgentId === undefined
          ? options.reclaim?.alias
          : undefined
        : identity.alias !== undefined && !nameTakenByLive(mgr, identity.alias, id)
          ? identity.alias
          : undefined,
    status: options.isBackground ? "queued" : "running",
    toolUses: 0,
    startedAt: Date.now(),
    abortController,
    resultGeneration: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    isBackground: options.isBackground,
    invocation: options.invocation,
    modelProvenance: options.modelProvenance,
    sideConversation: options.sideConversation,
    transcriptStartAt: options.mainSessionFork?.capturedAt,
    workflowId: options.workflowId,
    workflowStepId: options.workflowStepId,
    depth: options.depth ?? 1,
    parentAgentId: options.parentAgentId,
    maxSubagentDepth: options.maxSubagentDepth,
    rootSessionId: options.rootSessionId,
    admissionRoot: usageScope.owner,
    admissionEpoch:
      usageScope.owner === undefined ? undefined : readStopState(usageScope.owner).epoch,
    fastModeRequested,
    fastModeSource: options.fastModeRequested === undefined ? "inherited" : "explicit",
    fastModeRevision: 0,
    daybreakRequested,
    daybreakSource: options.daybreakRequested === undefined ? "inherited" : "explicit",
    daybreakRevision: 0,
    spawnPrompt: prompt,
    runOptions: journalRunOptionsOf(options, usageScope.scoped),
    spawnModel: modelRefOf(options.model ?? ctx.model),
    spawnCwd: options.cwd ?? ctx.cwd,
    revivals: identity?.revivals,
    pendingSteers:
      identity?.steers !== undefined && identity.steers.length > 0
        ? [...identity.steers]
        : undefined,
    outputFile: identity?.outputFile,
    verdictTask,
  };
  const reclaimedTombstone =
    identity === undefined && options.parentAgentId === undefined && options.reclaim !== undefined
      ? mgr.tombstones.get(options.reclaim.handle)
      : undefined;
  let previousTombstoneId: string | undefined;
  mgr.agents.set(id, record);
  mgr.usageScopes.set(id, usageScope);
  if (identity !== undefined) {
    mgr.dormant.delete(id);
    if (options.adoptWorktree !== undefined) {
      applyAdoptedWorktree(mgr, record, options.adoptWorktree);
    }
    if (identity.claim !== undefined) {
      mgr.sessionClaims.set(id, identity.claim);
      record.sessionFile = identity.claim.file;
      mgr.sessionFileConfirmed.add(id);
      record.spawnPrompt = undefined;
    }
  }
  if (
    options.workflowId !== undefined ||
    options.sideConversation === true ||
    options.mainSessionFork !== undefined ||
    (options.parentAgentId !== undefined && mgr.unjournaled.has(options.parentAgentId))
  ) {
    mgr.unjournaled.add(id);
  }
  scheduleJournal(mgr, record);
  if (identity !== undefined && identity.rearm === undefined) {
    flushJournal(mgr);
  }
  if (
    reclaimedTombstone !== undefined &&
    reclaimedTombstone.handle === record.handle &&
    reclaimedTombstone.alias === record.alias
  ) {
    previousTombstoneId = reclaimedTombstone.id;
    reclaimedTombstone.id = id;
  }
  if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
    record.alias = assignHandle(handleBase(options.name), takenHandles(mgr, options.parentAgentId));
  }

  const args: SpawnArgs = { pi, ctx, type, prompt, options };

  if (identity?.rearm !== undefined) {
    armRevivedWait(mgr, record, args, identity.rearm.snapshot, identity.rearm.sessionFile);
    return id;
  }

  if (
    occupiesPoolSlot(record) &&
    !options.bypassQueue &&
    mgr.runningBackground >= getSchedulingMaxConcurrent(mgr)
  ) {
    mgr.queue.push({
      id,
      providerKey,
      modelId,
      start: () => mgr.invokeStartAgent(id, record, args),
    });
    return id;
  }

  try {
    mgr.invokeStartAgent(id, record, args);
  } catch (err) {
    const alias = record.alias;
    mgr.agents.delete(id);
    mgr.usageScopes.delete(id);
    forgetJournalState(mgr, id);
    mgr.sessionClaims.delete(id);
    if (
      previousTombstoneId !== undefined &&
      reclaimedTombstone !== undefined &&
      reclaimedTombstone.id === id
    ) {
      reclaimedTombstone.id = previousTombstoneId;
    }
    options.onStartFailed?.({
      id,
      alias,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return id;
}

export function startAgent(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  { pi, ctx, type, prompt, options }: SpawnArgs,
) {
  assertAbsoluteSpawnCwd(options.cwd);
  const providerKey = providerKeyFor(options, ctx);
  const owner = mgr.usageScopes.get(id)?.owner;
  const startModelId = modelIdFor(options, ctx);
  if (!isProviderAvailable(mgr, providerKey, owner, startModelId)) {
    throw unavailableError(mgr, providerKey, owner, startModelId);
  }
  const runModel = modelRefOf(options.model ?? ctx.model);
  const wakeResumeOptions: ResumeOptions = options.isBackground
    ? {
        budgets: options.budgets,
        onToolActivity: options.onToolActivity,
        onAssistantUsage: options.onAssistantUsage,
        onCompaction: options.onCompaction,
      }
    : { budgets: options.budgets };
  const customCwd = options.cwd ?? undefined;
  const baseCwd = options.adoptWorktree?.repo ?? customCwd ?? ctx.cwd;

  let worktreeCwd: string | undefined;
  const createsWorktree =
    options.adoptWorktree === undefined &&
    options.isolation === "worktree" &&
    isWorktreeIsolationEnabled();
  if (options.adoptWorktree !== undefined) {
    const adopt = options.adoptWorktree;
    const workPath = applyAdoptedWorktree(mgr, record, adopt);
    worktreeCwd = customCwd === undefined ? adopt.path : workPath;
  }
  const prepareRun = async (): Promise<void> => {
    if (customCwd !== undefined) await assertSpawnCwdDirectory(customCwd);
    requireAdmissionOpen(recordRoot(mgr, record));
    if (createsWorktree) {
      const hookWorktreePath = options.hookWorktreePath;
      const wt = hookWorktreePath
        ? await adoptHookWorktree(baseCwd, hookWorktreePath, id)
        : await createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
            "Initialize git and commit at least once, or omit `isolation`.",
        );
      }
      if (!ownsPreparedRun(mgr, record, runGeneration)) {
        if (wt.hookManaged === true) {
          await removeHookWorktree(pi, wt.path).catch(() => undefined);
        } else {
          await cleanupWorktree(baseCwd, wt, options.description);
        }
        throw new Error(record.cancellation?.reason ?? "Run ended before it started.");
      }
      record.worktree = wt;
      record.worktreeRepo = baseCwd;
      worktreeCwd = customCwd === undefined ? wt.path : wt.workPath;
      mgr.worktreeRepos.add(baseCwd);
    }
    if (!ownsPreparedRun(mgr, record, runGeneration)) {
      throw new Error(record.cancellation?.reason ?? "Run ended before it started.");
    }
    requireAdmissionOpen(recordRoot(mgr, record));
  };
  const needsPrepare = customCwd !== undefined || createsWorktree;

  transition(mgr, record, "running");
  record.startedAt = Date.now();
  const runGeneration = record.resultGeneration ?? 1;
  const isWakeRun = mgr.wakeRuns.get(id) === runGeneration;
  const runTookPoolSlot = occupiesPoolSlot(record);
  let runPoolSlotHeld = runTookPoolSlot;
  if (runTookPoolSlot) mgr.runningBackground++;
  mgr.onStart?.(record);

  let detachParentSignal: (() => void) | undefined;
  if (options.signal) {
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
    if (options.signal.aborted) onParentAbort();
    else options.signal.addEventListener("abort", onParentAbort, { once: true });
    detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
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
  const settleSuspendedRun = (session: AgentSession | undefined) => {
    runBudget.controller?.dispose();
    detach();
    releaseRunPoolSlot();
    currentRunSettled = true;
    finishSuspendedRun(mgr, record, session);
  };
  const settleStaleRun = () => {
    if (staleRunSettled) return;
    staleRunSettled = true;
    runBudget.controller?.dispose();
    detach();
    abortOwnedChildren(mgr, id);
    releaseRunPoolSlot();
    drainQueue(mgr);
  };
  const runBudget = armRunBudgets(
    mgr,
    record,
    runGeneration,
    options.budgets,
    record.abortController!,
  );

  const fastModeInitialization = {
    requested: record.fastModeRequested ?? false,
    source: record.fastModeSource ?? "default",
    revision: record.fastModeRevision ?? 0,
  };
  record.fastModeInitialization = fastModeInitialization;
  const daybreakInitialization = {
    requested: record.daybreakRequested ?? false,
    source: record.daybreakSource ?? "default",
    revision: record.daybreakRevision ?? 0,
  };
  record.daybreakInitialization = daybreakInitialization;
  const startRun = () =>
    mgr.runner.runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      mainSessionFork: options.mainSessionFork,
      readOnly: options.readOnly,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      cwd: worktreeCwd ?? customCwd,
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd === undefined ? undefined : ctx.cwd),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        confirmSessionFile(mgr, record, runGeneration);
        if (isBudgetedToolActivity(activity)) {
          runBudget.controller?.noteToolActivity(activity.type);
        }
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        confirmSessionFile(mgr, record, runGeneration);
        options.onTurnEnd?.(turnCount);
      },
      onFinishAttempt: dependencyCompletionGuard(mgr, record, runGeneration),
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        confirmSessionFile(mgr, record, runGeneration);
        runBudget.controller?.noteUsage(usage);
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        mgr.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: mgr.manager,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      fastMode: fastModeInitialization,
      fastModeGeneration: runGeneration,
      daybreak: daybreakInitialization,
      daybreakGeneration: runGeneration,
      onSessionCreated: (session) => {
        if (record.resultGeneration !== runGeneration) return;
        record.session = session;
        if (record.modelProvenance !== undefined) {
          const created = session.model;
          const model = created ? `${created.provider}/${created.id}` : undefined;
          const thinking = session.thinkingLevel;
          const current = record.modelProvenance;
          if (
            (model !== undefined && model !== current.model) ||
            (thinking !== undefined && thinking !== current.thinking)
          ) {
            record.modelProvenance = {
              ...current,
              model: model ?? current.model,
              thinking: thinking ?? current.thinking,
            };
          }
        }
        if (options.budgets?.maxTokens !== undefined && options.resumeSessionFile === undefined) {
          runBudget.controller?.checkBootstrap(bootstrapEstimateOf(session));
        }
        if (options.mainSessionFork) {
          record.sessionCostBaseline = getSessionCostBaseline(session) ?? undefined;
        }
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        if (record.sessionFile === undefined) {
          if (options.mainSessionFork === undefined) record.inMemorySession = true;
        } else {
          record.inMemorySession = undefined;
          claimRecordSessionFile(mgr, record, record.sessionFile, runGeneration);
        }
        if (options.resumeSessionFile !== undefined) {
          confirmSessionFile(mgr, record, runGeneration);
        }
        if (mgr.disposed) return;
        if (record.cancellation?.generation !== runGeneration && record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    });
  const promise = (needsPrepare ? prepareRun().then(startRun) : startRun())
    .then(async ({ responseText, session, aborted, steered, failure }) => {
      try {
        if (mgr.wakeRuns.get(id) === runGeneration) mgr.wakeRuns.delete(id);
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(session);
          return responseText;
        }
        runBudget.controller?.dispose();
        const evaluated = aborted
          ? undefined
          : await evaluateRunUsageLimit(
              mgr,
              record,
              runGeneration,
              runBudget,
              failure,
              providerKey,
              modelRefOf(session?.model) ?? runModel,
              session ?? record.session,
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
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(session);
          return responseText;
        }
        if (usageDecision?.park === true) {
          detach();
          record.session = session;
          record.result = responseText;
          record.error = failure;
          if (record.worktree !== undefined) {
            mgr.deferredWorktrees.set(id, () =>
              cleanupRecordWorktree(mgr, pi, record, baseCwd, customCwd, options.description),
            );
          }
          abortOwnedChildren(mgr, id);
          releaseRunPoolSlot();
          currentRunSettled = true;
          parkForReset(mgr, record, runGeneration, usageDecision, providerKey, wakeResumeOptions);
          drainQueue(mgr);
          return responseText;
        }
        let finalResult = responseText;
        const terminalStatus = terminalStatusFor({ aborted, failure, steered });
        detach();

        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {}
          record.outputCleanup = undefined;
        }

        if (record.worktree) {
          const worktree = record.worktree;
          const hookManaged = worktree.hookManaged === true;
          const worktreePath = worktree.path;
          const disposition = worktreeDispositionFor(mgr, record, runGeneration);
          const wtResult: WorktreeCleanupResult = hookManaged
            ? disposition === "retain"
              ? { hasChanges: false, path: worktreePath, retained: true }
              : (await removeHookWorktree(pi, worktreePath), { hasChanges: false })
            : await cleanupWorktree(baseCwd, worktree, options.description, disposition);
          if (record.resultGeneration !== runGeneration) return responseText;
          if (isSuspendedGeneration(mgr, record, runGeneration)) {
            settleSuspendedRun(session);
            return responseText;
          }
          record.worktreeResult = wtResult;
          if (wtResult.retained === true) {
            finalResult =
              finalResult +
              retainedWorktreeNotice(
                worktree,
                cancellationForGeneration(record, runGeneration)?.cause,
              );
          } else if (wtResult.hasChanges && wtResult.branch) {
            const repoNote = customCwd === undefined ? "" : ` in \`${baseCwd}\``;
            finalResult =
              finalResult +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd === undefined ? "" : ` (run in \`${baseCwd}\`)`}`;
          }
        }

        const verdictLine = recordsVerdict(mgr, record)
          ? await recordRunVerdict(
              mgr,
              record,
              runGeneration,
              responseText,
              record.status === "stopped" ? "stopped" : (runBudget.forcedStatus ?? terminalStatus),
              runBudget.forcedReason ??
                cancellationForGeneration(record, runGeneration)?.reason ??
                failure,
            )
          : undefined;
        if (verdictLine !== undefined) finalResult = `${finalResult}\n\n${verdictLine}`;
        if (record.resultGeneration !== runGeneration) return responseText;
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(session);
          return responseText;
        }
        if (mgr.disposed) {
          record.session = session;
          abortOwnedChildren(mgr, id);
          releaseRunPoolSlot();
          currentRunSettled = true;
          removeRecord(mgr, id, record);
          return responseText;
        }
        if (record.status !== "stopped") {
          transition(mgr, record, runBudget.forcedStatus ?? terminalStatus);
        }
        if (runBudget.forcedReason !== undefined) record.error = runBudget.forcedReason;
        else if (record.cancellation?.generation === runGeneration) {
          record.error = record.cancellation.reason;
        } else if (failure) {
          record.error =
            usageDecision === undefined
              ? failure
              : withUsageLimitNote(failure, usageDecision.usageLimit);
        }
        if (usageDecision !== undefined) record.usageLimit = usageDecision.usageLimit;
        record.result = finalResult;
        record.session = session;
        record.completedAt ??= Date.now();
        if (
          record.cancellation?.generation !== runGeneration &&
          runBudget.forcedStatus === undefined
        ) {
          if (failure !== undefined && usageDecision === undefined) {
            const kind = classifyTerminalFailure(failure);
            if (kind) {
              recordFailure(
                providerKey,
                kind,
                retryAfterMsFromFailure(failure),
                (modelRefOf(session?.model) ?? runModel)?.id,
              );
            }
          } else if (failure === undefined && !aborted) {
            recordSuccess(providerKey, (modelRefOf(session?.model) ?? runModel)?.id);
            const startedAt = lastSuccessfulRequestStart(session);
            if (startedAt !== undefined) {
              reopenAfterSuccess(
                mgr,
                mgr.usageScopes.get(id)?.owner,
                providerKey,
                startedAt,
                (modelRefOf(session?.model) ?? runModel)?.id,
              );
            }
          }
        }
        publishTerminal(mgr, record);
        if (usageDecision !== undefined) notifyUsageLimit(mgr, record);

        abortOwnedChildren(mgr, id);

        if (options.isBackground) {
          releaseRunPoolSlot();
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {}
          drainQueue(mgr);
        } else {
          markTerminalConsumed(mgr, record);
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {}
        }
        return responseText;
      } finally {
        if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
      }
    })
    .catch(async (err) => {
      try {
        if (mgr.wakeRuns.get(id) === runGeneration) mgr.wakeRuns.delete(id);
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(undefined);
          return "";
        }
        runBudget.controller?.dispose();
        const error = err instanceof Error ? err.message : String(err);
        detach();

        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {}
          record.outputCleanup = undefined;
        }

        if (record.worktree) {
          try {
            const worktree = record.worktree;
            const hookManaged = worktree.hookManaged === true;
            const worktreePath = worktree.path;
            const disposition = worktreeDispositionFor(mgr, record, runGeneration);
            const wtResult: WorktreeCleanupResult = hookManaged
              ? disposition === "retain"
                ? { hasChanges: false, path: worktreePath, retained: true }
                : (await removeHookWorktree(pi, worktreePath), { hasChanges: false })
              : await cleanupWorktree(baseCwd, worktree, options.description, disposition);
            if (record.resultGeneration !== runGeneration) return "";
            if (isSuspendedGeneration(mgr, record, runGeneration)) {
              settleSuspendedRun(undefined);
              return "";
            }
            record.worktreeResult = wtResult;
            if (wtResult.retained === true) {
              record.result =
                (record.result ?? "") +
                retainedWorktreeNotice(
                  worktree,
                  cancellationForGeneration(record, runGeneration)?.cause,
                );
            }
          } catch {}
        }

        const verdictLine = recordsVerdict(mgr, record)
          ? await recordRunVerdict(
              mgr,
              record,
              runGeneration,
              undefined,
              record.status === "stopped" ? "stopped" : (runBudget.forcedStatus ?? "error"),
              runBudget.forcedReason ??
                cancellationForGeneration(record, runGeneration)?.reason ??
                error,
            )
          : undefined;
        if (verdictLine !== undefined) {
          record.result =
            record.result === undefined ? verdictLine : `${record.result}\n\n${verdictLine}`;
        }
        if (record.resultGeneration !== runGeneration) return "";
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(undefined);
          return "";
        }
        if (mgr.disposed) {
          abortOwnedChildren(mgr, id);
          releaseRunPoolSlot();
          currentRunSettled = true;
          removeRecord(mgr, id, record);
          return "";
        }
        if (record.status !== "stopped") {
          transition(mgr, record, runBudget.forcedStatus ?? "error");
        }
        record.error =
          runBudget.forcedReason ??
          (record.cancellation?.generation === runGeneration ? record.cancellation.reason : error);
        record.completedAt ??= Date.now();
        if (
          record.cancellation?.generation !== runGeneration &&
          runBudget.forcedStatus === undefined
        ) {
          const kind = classifyTerminalFailure(error);
          if (kind) recordFailure(providerKey, kind, retryAfterMsFromFailure(error), runModel?.id);
        }
        publishTerminal(mgr, record);

        abortOwnedChildren(mgr, id);

        if (options.isBackground) {
          releaseRunPoolSlot();
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {}
          drainQueue(mgr);
        } else {
          markTerminalConsumed(mgr, record);
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {}
        }
        return "";
      } finally {
        if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
      }
    });

  record.promise = promise;

  mgr.onSpawned?.(id);
}

export function dependencyCompletionGuard(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
) {
  let corrected = false;
  record.pendingDependents = undefined;
  return () => {
    if (
      mgr.disposed ||
      record.resultGeneration !== generation ||
      record.status !== "running" ||
      record.cancellation?.generation === generation
    )
      return undefined;
    const pending: NonNullable<AgentRecord["pendingDependents"]> = [];
    for (const child of mgr.agents.values()) {
      if (child.parentAgentId !== record.id) continue;
      if (
        child.status === "running" ||
        child.status === "queued" ||
        child.status === "waiting_for_reset"
      ) {
        pending.push({
          id: child.id,
          handle: child.handle,
          status: child.status,
        });
      }
    }
    if (pending.length === 0) return undefined;
    if (!corrected) {
      corrected = true;
      const labels = pending
        .map((child) => (child.handle ? `${child.id}/@${child.handle}` : child.id))
        .join(", ");
      return {
        steer: `Delegated run(s) ${labels} you own are still running. Await their result with get_subagent_result (or stop them) before finishing.`,
      };
    }
    record.pendingDependents = pending;
    return { failure: "Owned delegated runs were unsettled at the terminal boundary." };
  };
}

export async function spawnAndWait(
  mgr: ManagerState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: Omit<SpawnOptions, "isBackground">,
  onSpawned?: (id: string) => void,
): Promise<{ id: string; record: AgentRecord }> {
  const prevOnSpawned = mgr.onSpawned;
  mgr.onSpawned = onSpawned;
  let id: string;
  try {
    id = mgr.invokeSpawn(pi, ctx, type, prompt, { ...options, isBackground: false });
  } finally {
    mgr.onSpawned = prevOnSpawned;
  }
  const record = mgr.agents.get(id)!;
  await record.promise;
  return { id, record };
}
