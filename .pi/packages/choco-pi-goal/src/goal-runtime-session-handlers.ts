import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  clearActiveHostOverflowRecovery,
  recoveryPhaseBlocksContinuation,
} from "./recovery-machine.ts";
import { isRecoveryPendingAttention, reasonFromRecoveryPendingAttention } from "./recovery.ts";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.ts";
import type { GoalRuntimeSessionHandlerContext } from "./goal-runtime-event-handler-types.ts";
import type { GoalRecoveryMachineState } from "./recovery-machine.ts";
import type { ThreadGoal } from "./types.ts";

/**
 * Background-compaction adoption signal published by `choco-pi-compaction`.
 *
 * A boundary adoption commits a checkpoint without any host compaction event,
 * so the goal runtime learns about it from this process-global relay instead.
 * Host-routed adoptions also arrive as a real `session_compact`; both paths
 * key on the committed entry ID, so each compaction is handled exactly once.
 * "recovered" notices happened in an earlier process and are ignored. An
 * absent or foreign slot leaves the goal runtime exactly as before.
 */
const BACKGROUND_ADOPTION_SIGNAL = Symbol.for("choco-pi:compaction-background-adoption");
const AdoptionSignalSchema = Type.Object({
  version: Type.Literal(1),
  subscribe: Type.Function([], Type.Unknown()),
});
const AdoptionNoticeSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    committedEntryId: Type.String({ minLength: 1 }),
    route: Type.String(),
  },
  { additionalProperties: true },
);
const UnsubscribeSchema = Type.Function([], Type.Unknown());

/** The members of the published notice this runtime reads. */
type AdoptionNotice = Static<typeof AdoptionNoticeSchema>;
type AdoptionListener = (notice: AdoptionNotice, ctx: ExtensionContext) => void;
interface AdoptionSignal {
  subscribe(listener: AdoptionListener): () => void;
}

function isAdoptionSignal<T>(value: T): value is T & AdoptionSignal {
  return Value.Check(AdoptionSignalSchema, value);
}

function isUnsubscribe<T>(value: T): value is T & (() => void) {
  return Value.Check(UnsubscribeSchema, value);
}

function resolveAdoptionSignal(): AdoptionSignal | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    BACKGROUND_ADOPTION_SIGNAL,
  )?.value;
  return isAdoptionSignal(found) ? found : undefined;
}

export function createSessionEventHandlers(deps: GoalRuntimeSessionHandlerContext) {
  const {
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    resetErrorRecovery,
  } = deps;

  const schedulePostCompactContinuationFallback = (
    ctx: ExtensionContext,
    options: { clearHostOverflowRecovery: boolean },
  ): void => {
    const fallbackOptions = {
      turnIndex: runtimeState.currentTurnIndex,
      agentRunSequence: runtimeState.agentRunSequence,
    };
    continuation.maybeContinueAfterPostCompactFallback(
      ctx,
      options.clearHostOverflowRecovery
        ? {
            ...fallbackOptions,
            prepareContinuation: () => clearHostOverflowRecoveryForContinuation(deps, ctx),
          }
        : fallbackOptions,
    );
  };

  /** Post-compaction goal work shared by host compactions and boundary adoptions. */
  const afterCompaction = (ctx: ExtensionContext, willRetry: boolean): void => {
    if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)) {
      return;
    }

    const activeGoal = stateController.getGoal();
    if (activeGoal?.status === "active") {
      continuation.clearContinuationStateFor(activeGoal.goalId);
    }
    stateController.flushGoalPersistence("runtime");
    const wasRecoveringFromHostOverflow = recoveryPhaseBlocksContinuation(
      runtimeState.recoveryState.phase,
    );
    recoveryRuntime.onSessionCompact();
    status.refreshUi(ctx);
    if (willRetry) {
      schedulePostCompactContinuationFallback(ctx, {
        clearHostOverflowRecovery: wasRecoveringFromHostOverflow,
      });
      return;
    }
    if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
      continuation.maybeContinueAfterCurrentEvent(ctx);
    } else if (wasRecoveringFromHostOverflow) {
      schedulePostCompactContinuationFallback(ctx, { clearHostOverflowRecovery: true });
    }
  };

  // Background adoption relay; only active while the compaction package
  // publishes its signal for this session.
  let adoptionSubscription: { readonly sessionId: string; readonly stop: () => void } | undefined;
  /** Compaction entries this session already handled, from either path. */
  const handledEntryIds = new Set<string>();

  const afterCompactionOnce = (entryId: string, ctx: ExtensionContext, willRetry: boolean) => {
    if (handledEntryIds.has(entryId)) return;
    handledEntryIds.add(entryId);
    afterCompaction(ctx, willRetry);
  };

  const stopAdoptionRelay = (): void => {
    const current = adoptionSubscription;
    adoptionSubscription = undefined;
    handledEntryIds.clear();
    current?.stop();
  };

  const startAdoptionRelay = (ctx: ExtensionContext): void => {
    stopAdoptionRelay();
    const signal = resolveAdoptionSignal();
    if (signal === undefined) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const listener: AdoptionListener = (notice, noticeCtx) => {
      if (adoptionSubscription?.sessionId !== sessionId) return;
      if (!Value.Check(AdoptionNoticeSchema, notice) || notice.sessionId !== sessionId) return;
      if (notice.route === "recovered") return;
      afterCompactionOnce(notice.committedEntryId, noticeCtx, false);
    };
    const unsubscribe = signal.subscribe(listener);
    // The slot is foreign code: confirm the callback before keeping it.
    if (!isUnsubscribe(unsubscribe)) return;
    adoptionSubscription = { sessionId, stop: () => unsubscribe() };
  };

  return {
    onSessionStart: (async (event, ctx) => {
      startAdoptionRelay(ctx);
      continuation.clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      if (await confirmPausedGoalResume(deps, event, ctx)) return;
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionStartEvent>,

    onSessionTree: (async (_event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onSessionBeforeCompact: (async (_event, ctx) => {
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact(),
          ctx,
          deps,
        )
      ) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
    }) satisfies ExtensionHandler<SessionBeforeCompactEvent>,

    onSessionCompact: (async (event, ctx) => {
      if (adoptionSubscription === undefined) afterCompaction(ctx, event.willRetry);
      else afterCompactionOnce(event.compactionEntry.id, ctx, event.willRetry);
    }) satisfies ExtensionHandler<SessionCompactEvent>,

    onSessionShutdown: (async (_event, ctx) => {
      stopAdoptionRelay();
      continuation.clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      continuation.clearPassthroughContinuationInput();
      continuation.clearContinuationTimer();
      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects,
        ctx,
        deps,
      );

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
      if (hasPendingRecoveryAttention(deps)) {
        pauseForPendingRecoveryShutdown(ctx, deps);
      } else {
        resetErrorRecovery();
      }
      status.stopStatusRefresh();
    }) satisfies ExtensionHandler<SessionShutdownEvent>,
  };
}

/** Clear a host-overflow recovery that blocks the post-compaction continuation. */
function clearHostOverflowRecoveryForContinuation(
  { runtimeState, status }: GoalRuntimeSessionHandlerContext,
  ctx: ExtensionContext,
): boolean {
  if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
    return false;
  }
  clearActiveHostOverflowRecovery(runtimeState.recoveryState);
  status.refreshUi(ctx);
  return true;
}

/** On a session resume, offer to resume a paused goal; true when the user accepted. */
async function confirmPausedGoalResume(
  { stateController, goalAccounting, resumeGoalWithContinuation }: GoalRuntimeSessionHandlerContext,
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<boolean> {
  const goal = stateController.getGoal();
  const pausedGoal = goal?.status === "paused" ? goal : null;
  if (event.reason !== "resume" || !pausedGoal || !ctx.hasUI) return false;
  const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${pausedGoal.objective}`);
  if (!shouldResume) return false;
  resumeGoalWithContinuation(pausedGoal.goalId, "runtime", ctx);
  goalAccounting.beginAccounting();
  return true;
}

interface PendingRecoveryShutdownContext {
  recoveryState: Pick<GoalRecoveryMachineState, "attention">;
  getGoal: () => ThreadGoal | null;
}

export function pendingRecoveryShutdownReason({
  recoveryState,
  getGoal,
}: PendingRecoveryShutdownContext): string | null {
  const goal = getGoal();
  if (goal?.status !== "active" || !isRecoveryPendingAttention(recoveryState.attention)) {
    return null;
  }
  return reasonFromRecoveryPendingAttention(recoveryState.attention);
}

function hasPendingRecoveryAttention({
  runtimeState,
  stateController,
}: GoalRuntimeSessionHandlerContext): boolean {
  return (
    pendingRecoveryShutdownReason({
      recoveryState: runtimeState.recoveryState,
      getGoal: stateController.getGoal,
    }) !== null
  );
}

function pauseForPendingRecoveryShutdown(
  ctx: ExtensionContext,
  deps: GoalRuntimeSessionHandlerContext,
): void {
  const { runtimeState, stateController } = deps;
  const reason = pendingRecoveryShutdownReason({
    recoveryState: runtimeState.recoveryState,
    getGoal: stateController.getGoal,
  });
  if (!reason) {
    return;
  }

  stateController.applyGoalTransition(
    {
      kind: "recovery_shutdown_pause",
      recoveryReason: reason,
    },
    ctx,
  );
}
