import { formatProviderLabel } from "../../../../packages/choco-pi-ui/extensions/zentui/model-display.ts";
import { isStaleContextError } from "../lifecycle.ts";
import type { RuntimeValue } from "../runtime-values.ts";
import {
  scopeNote,
  USAGE_LIMIT_PENDING_ENTRY,
  USAGE_LIMIT_RESOLVED_ENTRY,
  type UsageLimitClassification,
  type UsageLimitPendingEntry,
  type UsageLimitResolvedEntry,
} from "../usage-limit-contract.ts";
import { formatReset, latestUnresolvedPending, modelKey, notify } from "./helpers.ts";
import {
  DEFAULT_ACCOUNT_ID,
  MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  POLL_LIMIT_MS,
  REPLAY_GRACE_MS,
  RESET_MARGIN_MS,
  RESUME_MESSAGE,
  USAGE_LIMIT_MESSAGE_TYPE,
  type ControllerState,
  type OwnerSession,
  type Recovery,
  type UsageLimitControllerDeps,
  type UsageLimitHost,
  type UsageLimitHostContext,
  type UsageLimitModel,
} from "./types.ts";

export type RecoveryManager<M extends UsageLimitModel, C extends UsageLimitHostContext<M>> = {
  interrupt(): void;
  isCurrent(sessionId: string, generation: number): boolean;
  isCurrentRecovery(recovery: Recovery): boolean;
  resetBudgets(): void;
  resolveRecovery(recovery: Recovery, outcome: UsageLimitResolvedEntry["outcome"]): void;
  cancelRecovery(sessionId?: string): void;
  invalidate(): void;
  accountIdFor(session: OwnerSession<C>, provider: string): string;
  lookupAccountId(session: OwnerSession<C>, provider: string): Promise<void>;
  closeLimitedAccount(
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    untilMs: number,
  ): void;
  sendContinuation(content: string): void;
  notifyLimit(ctx: C, classification: UsageLimitClassification, suffix: string): void;
  writePending(
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    attempts: number,
    branchEntryId: string | undefined,
  ): { recoveryId: string; accountId: string };
  arm(
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    armedModel: string,
    attempts: number,
    branchEntryId: string | undefined,
  ): void;
  replay(session: OwnerSession<C>, ctx: C): Promise<void>;
};

export function createRecoveryManager<
  M extends UsageLimitModel,
  C extends UsageLimitHostContext<M>,
>(
  pi: UsageLimitHost<M, C>,
  deps: UsageLimitControllerDeps<C>,
  state: ControllerState<M, C>,
): RecoveryManager<M, C> {
  const interrupt = (): void => {
    state.operation += 1;
  };

  const isCurrent = (sessionId: string, generation: number): boolean =>
    state.generation === generation && state.session?.sessionId === sessionId;

  const isCurrentRecovery = (recovery: Recovery): boolean =>
    state.recovery === recovery && isCurrent(recovery.sessionId, recovery.generation);

  const resetBudgets = (): void => {
    state.fallbackSwitches = 0;
    state.resumeAttempts = 0;
  };

  const resolveRecovery = (
    recovery: Recovery,
    outcome: UsageLimitResolvedEntry["outcome"],
  ): void => {
    recovery.timer?.cancel();
    recovery.timer = undefined;
    if (state.recovery === recovery) state.recovery = undefined;
    if (recovery.resolved) return;
    recovery.resolved = true;
    const entry: UsageLimitResolvedEntry = { recoveryId: recovery.recoveryId, outcome };
    pi.appendEntry(USAGE_LIMIT_RESOLVED_ENTRY, entry);
  };

  const cancelRecovery = (sessionId: string | undefined = state.session?.sessionId): void => {
    const recovery = state.recovery;
    if (!recovery) return;
    if (sessionId === recovery.sessionId) {
      resolveRecovery(recovery, "cancelled");
      return;
    }
    recovery.timer?.cancel();
    state.recovery = undefined;
  };

  const invalidate = (): void => {
    interrupt();
    state.generation += 1;
    const recovery = state.recovery;
    recovery?.timer?.cancel();
    state.recovery = undefined;
    state.session?.unregister();
    state.session = undefined;
    state.handledEntryId = undefined;
    state.selfSelecting = undefined;
    state.inFlightSwitch = undefined;
    state.ownTurnPending = false;
    resetBudgets();
  };

  const accountIdFor = (session: OwnerSession<C>, provider: string): string =>
    session.accountIds.get(provider) ?? DEFAULT_ACCOUNT_ID;

  const lookupAccountId = (session: OwnerSession<C>, provider: string): Promise<void> => {
    const existing = session.accountLookups.get(provider);
    if (existing) return existing;
    const { ctx } = session;
    const forget = (): void => {
      if (session.accountLookups.get(provider) === lookup) session.accountLookups.delete(provider);
    };
    const lookup: Promise<void> = Promise.resolve()
      .then(() => deps.lookupAccountId(ctx, provider))
      .then((accountId) => {
        if (accountId === undefined) forget();
        else session.accountIds.set(provider, accountId);
      }, forget);
    session.accountLookups.set(provider, lookup);
    return lookup;
  };

  const closeLimitedAccount = (
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    untilMs: number,
  ): void => {
    const accountIds = new Set([accountIdFor(session, classification.provider)]);
    if (classification.accountId !== undefined) accountIds.add(classification.accountId);
    for (const accountId of accountIds) {
      session.policy.closeProvider(
        classification.provider,
        accountId,
        untilMs,
        classification.scope,
      );
    }
  };

  const sendContinuation = (content: string): void => {
    state.ownTurnPending = true;
    try {
      pi.sendMessage(
        { customType: USAGE_LIMIT_MESSAGE_TYPE, content, display: true },
        { triggerTurn: true },
      );
    } catch (error) {
      state.ownTurnPending = false;
      throw error;
    }
  };

  const reportTimerFailure = (recovery: Recovery, error: RuntimeValue): void => {
    if (isStaleContextError(error)) return;
    const session = state.session;
    if (!session || !isCurrentRecovery(recovery)) return;
    try {
      const reason = error instanceof Error ? error.message : String(error);
      notify(session.ctx, `Usage-limit auto-resume stopped: ${reason}`, "error");
      resolveRecovery(recovery, "cancelled");
    } catch (reportError) {
      if (!isStaleContextError(reportError)) throw reportError;
    }
  };

  const exhaust = (session: OwnerSession<C>, recovery: Recovery): void => {
    resolveRecovery(recovery, "exhausted");
    state.resumeAttempts = 0;
    notify(
      session.ctx,
      `${formatProviderLabel(recovery.classification.provider)} usage limit did not reset in time; auto-resume stopped. Use /model to switch.`,
      "warning",
    );
  };

  const scheduleWake = (session: OwnerSession<C>, recovery: Recovery): void => {
    const now = deps.now();
    let delay: number;
    if (recovery.resetAt !== undefined && recovery.resetAt > now) {
      recovery.pollDeadline = undefined;
      delay = Math.min(recovery.resetAt + RESET_MARGIN_MS - now, MAX_WAIT_MS);
    } else {
      recovery.pollDeadline ??= now + POLL_LIMIT_MS;
      if (now >= recovery.pollDeadline) {
        recovery.timer?.cancel();
        recovery.timer = undefined;
        exhaust(session, recovery);
        return;
      }
      delay = Math.min(POLL_INTERVAL_MS, recovery.pollDeadline - now);
    }
    scheduleWakeIn(recovery, delay);
  };

  const scheduleWakeIn = (recovery: Recovery, delay: number): void => {
    recovery.timer?.cancel();
    recovery.timer = undefined;
    recovery.timer = deps.schedule(() => {
      recovery.timer = undefined;
      wake(recovery).catch((error: RuntimeValue) => reportTimerFailure(recovery, error));
    }, delay);
  };

  const pollAgain = (session: OwnerSession<C>, recovery: Recovery): void => {
    recovery.resetAt = undefined;
    scheduleWake(session, recovery);
  };

  const isQuiet = (ctx: C): boolean => ctx.isIdle() && !ctx.hasPendingMessages();

  const wake = async (recovery: Recovery): Promise<void> => {
    const session = state.session;
    if (!session || !isCurrentRecovery(recovery)) return;
    const operation = state.operation;
    const live = (): boolean => isCurrentRecovery(recovery) && state.operation === operation;
    const { ctx, policy } = session;
    if (ctx.sessionManager.getSessionId() !== recovery.sessionId) {
      state.recovery = undefined;
      return;
    }
    if (modelKey(ctx.model) !== recovery.modelKey) {
      resolveRecovery(recovery, "cancelled");
      return;
    }
    if (!isQuiet(ctx)) {
      pollAgain(session, recovery);
      return;
    }
    const preference = await policy.preference();
    if (!live()) return;
    if (preference !== "auto-resume") {
      resolveRecovery(recovery, "cancelled");
      return;
    }
    const corroborated = await policy.corroborate({
      ...recovery.classification,
      resetAt: recovery.resetAt,
    });
    if (!live()) return;
    if (!corroborated.ready) {
      const resetAt = corroborated.classification.resetAt;
      recovery.resetAt = resetAt !== undefined && resetAt > deps.now() ? resetAt : undefined;
      scheduleWake(session, recovery);
      return;
    }
    if (!isQuiet(ctx) || modelKey(ctx.model) !== recovery.modelKey) {
      pollAgain(session, recovery);
      return;
    }
    resolveRecovery(recovery, "continued");
    sendContinuation(RESUME_MESSAGE);
  };

  const writePending = (
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    attempts: number,
    branchEntryId: string | undefined,
  ) => {
    const recoveryId = deps.createId();
    const accountId = classification.accountId ?? accountIdFor(session, classification.provider);
    const pending: UsageLimitPendingEntry = {
      recoveryId,
      modelId: classification.modelId,
      provider: classification.provider,
      accountId,
      attempts,
      sessionId: session.sessionId,
    };
    if (classification.resetAt !== undefined) pending.resetAt = classification.resetAt;
    if (branchEntryId !== undefined) pending.branchEntryId = branchEntryId;
    pi.appendEntry(USAGE_LIMIT_PENDING_ENTRY, pending);
    return { recoveryId, accountId };
  };

  const arm = (
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    armedModel: string,
    attempts: number,
    branchEntryId: string | undefined,
  ): void => {
    const { recoveryId, accountId } = writePending(
      session,
      classification,
      attempts,
      branchEntryId,
    );
    const recovery: Recovery = {
      recoveryId,
      sessionId: session.sessionId,
      generation: session.generation,
      modelKey: armedModel,
      mode: "auto-resume",
      classification,
      accountId,
      attempts,
    };
    if (classification.resetAt !== undefined) recovery.resetAt = classification.resetAt;
    state.recovery = recovery;
    state.resumeAttempts = attempts;
    scheduleWake(session, recovery);
  };

  const notifyLimit = (ctx: C, classification: UsageLimitClassification, suffix: string): void => {
    notify(
      ctx,
      `${formatProviderLabel(classification.provider)} ${classification.kind} limit reached${scopeNote(
        classification.scope,
      )}; resets ${formatReset(classification.resetAt, deps.now())}. ${suffix}`,
      "warning",
    );
  };

  const replay = async (session: OwnerSession<C>, ctx: C): Promise<void> => {
    const record = latestUnresolvedPending(ctx.sessionManager.getBranch());
    if (!record) return;
    const { pending, recordedAt } = record;
    if (pending.sessionId !== undefined && pending.sessionId !== session.sessionId) return;
    const classification: UsageLimitClassification = {
      kind: "quota",
      provider: pending.provider,
      modelId: pending.modelId,
      accountId: pending.accountId,
      confidence: "inferred",
      sessionId: session.sessionId,
    };
    if (pending.resetAt !== undefined) classification.resetAt = pending.resetAt;
    const recovery: Recovery = {
      recoveryId: pending.recoveryId,
      sessionId: session.sessionId,
      generation: session.generation,
      modelKey: `${pending.provider}/${pending.modelId}`,
      mode: "auto-resume",
      classification,
      accountId: pending.accountId,
      attempts: pending.attempts,
    };
    state.recovery = recovery;
    state.resumeAttempts = pending.attempts;
    const now = deps.now();
    if (pending.resetAt !== undefined && pending.resetAt > now) {
      recovery.resetAt = pending.resetAt;
      scheduleWake(session, recovery);
    } else {
      const pollStart = pending.resetAt ?? recordedAt;
      if (pollStart !== undefined) recovery.pollDeadline = pollStart + POLL_LIMIT_MS;
      scheduleWakeIn(recovery, REPLAY_GRACE_MS);
    }
    const preference = await session.policy.preference();
    if (!isCurrentRecovery(recovery)) return;
    if (preference !== "auto-resume") resolveRecovery(recovery, "cancelled");
  };

  return {
    interrupt,
    isCurrent,
    isCurrentRecovery,
    resetBudgets,
    resolveRecovery,
    cancelRecovery,
    invalidate,
    accountIdFor,
    lookupAccountId,
    closeLimitedAccount,
    sendContinuation,
    notifyLimit,
    writePending,
    arm,
    replay,
  };
}
