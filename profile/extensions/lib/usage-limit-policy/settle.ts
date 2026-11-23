import { formatProviderLabel } from "../../../../packages/choco-pi-ui/extensions/zentui/model-display.ts";
import {
  USAGE_LIMIT_RESOLVED_ENTRY,
  type UsageLimitClassification,
  type UsageLimitResolvedEntry,
} from "../usage-limit-contract.ts";
import { switchToFallback } from "./fallback-switch.ts";
import {
  hasCapacity,
  isInterruptedByLimit,
  isSuccessfulStop,
  lastAssistantTurn,
  modelKey,
  notify,
} from "./helpers.ts";
import type { RecoveryManager } from "./recovery.ts";
import {
  DEFAULT_CLOSE_MS,
  MAX_RESUME_ATTEMPTS,
  type ControllerState,
  type ModelRef,
  type UsageLimitControllerDeps,
  type UsageLimitHost,
  type UsageLimitHostContext,
  type UsageLimitModel,
} from "./types.ts";

export function createSettleHandler<M extends UsageLimitModel, C extends UsageLimitHostContext<M>>(
  pi: UsageLimitHost<M, C>,
  deps: UsageLimitControllerDeps<C>,
  state: ControllerState<M, C>,
  recovery: RecoveryManager<M, C>,
): (ctx: C) => Promise<void> {
  return async (ctx: C): Promise<void> => {
    const session = state.session;
    if (!session) return;
    const { sessionId, generation, policy } = session;
    const operation = state.operation;
    const live = (): boolean =>
      recovery.isCurrent(sessionId, generation) && state.operation === operation;
    session.ctx = ctx;
    const turn = lastAssistantTurn(ctx.sessionManager.getBranch());

    if (state.recovery) {
      const armed = state.recovery;
      const preference = await policy.preference();
      if (!live()) return;
      if (preference !== "auto-resume" && state.recovery === armed) {
        recovery.resolveRecovery(armed, "cancelled");
      }
    }

    if (!turn || turn.entryId === state.handledEntryId) return;
    const { message } = turn;
    if (isSuccessfulStop(message)) {
      state.handledEntryId = turn.entryId;
      recovery.resetBudgets();
      policy.reopen(
        message.provider,
        recovery.accountIdFor(session, message.provider),
        message.timestamp,
        message.model,
      );
      return;
    }
    if (!isInterruptedByLimit(message)) return;
    state.handledEntryId = turn.entryId;

    const rawClassified = policy.classify({
      provider: message.provider,
      modelId: message.model,
      errorMessage: message.errorMessage ?? "",
    });
    if (!rawClassified || rawClassified.kind === "transient") return;
    const classified: UsageLimitClassification = { ...rawClassified, sessionId };

    if (deps.readGoalOwnership(sessionId)) {
      recovery.notifyLimit(ctx, classified, "Goal recovery owns the resume.");
      return;
    }

    const preference = await policy.preference();
    if (!live()) return;
    const corroborated = await policy.corroborate(classified);
    if (!live()) return;
    const { classification, evidence } = corroborated;
    if (hasCapacity(evidence)) {
      notify(
        ctx,
        `${formatProviderLabel(classification.provider)} rate limit is not a confirmed usage limit (live usage data shows capacity); not recovering automatically. Retry, or use /model to switch.`,
        "warning",
      );
      return;
    }
    await recovery.lookupAccountId(session, classification.provider);
    if (!live()) return;
    if (!corroborated.ready) {
      recovery.closeLimitedAccount(
        session,
        classification,
        classification.resetAt ?? deps.now() + DEFAULT_CLOSE_MS,
      );
    }

    const limited: ModelRef = { provider: message.provider, id: message.model };
    if (preference === "fallback") {
      if (
        await switchToFallback(
          pi,
          deps,
          state,
          recovery,
          session,
          ctx,
          limited,
          classification,
          live,
        )
      ) {
        return;
      }
      if (!live()) return;
      recovery.notifyLimit(
        ctx,
        classification,
        "No fallback model available; use /model to switch.",
      );
      return;
    }
    if (
      preference === "auto-resume" &&
      classification.kind === "quota" &&
      evidence !== "confirmed"
    ) {
      recovery.notifyLimit(
        ctx,
        classification,
        "Usage data cannot confirm the reset, so auto-resume is off for this limit; use /model to switch.",
      );
      return;
    }
    if (preference === "auto-resume" && classification.kind === "quota") {
      const attempts = state.resumeAttempts + 1;
      if (attempts > MAX_RESUME_ATTEMPTS) {
        state.resumeAttempts = 0;
        const armed = state.recovery;
        if (armed && recovery.isCurrentRecovery(armed)) {
          recovery.resolveRecovery(armed, "exhausted");
        } else {
          const { recoveryId } = recovery.writePending(
            session,
            classification,
            attempts,
            turn.entryId,
          );
          const entry: UsageLimitResolvedEntry = { recoveryId, outcome: "exhausted" };
          pi.appendEntry(USAGE_LIMIT_RESOLVED_ENTRY, entry);
        }
        recovery.notifyLimit(
          ctx,
          classification,
          "Auto-resume retries exhausted; use /model to switch.",
        );
        return;
      }
      if (state.recovery) return;
      const armedModel = modelKey(ctx.model) ?? `${limited.provider}/${limited.id}`;
      recovery.arm(session, classification, armedModel, attempts, turn.entryId);
      recovery.notifyLimit(
        ctx,
        classification,
        "Waiting for the reset, then continuing automatically.",
      );
      return;
    }
    recovery.notifyLimit(ctx, classification, "Use /model to switch.");
  };
}
