import { formatProviderLabel } from "../../../../packages/choco-pi-ui/extensions/zentui/model-display.ts";
import { isStaleContextError } from "../lifecycle.ts";
import {
  scopeCoversModel,
  scopeNote,
  type UsageLimitClassification,
} from "../usage-limit-contract.ts";
import { formatReset, modelKey, notify } from "./helpers.ts";
import type { RecoveryManager } from "./recovery.ts";
import {
  MAX_FALLBACK_SWITCHES,
  MAX_SELECTION_RESTORES,
  type ControllerState,
  type InFlightSwitch,
  type ModelRef,
  type OwnerSession,
  type UsageLimitControllerDeps,
  type UsageLimitHost,
  type UsageLimitHostContext,
  type UsageLimitModel,
} from "./types.ts";

async function restoreUserSelection<M extends UsageLimitModel, C extends UsageLimitHostContext<M>>(
  pi: UsageLimitHost<M, C>,
  state: ControllerState<M, C>,
  recovery: RecoveryManager<M, C>,
  session: OwnerSession<C>,
  ctx: C,
  inFlight: InFlightSwitch<M>,
): Promise<void> {
  for (let restores = 0; restores < MAX_SELECTION_RESTORES; restores += 1) {
    const selection = inFlight.userSelection;
    if (!selection || !recovery.isCurrent(session.sessionId, session.generation)) return;
    const key = `${selection.model.provider}/${selection.model.id}`;
    if (modelKey(ctx.model) === key) return;
    state.selfSelecting = key;
    let restored: boolean;
    try {
      restored = await pi.setModel(selection.model);
    } catch (error) {
      if (isStaleContextError(error)) throw error;
      restored = false;
    } finally {
      if (state.selfSelecting === key) state.selfSelecting = undefined;
    }
    if (!recovery.isCurrent(session.sessionId, session.generation)) return;
    if (!restored) {
      notify(
        ctx,
        `Could not restore your model selection ${key} after an automatic usage-limit switch; use /model to switch.`,
        "warning",
      );
      return;
    }
    if (inFlight.userSelection === selection) {
      if (pi.getThinkingLevel() !== selection.thinkingLevel) {
        pi.setThinkingLevel(selection.thinkingLevel);
      }
      return;
    }
  }
}

export async function switchToFallback<
  M extends UsageLimitModel,
  C extends UsageLimitHostContext<M>,
>(
  pi: UsageLimitHost<M, C>,
  deps: UsageLimitControllerDeps<C>,
  state: ControllerState<M, C>,
  recovery: RecoveryManager<M, C>,
  session: OwnerSession<C>,
  ctx: C,
  limited: ModelRef,
  classification: UsageLimitClassification,
  live: () => boolean,
): Promise<boolean> {
  if (state.fallbackSwitches >= MAX_FALLBACK_SWITCHES) return false;
  const { policy } = session;
  await policy.fallbacksLoaded;
  if (!live()) return false;
  const providers = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider));
  await Promise.all([...providers].map((provider) => recovery.lookupAccountId(session, provider)));
  if (!live()) return false;
  const current: ModelRef = ctx.model ?? limited;
  const scoped = ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`);
  const rejected = new Set<string>();
  const isClosed = (provider: string, accountId: string, modelId?: string): boolean =>
    (provider === limited.provider &&
      (modelId === undefined || scopeCoversModel(classification.scope, modelId))) ||
    policy.isClosed(provider, accountId, undefined, modelId);
  for (;;) {
    const available = ctx.modelRegistry
      .getAvailable()
      .filter((model) => !rejected.has(`${model.provider}/${model.id}`));
    const pick = policy.pickFallback(current, { available, scoped, isClosed });
    if (!pick) return false;
    const key = `${pick.provider}/${pick.id}`;
    rejected.add(key);
    const model = available.find(
      (candidate) => candidate.provider === pick.provider && candidate.id === pick.id,
    );
    if (!model) continue;
    const thinkingLevel = pi.getThinkingLevel();
    const inFlight: InFlightSwitch<M> = {};
    state.selfSelecting = key;
    state.inFlightSwitch = inFlight;
    let switched = false;
    try {
      try {
        switched = await pi.setModel(model);
      } catch (error) {
        if (isStaleContextError(error)) throw error;
      } finally {
        if (state.selfSelecting === key) state.selfSelecting = undefined;
      }
      if (!live()) {
        await restoreUserSelection(pi, state, recovery, session, ctx, inFlight);
        return false;
      }
    } finally {
      if (state.inFlightSwitch === inFlight) state.inFlightSwitch = undefined;
    }
    if (!switched) continue;
    if (pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
    state.fallbackSwitches += 1;
    recovery.sendContinuation(
      `${formatProviderLabel(classification.provider)} usage limit reached${scopeNote(
        classification.scope,
      )} (resets ${formatReset(
        classification.resetAt,
        deps.now(),
      )}). Switched to ${key}. Continue the previous task without repeating completed tool calls.`,
    );
    return true;
  }
}
