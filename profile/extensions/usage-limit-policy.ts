import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_ON_USAGE_LIMIT_KEY, onAgentPreferenceChange } from "./lib/agent-preferences.ts";
import { rethrowUnlessStaleContext } from "./lib/lifecycle.ts";
import { providerAccountId } from "./provider-usage.ts";
import {
  readChildSessionProbe,
  readGoalRecoveryOwnership,
  registerUsageLimitPolicy,
} from "./lib/usage-limit-contract.ts";
import { createUsageLimitPolicy } from "./lib/usage-limit.ts";
import {
  contained,
  isChildSession,
  latestCodexEntry,
  modelKey,
  readOnUsageLimitPreference,
  scheduleUnrefTimer,
} from "./lib/usage-limit-policy/helpers.ts";
import { createRecoveryManager } from "./lib/usage-limit-policy/recovery.ts";
import { createSettleHandler } from "./lib/usage-limit-policy/settle.ts";
import {
  DEFAULT_ACCOUNT_ID,
  LOCAL_ACCOUNT_PROVIDERS,
  type ControllerState,
  type OwnerSession,
  type UsageLimitControllerDeps,
  type UsageLimitHost,
  type UsageLimitHostContext,
  type UsageLimitModel,
  type UsageLimitPreferenceChange,
} from "./lib/usage-limit-policy/types.ts";

export { formatReset, unresolvedPendingEntry } from "./lib/usage-limit-policy/helpers.ts";
export {
  DEFAULT_CLOSE_MS,
  MAX_FALLBACK_SWITCHES,
  MAX_RESUME_ATTEMPTS,
  MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  POLL_LIMIT_MS,
  REPLAY_GRACE_MS,
  RESET_MARGIN_MS,
  RESUME_MESSAGE,
  USAGE_LIMIT_MESSAGE_TYPE,
  type TimerHandle,
  type UsageLimitControllerDeps,
  type UsageLimitControllerPolicyOptions,
  type UsageLimitHost,
  type UsageLimitHostContext,
  type UsageLimitHostEvents,
  type UsageLimitModel,
  type UsageLimitPreferenceChange,
} from "./lib/usage-limit-policy/types.ts";

const DEFAULT_DEPS: UsageLimitControllerDeps<ExtensionContext> = {
  now: Date.now,
  schedule: scheduleUnrefTimer,
  createId: randomUUID,
  readPreference: readOnUsageLimitPreference,
  createPolicy: createUsageLimitPolicy,
  readProbe: readChildSessionProbe,
  readGoalOwnership: readGoalRecoveryOwnership,
  lookupAccountId: providerAccountId,
  onPreferenceChange: onAgentPreferenceChange,
};

export function registerUsageLimitController<
  M extends UsageLimitModel,
  C extends UsageLimitHostContext<M>,
>(pi: UsageLimitHost<M, C>, deps: UsageLimitControllerDeps<C>): void {
  if (isChildSession(deps.readProbe, undefined)) return;

  const state: ControllerState<M, C> = {
    generation: 0,
    operation: 0,
    fallbackSwitches: 0,
    resumeAttempts: 0,
    ownTurnPending: false,
  };

  const recovery = createRecoveryManager(pi, deps, state);
  const onSettled = createSettleHandler(pi, deps, state, recovery);

  const onPreferenceChanged = (change: UsageLimitPreferenceChange): void => {
    if (change.key !== AGENT_ON_USAGE_LIMIT_KEY) return;
    if (state.recovery && change.value === state.recovery.mode) return;
    recovery.interrupt();
    try {
      recovery.cancelRecovery();
    } catch (error) {
      rethrowUnlessStaleContext(error);
    }
  };

  const unsubscribePreference = (): void => {
    const unsubscribe = state.unsubscribePreference;
    state.unsubscribePreference = undefined;
    unsubscribe?.();
  };

  pi.on("session_start", (event, ctx) =>
    contained(async () => {
      const sessionId = ctx.sessionManager.getSessionId();
      recovery.invalidate();
      if (isChildSession(deps.readProbe, sessionId)) {
        unsubscribePreference();
        return;
      }
      state.unsubscribePreference ??= deps.onPreferenceChange(onPreferenceChanged);
      const generation = state.generation;
      const accountIds = new Map<string, string>();
      const policy = deps.createPolicy({
        owner: sessionId,
        generation,
        readPreference: deps.readPreference,
        readCodexEntry: () => latestCodexEntry(ctx.sessionManager.getBranch()),
        events: pi.events,
        ctx,
        now: deps.now,
        resolveAccountId: (provider) => accountIds.get(provider) ?? DEFAULT_ACCOUNT_ID,
      });
      const session: OwnerSession<C> = {
        sessionId,
        generation,
        ctx,
        policy,
        unregister: registerUsageLimitPolicy(policy),
        accountIds,
        accountLookups: new Map(),
      };
      state.session = session;
      const provider = ctx.model?.provider;
      if (provider !== undefined && LOCAL_ACCOUNT_PROVIDERS.has(provider)) {
        void recovery.lookupAccountId(session, provider);
      }
      if (event.reason === "startup" || event.reason === "reload" || event.reason === "resume") {
        await recovery.replay(session, ctx);
      }
    }),
  );

  pi.on("session_shutdown", () =>
    contained(() => {
      unsubscribePreference();
      recovery.invalidate();
    }),
  );

  pi.on("session_before_tree", () =>
    contained(() => {
      recovery.interrupt();
      recovery.cancelRecovery();
    }),
  );

  pi.on("session_tree", () => contained(() => recovery.interrupt()));

  pi.on("before_agent_start", (event) =>
    contained(() => {
      if (state.ownTurnPending) {
        state.ownTurnPending = false;
        return;
      }
      if (event.messageType !== "user") return;
      recovery.interrupt();
      recovery.cancelRecovery();
      recovery.resetBudgets();
    }),
  );

  pi.on("agent_start", () => {
    state.ownTurnPending = false;
  });

  pi.on("model_select", (event) =>
    contained(() => {
      if (modelKey(event.model) === state.selfSelecting) return;
      if (event.source === "restore") return;
      const inFlight = state.inFlightSwitch;
      if (inFlight) {
        inFlight.userSelection = { model: event.model, thinkingLevel: pi.getThinkingLevel() };
      }
      recovery.interrupt();
      recovery.cancelRecovery();
    }),
  );

  pi.on("agent_settled", (_event, ctx) => contained(() => onSettled(ctx)));
}

export default function usageLimitPolicy(pi: ExtensionAPI): void {
  registerUsageLimitController<Model<Api>, ExtensionContext>(pi, DEFAULT_DEPS);
}
