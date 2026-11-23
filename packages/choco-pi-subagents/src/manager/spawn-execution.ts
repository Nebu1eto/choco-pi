/**
 * spawn-execution.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

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

/**
 * Spawn an agent and return its ID immediately (for background use).
 * If the concurrency limit is reached, the agent is queued.
 */
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

/** True when a live record other than `id` holds `name` as handle or alias. */
export function nameTakenByLive(mgr: ManagerState, name: string, id: string): boolean {
  for (const record of mgr.agents.values()) {
    if (record.id === id) continue;
    if (record.handle === name || record.alias === name) return true;
  }
  return false;
}

/**
 * Spawn, or (with `identity`) recreate a journaled agent under its own id,
 * handle and alias. A re-arm identity parks the record instead of starting it.
 */
export function spawnWith(
  mgr: ManagerState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: SpawnOptions,
  identity: RevivalIdentity | undefined,
): string {
  // Validate before the queue branch — a queued spawn should fail at the
  // call, not minutes later at drain. Throw (not warn): programmatic callers
  // can fix and retry; the RPC layer converts throws into error envelopes.
  assertAbsoluteSpawnCwd(options.cwd);
  const providerKey = providerKeyFor(options, ctx);
  const usageScope = captureUsageScope(mgr, ctx, options);
  if (identity?.scoped !== undefined) usageScope.scoped = [...identity.scoped];
  const modelId = modelIdFor(options, ctx);
  // A re-armed wait is expected to find its provider closed.
  if (
    identity?.rearm === undefined &&
    !isProviderAvailable(mgr, providerKey, usageScope.owner, modelId)
  ) {
    throw unavailableError(mgr, providerKey, usageScope.owner, modelId);
  }
  if (identity !== undefined && mgr.agents.has(identity.id)) {
    throw new Error(`Agent ${identity.id} is already live.`);
  }
  // After /stop nothing new is admitted, revivals included. Before the review gate so a
  // refused launch never burns the one-shot review ticket.
  requireAdmissionOpen(usageScope.owner);
  // Journal revival (identity set) recovers an already-admitted round.
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
    // Handles are unique across the live tree, so every agent has one flat,
    // unambiguous address regardless of its ownership branch.
    handle:
      revivedHandle ??
      (options.parentAgentId === undefined && options.reclaim?.handle
        ? // A reclaimed handle is used as-is: it belongs to the conversation this
          // spawn is reopening, and re-deriving it would lose the numbering.
          options.reclaim.handle
        : assignHandle(handleBase(type), takenHandles(mgr, options.parentAgentId))),
    description: options.description,
    // Reclaimed here, or filled in below from `name` — in which case it must
    // see the handle this record just took, since both come out of the same
    // namespace.
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
    // Raw tri-state (not coerced to a boolean): true = background, false =
    // foreground (has an inline tool-result surface), undefined = caller never
    // declared it (e.g. a cross-extension RPC spawn). The widget's background-
    // only filter excludes only explicit `false`, so undefined agents — which
    // have no inline surface — stay visible instead of vanishing.
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
    // A revival continues in its original worktree. Record it before the
    // first journal write: a revival queued behind the concurrency cap must
    // be journaled with it, or a restart before it starts loses the work.
    if (options.adoptWorktree !== undefined) {
      applyAdoptedWorktree(mgr, record, options.adoptWorktree);
    }
    if (identity.claim !== undefined) {
      mgr.sessionClaims.set(id, identity.claim);
      // Reopening an existing conversation: the file already holds it, so
      // the very first entry (even a queued one) points at the file and
      // never carries the continuation prompt. A kill before the run starts
      // must reopen the same file, not start a fresh session from the
      // interruption text.
      record.sessionFile = identity.claim.file;
      mgr.sessionFileConfirmed.add(id);
      record.spawnPrompt = undefined;
    }
  }
  // Workflow steps and /btw answers have single-shot aggregate delivery and
  // are never revived; neither are the children they own.
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
    // The revived record (with its revivals count) reaches the journal
    // before the runner is even invoked, so before any provider call. A
    // re-arm is not flushed here: its waiting_for_reset entry coalesces.
    flushJournal(mgr);
  }
  // The retained tombstone now describes this live incarnation. Besides
  // proving ownership for later alias rebinding, moving its id prevents the
  // evicted id from reopening a duplicate while this reclaimed record exists.
  if (
    reclaimedTombstone !== undefined &&
    reclaimedTombstone.handle === record.handle &&
    reclaimedTombstone.alias === record.alias
  ) {
    previousTombstoneId = reclaimedTombstone.id;
    reclaimedTombstone.id = id;
  }
  // After the insert, so `takenHandles()` already counts this record's own
  // handle — a spawn named after its own type gets `explore-2`, not a
  // duplicate `explore` that would make resolution ambiguous.
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
    // Queue it — will be started when a running agent completes
    mgr.queue.push({
      id,
      providerKey,
      modelId,
      start: () => mgr.invokeStartAgent(id, record, args),
    });
    return id;
  }

  // startAgent can throw (e.g. strict worktree-isolation failure) — clean
  // up the record so callers don't see an orphan in `listAgents()`.
  try {
    mgr.invokeStartAgent(id, record, args);
  } catch (err) {
    const alias = record.alias;
    mgr.agents.delete(id);
    mgr.usageScopes.delete(id);
    forgetJournalState(mgr, id);
    // A revival's claim is released by its caller, which still owns the snapshot.
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

/** Actually start an agent (called immediately or from queue drain). */
export function startAgent(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  { pi, ctx, type, prompt, options }: SpawnArgs,
) {
  // Re-validate a caller-supplied cwd: queued spawns can start minutes after
  // spawn()'s check, and the directory may be gone by then (TOCTOU). The
  // absolute-path check throws here; the directory check runs in prepareRun
  // below and settles the record as an error with the same curated message.
  assertAbsoluteSpawnCwd(options.cwd);
  const providerKey = providerKeyFor(options, ctx);
  const owner = mgr.usageScopes.get(id)?.owner;
  const startModelId = modelIdFor(options, ctx);
  if (!isProviderAvailable(mgr, providerKey, owner, startModelId)) {
    throw unavailableError(mgr, providerKey, owner, startModelId);
  }
  // Snapshot the requested model now; settle-time code must not read a ctx
  // the host may have retired. The live session model wins when available.
  const runModel = modelRefOf(options.model ?? ctx.model);
  // Continuation callbacks for a post-reset resume. A foreground caller's
  // callbacks stream into a tool call that has already returned, so drop them.
  const wakeResumeOptions: ResumeOptions = options.isBackground
    ? {
        budgets: options.budgets,
        onToolActivity: options.onToolActivity,
        onAssistantUsage: options.onAssistantUsage,
        onCompaction: options.onCompaction,
      }
    : { budgets: options.budgets };
  // Single resolution point for the caller-supplied cwd — the worktree base
  // repo and both cleanup calls below MUST agree on this value forever.
  const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
  // An adopted worktree came from its journaled repo; cleanup must target it.
  const baseCwd = options.adoptWorktree?.repo ?? customCwd ?? ctx.cwd;

  // Worktree isolation: try to create a temporary git worktree. Strict —
  // fail loud if not possible (no silent fallback to main tree). Creation
  // runs git asynchronously in prepareRun below, after the record owns its
  // run; a failure settles the record through the run's error path.
  // The project switch is enforced here as well as at the tool boundary
  // because cross-extension RPC forwards its options unvalidated — a schema
  // that omits the field can't stop a caller that never saw the schema.
  let worktreeCwd: string | undefined;
  const createsWorktree =
    options.adoptWorktree === undefined &&
    options.isolation === "worktree" &&
    isWorktreeIsolationEnabled();
  if (options.adoptWorktree !== undefined) {
    // Revival: continue in the original worktree (verified by the caller).
    const adopt = options.adoptWorktree;
    const workPath = applyAdoptedWorktree(mgr, record, adopt);
    // Same rule as a created worktree: a caller-supplied cwd maps to its
    // subdirectory, a plain spawn runs at the copy's root.
    worktreeCwd = customCwd === undefined ? adopt.path : workPath;
  }
  // Asynchronous preparation, invoked once this generation is running:
  // the caller-supplied cwd's directory check and worktree creation. After
  // the awaits it rechecks that this generation still owns the record; a
  // stale or cancelled run removes the worktree it just made (nothing
  // journaled it) and rejects into the run's error path.
  const prepareRun = async (): Promise<void> => {
    if (customCwd !== undefined) await assertSpawnCwdDirectory(customCwd);
    // A /stop during the await must not let a session start.
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
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd === undefined ? wt.path : wt.workPath;
      mgr.worktreeRepos.add(baseCwd);
    }
    // The run reads ctx next: it must still own this record.
    if (!ownsPreparedRun(mgr, record, runGeneration)) {
      throw new Error(record.cancellation?.reason ?? "Run ended before it started.");
    }
    requireAdmissionOpen(recordRoot(mgr, record));
  };
  const needsPrepare = customCwd !== undefined || createsWorktree;

  transition(mgr, record, "running");
  record.startedAt = Date.now();
  const runGeneration = record.resultGeneration ?? 1;
  // A post-reset continuation of a re-armed record runs through this path; a
  // repeated limit then exhausts it instead of parking again.
  const isWakeRun = mgr.wakeRuns.get(id) === runGeneration;
  const runTookPoolSlot = occupiesPoolSlot(record);
  let runPoolSlotHeld = runTookPoolSlot;
  if (runTookPoolSlot) mgr.runningBackground++;
  mgr.onStart?.(record);

  // Wire parent abort signal to stop the subagent when the parent is interrupted
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
  // Settle this generation as suspended (every settle path, after every await).
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
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
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
        // Cancellation stops provider work, not ownership of the child that
        // startup created. Retain it even after shutdown for settlement cleanup.
        record.session = session;
        // The caller built provenance from the requested model and thinking;
        // session creation may clamp thinking (or resolve another model). The
        // completion notification and journal read this record, so report
        // what the session runs. Source and definition stay as requested.
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
        // Before the first request: a token cap that cannot cover the
        // bootstrap prompt stops the run here instead of after a spent call.
        if (options.budgets?.maxTokens !== undefined && options.resumeSessionFile === undefined) {
          runBudget.controller?.checkBootstrap(bootstrapEstimateOf(session));
        }
        if (options.mainSessionFork) {
          record.sessionCostBaseline = getSessionCostBaseline(session) ?? undefined;
        }
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        if (record.sessionFile === undefined) {
          if (options.mainSessionFork === undefined) record.inMemorySession = true;
        } else {
          record.inMemorySession = undefined;
          claimRecordSessionFile(mgr, record, record.sessionFile, runGeneration);
        }
        // A reopened conversation already lives in that file. A fresh one is
        // only written once it holds a message, so the journal keeps the
        // prompt until the run's first assistant message confirms the file.
        if (options.resumeSessionFile !== undefined) {
          confirmSessionFile(mgr, record, runGeneration);
        }
        // Caller wiring can use host-owned context; shutdown retires it.
        if (mgr.disposed) return;
        // Flush pre-session steers only while this generation is uncancelled.
        if (record.cancellation?.generation !== runGeneration && record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    });
  // Without preparation the run starts synchronously, exactly as before.
  const promise = (needsPrepare ? prepareRun().then(startRun) : startRun())
    .then(async ({ responseText, session, aborted, steered, failure }) => {
      try {
        if (mgr.wakeRuns.get(id) === runGeneration) mgr.wakeRuns.delete(id);
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(session);
          return responseText;
        }
        runBudget.controller?.dispose();
        // Before detach: a parent abort during evaluation must still cancel.
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
        // A suspend during the evaluation keeps the worktree and publishes nothing.
        if (isSuspendedGeneration(mgr, record, runGeneration)) {
          settleSuspendedRun(session);
          return responseText;
        }
        if (usageDecision?.park === true) {
          // Parked: keep the session, transcript stream, and any worktree for
          // the same-model continuation; publish nothing yet. The worktree is
          // cleaned on the task's final settle, whichever path reaches it.
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

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {
            /* ignore */
          }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
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
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd === undefined ? "" : ` in \`${baseCwd}\``;
            finalResult =
              finalResult +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd === undefined ? "" : ` (run in \`${baseCwd}\`)`}`;
          }
        }

        // Verdict record: the status and error mirror what is published below.
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
        // Publish status, output and generation together. Keeping the record
        // active through asynchronous worktree cleanup prevents resume/result
        // reads from observing a terminal status with unfinished output.
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
          // A usage-limit decision already applied its own closure via closeUntil.
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

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (options.isBackground) {
          releaseRunPoolSlot();
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {
            /* ignore completion side-effect errors */
          }
          drainQueue(mgr);
        } else {
          markTerminalConsumed(mgr, record);
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {
            /* ignore completion side-effect errors */
          }
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

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {
            /* ignore */
          }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
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
          } catch {
            /* ignore cleanup errors */
          }
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

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (options.isBackground) {
          releaseRunPoolSlot();
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {
            /* ignore completion side-effect errors */
          }
          drainQueue(mgr);
        } else {
          markTerminalConsumed(mgr, record);
          currentRunSettled = true;
          try {
            mgr.onComplete?.(record);
          } catch {
            /* ignore completion side-effect errors */
          }
        }
        return "";
      } finally {
        if (!currentRunSettled && record.resultGeneration !== runGeneration) settleStaleRun();
      }
    });

  record.promise = promise;

  // Notify caller that spawn is complete (record is in the map, promise is set).
  // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
  // Used by spawnAndWait to let the caller set up output files before streaming starts.
  mgr.onSpawned?.(id);
}

export function dependencyCompletionGuard(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
) {
  let corrected = false;
  // A resumed generation must discard its prior terminal snapshot before any turn runs.
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

/**
 * Spawn an agent and wait for completion (foreground use).
 * Foreground agents bypass the concurrency queue.
 * Returns { id, record } so callers can access the agent ID.
 *
 * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
 *   Use this to set record.outputFile so streamToOutputFile can pick it up.
 */
export async function spawnAndWait(
  mgr: ManagerState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: Omit<SpawnOptions, "isBackground">,
  onSpawned?: (id: string) => void,
): Promise<{ id: string; record: AgentRecord }> {
  // Temporarily register the onSpawned hook so startAgent can call it.
  const prevOnSpawned = mgr.onSpawned;
  mgr.onSpawned = onSpawned;
  let id: string;
  try {
    // spawn() invokes onSpawned synchronously before returning. Restore the
    // shared hook immediately so unrelated concurrent spawns cannot inherit
    // this foreground caller's callback while its run is awaited.
    id = mgr.invokeSpawn(pi, ctx, type, prompt, { ...options, isBackground: false });
  } finally {
    mgr.onSpawned = prevOnSpawned;
  }
  const record = mgr.agents.get(id)!;
  await record.promise;
  return { id, record };
}
