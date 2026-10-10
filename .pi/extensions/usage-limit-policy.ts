/**
 * Root-session "On usage limit" controller. Classifies a run that settled on a
 * provider usage limit and, according to the `agentOnUsageLimit` preference,
 * notifies, switches to a fallback model and continues, or waits for the quota
 * window to reset and continues on the same model. Child sessions stay inert;
 * the subagents manager owns their recovery. Goal mode owns its own recovery.
 */
import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectSource,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_ON_USAGE_LIMIT_KEY,
  onAgentPreferenceChange,
  readAgentPreferencesAsync,
} from "./lib/agent-preferences.ts";
import { isStaleContextError, rethrowUnlessStaleContext } from "./lib/lifecycle.ts";
import { formatProviderLabel } from "../packages/choco-pi-ui/extensions/zentui/model-display.ts";
import type { RuntimeValue } from "./lib/runtime-values.ts";
import { providerAccountId } from "./provider-usage.ts";
import {
  CODEX_USAGE_LIMIT_ENTRY,
  parseCodexUsageLimitEntry,
  parseUsageLimitPendingEntry,
  parseUsageLimitResolvedEntry,
  readChildSessionProbe,
  readGoalRecoveryOwnership,
  registerUsageLimitPolicy,
  USAGE_LIMIT_PENDING_ENTRY,
  USAGE_LIMIT_RESOLVED_ENTRY,
} from "./lib/usage-limit-contract.ts";
import type {
  ChildSessionProbe,
  CodexUsageLimitEntry,
  GoalRecoveryOwnership,
  OnUsageLimit,
  UsageLimitClassification,
  UsageLimitEvidence,
  UsageLimitPendingEntry,
  UsageLimitResolvedEntry,
} from "./lib/usage-limit-contract.ts";
import { createUsageLimitPolicy } from "./lib/usage-limit.ts";
import type {
  SyntheticQuotaEvents,
  UsageLimitPolicyInstance,
  UsageLimitPolicyOptions,
} from "./lib/usage-limit.ts";

export const USAGE_LIMIT_MESSAGE_TYPE = "choco-pi-usage-limit";
export const RESUME_MESSAGE = "Usage window reset; continue the previous task.";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
/** Closure applied when the provider gives no reset estimate. */
export const DEFAULT_CLOSE_MS = 30 * MINUTE_MS;
/** Margin after a reported reset, which providers round down. */
export const RESET_MARGIN_MS = 30 * SECOND_MS;
/** Longest single wait; a wake-up re-checks readiness and re-arms. */
export const MAX_WAIT_MS = 24 * HOUR_MS;
/** Poll interval when no reset time is known. */
export const POLL_INTERVAL_MS = 5 * MINUTE_MS;
/** Longest polling phase without a known reset time. */
export const POLL_LIMIT_MS = 6 * HOUR_MS;
/**
 * Delay before a replayed wait whose reset already passed (or was never known)
 * re-checks readiness. A restart or reload is still settling other extensions,
 * model restore and queued input; the wake-up itself still requires an idle
 * session, the armed model, and corroborated capacity before it continues.
 */
export const REPLAY_GRACE_MS = 5 * SECOND_MS;
/** Fallback switches per interrupted task. */
export const MAX_FALLBACK_SWITCHES = 2;
/** Auto-resume continuations per interrupted task. */
export const MAX_RESUME_ATTEMPTS = 3;
/** Re-applications of a user's model choice after an overwriting automatic switch. */
const MAX_SELECTION_RESTORES = 3;
/** Account key used until a provider's account id is known. */
const DEFAULT_ACCOUNT_ID = "default";
/**
 * Providers whose account id derives from the stored credential alone. Anthropic
 * needs a profile request, so it is resolved only once a limit makes it matter.
 */
const LOCAL_ACCOUNT_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex", "synthetic"]);

export type TimerHandle = { cancel(): void };

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** A model the controller reads and switches to. */
export type UsageLimitModel = { readonly provider: string; readonly id: string };

/** The `ExtensionContext` members the controller reads; `ExtensionContext` satisfies it. */
export type UsageLimitHostContext<M extends UsageLimitModel> = {
  readonly hasUI: boolean;
  readonly ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  readonly sessionManager: { getSessionId(): string; getBranch(): SessionEntry[] };
  readonly modelRegistry: { getAvailable(): M[] };
  readonly model: M | undefined;
  readonly scopedModels: readonly { readonly model: M }[];
  isIdle(): boolean;
  hasPendingMessages(): boolean;
};

/** The event fields the controller reads, by event name. */
export type UsageLimitHostEvents<M extends UsageLimitModel> = {
  session_start: { readonly type: "session_start"; readonly reason: SessionStartEvent["reason"] };
  session_shutdown: {
    readonly type: "session_shutdown";
    readonly reason: SessionShutdownEvent["reason"];
  };
  session_before_tree: { readonly type: "session_before_tree" };
  session_tree: { readonly type: "session_tree" };
  before_agent_start: { readonly type: "before_agent_start" };
  agent_start: { readonly type: "agent_start" };
  model_select: {
    readonly type: "model_select";
    readonly model: M;
    readonly source: ModelSelectSource;
  };
  agent_settled: { readonly type: "agent_settled" };
};

type HostHandler<Event, C> = (event: Event, ctx: C) => Promise<void> | void;
type HostEvent<
  M extends UsageLimitModel,
  Name extends keyof UsageLimitHostEvents<M>,
> = UsageLimitHostEvents<M>[Name];

/** The `ExtensionAPI` members the controller uses; `ExtensionAPI` satisfies it. */
export interface UsageLimitHost<M extends UsageLimitModel, C extends UsageLimitHostContext<M>> {
  on(event: "session_start", handler: HostHandler<HostEvent<M, "session_start">, C>): () => void;
  on(
    event: "session_shutdown",
    handler: HostHandler<HostEvent<M, "session_shutdown">, C>,
  ): () => void;
  on(
    event: "session_before_tree",
    handler: HostHandler<HostEvent<M, "session_before_tree">, C>,
  ): () => void;
  on(event: "session_tree", handler: HostHandler<HostEvent<M, "session_tree">, C>): () => void;
  on(
    event: "before_agent_start",
    handler: HostHandler<HostEvent<M, "before_agent_start">, C>,
  ): () => void;
  on(event: "agent_start", handler: HostHandler<HostEvent<M, "agent_start">, C>): () => void;
  on(event: "model_select", handler: HostHandler<HostEvent<M, "model_select">, C>): () => void;
  on(event: "agent_settled", handler: HostHandler<HostEvent<M, "agent_settled">, C>): () => void;
  readonly events: SyntheticQuotaEvents;
  appendEntry(customType: string, data: UsageLimitPendingEntry | UsageLimitResolvedEntry): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { triggerTurn: boolean },
  ): void;
  setModel(model: M): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
}

/** A preference write: the key written and the value stored. */
export type UsageLimitPreferenceChange = { readonly key: string; readonly value?: unknown };

export type UsageLimitControllerPolicyOptions<C> = Omit<UsageLimitPolicyOptions, "ctx"> & {
  ctx: C;
};

export type UsageLimitControllerDeps<C> = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => TimerHandle;
  createId: () => string;
  readPreference: () => Promise<OnUsageLimit>;
  createPolicy: (options: UsageLimitControllerPolicyOptions<C>) => UsageLimitPolicyInstance;
  readProbe: () => ChildSessionProbe | undefined;
  /** Goal recovery ownership for the root session `owner`. */
  readGoalOwnership: (owner: string) => GoalRecoveryOwnership | undefined;
  /** Stable account id of `provider`; resolves `undefined` when unknown and never rejects. */
  lookupAccountId: (ctx: C, provider: string) => Promise<string | undefined>;
  /** Subscribes to agent preference writes; returns the unsubscribe. */
  onPreferenceChange: (listener: (change: UsageLimitPreferenceChange) => void) => () => void;
};

function scheduleUnrefTimer(callback: () => void, delayMs: number): TimerHandle {
  const timer = setTimeout(callback, Math.max(0, delayMs));
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

async function readOnUsageLimitPreference(): Promise<OnUsageLimit> {
  return (await readAgentPreferencesAsync()).onUsageLimit;
}

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

type OwnerSession<C> = {
  sessionId: string;
  generation: number;
  ctx: C;
  policy: UsageLimitPolicyInstance;
  unregister: () => void;
  /** Resolved account ids by provider; the policy's synchronous resolver reads it. */
  accountIds: Map<string, string>;
  /** In-flight or settled lookups by provider; a lookup that found nothing is dropped. */
  accountLookups: Map<string, Promise<void>>;
};

type Recovery = {
  recoveryId: string;
  sessionId: string;
  generation: number;
  modelKey: string;
  /** Preference the wait was armed under; rewriting the same value keeps it. */
  mode: OnUsageLimit;
  classification: UsageLimitClassification;
  accountId: string;
  attempts: number;
  resetAt?: number;
  pollDeadline?: number;
  timer?: TimerHandle;
  /** Set once the durable resolved entry is written; a recovery resolves at most once. */
  resolved?: boolean;
};

/** An automatic model switch awaiting the host, and the user's choice made meanwhile. */
type InFlightSwitch<M> = {
  userSelection?: { model: M; thinkingLevel: ThinkingLevel };
};

type ControllerState<M, C> = {
  generation: number;
  /**
   * Bumped synchronously by every event that cancels recovery (user turn, user
   * model change, preference change, tree navigation, session start/shutdown).
   * An async decision that snapshotted an older value performs no side effect.
   */
  operation: number;
  session?: OwnerSession<C>;
  recovery?: Recovery;
  fallbackSwitches: number;
  resumeAttempts: number;
  handledEntryId?: string;
  selfSelecting?: string;
  inFlightSwitch?: InFlightSwitch<M>;
  ownTurnPending: boolean;
  unsubscribePreference?: () => void;
};

type ModelRef = { provider: string; id: string };

function modelKey(model: ModelRef | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

type LimitedTurn = { entryId: string; message: AssistantMessage };

/** The last message entry on the branch, when it is an assistant message. */
function lastAssistantTurn(branch: readonly SessionEntry[]): LimitedTurn | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    return message.role === "assistant" ? { entryId: entry.id, message } : undefined;
  }
  return undefined;
}

function latestCodexEntry(branch: readonly SessionEntry[]): CodexUsageLimitEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== CODEX_USAGE_LIMIT_ENTRY) continue;
    const parsed = parseCodexUsageLimitEntry(entry.data);
    if (parsed) return parsed;
  }
  return undefined;
}

/** A persisted pending recovery and when its entry was written (epoch ms, when parseable). */
type PendingRecord = { pending: UsageLimitPendingEntry; recordedAt?: number };

function latestUnresolvedPending(branch: readonly SessionEntry[]): PendingRecord | undefined {
  const resolved = new Set<string>();
  let latest: PendingRecord | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === USAGE_LIMIT_PENDING_ENTRY) {
      const pending = parseUsageLimitPendingEntry(entry.data);
      if (!pending) continue;
      const recordedAt = Date.parse(entry.timestamp);
      latest = Number.isFinite(recordedAt) ? { pending, recordedAt } : { pending };
    } else if (entry.customType === USAGE_LIMIT_RESOLVED_ENTRY) {
      const parsed = parseUsageLimitResolvedEntry(entry.data);
      if (parsed) resolved.add(parsed.recoveryId);
    }
  }
  return latest && !resolved.has(latest.pending.recoveryId) ? latest : undefined;
}

/** Latest pending recovery on the branch that no resolved entry closes. */
export function unresolvedPendingEntry(
  branch: readonly SessionEntry[],
): UsageLimitPendingEntry | undefined {
  return latestUnresolvedPending(branch)?.pending;
}

export function formatReset(resetAt: number | undefined, now: number): string {
  if (resetAt === undefined) return "at an unknown time";
  const minutes = Math.max(1, Math.ceil((resetAt - now) / MINUTE_MS));
  if (minutes < 90) return `in ~${minutes}m`;
  return `in ~${Math.round((minutes / 60) * 10) / 10}h`;
}

type NotifyTarget = Pick<UsageLimitHostContext<UsageLimitModel>, "hasUI" | "ui">;

function notify(ctx: NotifyTarget, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isInterruptedByLimit(message: AssistantMessage): boolean {
  return message.stopReason === "error";
}

function isSuccessfulStop(message: AssistantMessage): boolean {
  return (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse"
  );
}

/** A fresh reading showing capacity makes a limit transient for every preference. */
function hasCapacity(evidence: UsageLimitEvidence): boolean {
  return evidence === "capacity";
}

async function contained(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    rethrowUnlessStaleContext(error);
  }
}

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

  /** Synchronously invalidates every in-flight settle decision and wake-up. */
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

  const resolveRecovery = (recovery: Recovery, outcome: UsageLimitResolvedEntry["outcome"]) => {
    recovery.timer?.cancel();
    recovery.timer = undefined;
    if (state.recovery === recovery) state.recovery = undefined;
    if (recovery.resolved) return;
    recovery.resolved = true;
    const entry: UsageLimitResolvedEntry = { recoveryId: recovery.recoveryId, outcome };
    pi.appendEntry(USAGE_LIMIT_RESOLVED_ENTRY, entry);
  };

  /** Resolves the live recovery as cancelled when it belongs to `sessionId` (default: owner). */
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

  /** Resolves `provider`'s account id once per session; never rejects. */
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

  /**
   * Closes the limited provider under the account id candidate checks resolve,
   * and under the structured id when the provider reported a different one.
   */
  const closeLimitedAccount = (
    session: OwnerSession<C>,
    classification: UsageLimitClassification,
    untilMs: number,
  ): void => {
    const accountIds = new Set([accountIdFor(session, classification.provider)]);
    if (classification.accountId !== undefined) accountIds.add(classification.accountId);
    for (const accountId of accountIds) {
      session.policy.closeProvider(classification.provider, accountId, untilMs);
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

  /** Writes the durable pending entry for a new recovery attempt and returns its ids. */
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
      `${formatProviderLabel(classification.provider)} ${classification.kind} limit reached; resets ${formatReset(
        classification.resetAt,
        deps.now(),
      )}. ${suffix}`,
      "warning",
    );
  };

  /**
   * Re-applies the model the user chose while an automatic switch awaited the
   * host, when that switch landed afterwards and overwrote it. Tagged as the
   * controller's own selection, so it cancels nothing.
   */
  const restoreUserSelection = async (
    session: OwnerSession<C>,
    ctx: C,
    inFlight: InFlightSwitch<M>,
  ): Promise<void> => {
    for (let restores = 0; restores < MAX_SELECTION_RESTORES; restores += 1) {
      const selection = inFlight.userSelection;
      if (!selection || !isCurrent(session.sessionId, session.generation)) return;
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
      if (!isCurrent(session.sessionId, session.generation)) return;
      if (!restored) {
        notify(
          ctx,
          `Could not restore your model selection ${key} after an automatic usage-limit switch; use /model to switch.`,
          "warning",
        );
        return;
      }
      // A newer user choice made during the restore takes another pass.
      if (inFlight.userSelection === selection) {
        if (pi.getThinkingLevel() !== selection.thinkingLevel) {
          pi.setThinkingLevel(selection.thinkingLevel);
        }
        return;
      }
    }
  };

  /**
   * Returns true when the session switched model and a continuation was sent.
   * `live` reports whether the settle decision is still current; it is checked
   * after every await, so no model switch follows a cancellation. A user model
   * choice made while `setModel` awaited the host is restored if the automatic
   * switch overwrote it.
   */
  const switchToFallback = async (
    session: OwnerSession<C>,
    ctx: C,
    limited: ModelRef,
    classification: UsageLimitClassification,
    live: () => boolean,
  ): Promise<boolean> => {
    if (state.fallbackSwitches >= MAX_FALLBACK_SWITCHES) return false;
    const { policy } = session;
    await policy.fallbacksLoaded;
    if (!live()) return false;
    // Candidate checks read account ids synchronously; resolve every candidate provider first.
    const providers = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider));
    await Promise.all([...providers].map((provider) => lookupAccountId(session, provider)));
    if (!live()) return false;
    const current: ModelRef = ctx.model ?? limited;
    const scoped = ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`);
    const rejected = new Set<string>();
    const isClosed = (provider: string, accountId: string): boolean =>
      provider === limited.provider || policy.isClosed(provider, accountId);
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
          await restoreUserSelection(session, ctx, inFlight);
          return false;
        }
      } finally {
        if (state.inFlightSwitch === inFlight) state.inFlightSwitch = undefined;
      }
      if (!switched) continue;
      if (pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
      state.fallbackSwitches += 1;
      sendContinuation(
        `${formatProviderLabel(classification.provider)} usage limit reached (resets ${formatReset(
          classification.resetAt,
          deps.now(),
        )}). Switched to ${key}. Continue the previous task without repeating completed tool calls.`,
      );
      return true;
    }
  };

  const onSettled = async (ctx: C): Promise<void> => {
    const session = state.session;
    if (!session) return;
    const { sessionId, generation, policy } = session;
    const operation = state.operation;
    const live = (): boolean => isCurrent(sessionId, generation) && state.operation === operation;
    session.ctx = ctx;
    const turn = lastAssistantTurn(ctx.sessionManager.getBranch());

    if (state.recovery) {
      const recovery = state.recovery;
      const preference = await policy.preference();
      if (!live()) return;
      if (preference !== "auto-resume" && state.recovery === recovery) {
        resolveRecovery(recovery, "cancelled");
      }
    }

    if (!turn || turn.entryId === state.handledEntryId) return;
    const { message } = turn;
    if (isSuccessfulStop(message)) {
      state.handledEntryId = turn.entryId;
      resetBudgets();
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
    // Tags the failure as this session's, so the policy may read this branch's provider entries.
    const classified: UsageLimitClassification = { ...rawClassified, sessionId };

    if (deps.readGoalOwnership(sessionId)) {
      notifyLimit(ctx, classified, "Goal recovery owns the resume.");
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
    await lookupAccountId(session, classification.provider);
    if (!live()) return;
    if (!corroborated.ready) {
      closeLimitedAccount(
        session,
        classification,
        classification.resetAt ?? deps.now() + DEFAULT_CLOSE_MS,
      );
    }

    const limited: ModelRef = { provider: message.provider, id: message.model };
    if (preference === "fallback") {
      if (await switchToFallback(session, ctx, limited, classification, live)) return;
      if (!live()) return;
      notifyLimit(ctx, classification, "No fallback model available; use /model to switch.");
      return;
    }
    if (
      preference === "auto-resume" &&
      classification.kind === "quota" &&
      evidence !== "confirmed"
    ) {
      notifyLimit(
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
        if (armed && isCurrentRecovery(armed)) {
          // The still-armed wait is this attempt's recovery; it resolves once, as exhausted.
          resolveRecovery(armed, "exhausted");
        } else {
          // Earlier attempts already resolved; this attempt gets its own recovery id.
          const { recoveryId } = writePending(session, classification, attempts, turn.entryId);
          const entry: UsageLimitResolvedEntry = { recoveryId, outcome: "exhausted" };
          pi.appendEntry(USAGE_LIMIT_RESOLVED_ENTRY, entry);
        }
        notifyLimit(ctx, classification, "Auto-resume retries exhausted; use /model to switch.");
        return;
      }
      // A limit hit by another turn while already waiting keeps the armed wake-up.
      if (state.recovery) return;
      const armedModel = modelKey(ctx.model) ?? `${limited.provider}/${limited.id}`;
      arm(session, classification, armedModel, attempts, turn.entryId);
      notifyLimit(ctx, classification, "Waiting for the reset, then continuing automatically.");
      return;
    }
    notifyLimit(ctx, classification, "Use /model to switch.");
  };

  /**
   * Re-arms the wait an earlier process, reload or session switch left pending
   * on this branch. Shutdown detaches without resolving, so the entry is the
   * durable record. A future reset waits for it; a passed or unknown reset
   * re-checks after `REPLAY_GRACE_MS`, with polling bounded from the original
   * reset (or from when the entry was written), so restarts never extend it.
   * The current preference is re-read; anything but auto-resume cancels.
   */
  const replay = async (session: OwnerSession<C>, ctx: C): Promise<void> => {
    const record = latestUnresolvedPending(ctx.sessionManager.getBranch());
    if (!record) return;
    const { pending, recordedAt } = record;
    // A fork or clone copies the entry under a new session id; only the writer replays it.
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
    // Armed before the read, so a cancelling event during it resolves this recovery normally.
    const preference = await session.policy.preference();
    if (!isCurrentRecovery(recovery)) return;
    if (preference !== "auto-resume") resolveRecovery(recovery, "cancelled");
  };

  /**
   * A write to the usage-limit preference invalidates every decision taken under
   * the old one. Rewriting the mode an armed wait runs under changes nothing.
   */
  const onPreferenceChanged = (change: UsageLimitPreferenceChange): void => {
    if (change.key !== AGENT_ON_USAGE_LIMIT_KEY) return;
    if (state.recovery && change.value === state.recovery.mode) return;
    interrupt();
    try {
      cancelRecovery();
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
      // Detach without resolving: the pending entry stays durable and replay re-adopts it.
      invalidate();
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
        void lookupAccountId(session, provider);
      }
      if (event.reason === "startup" || event.reason === "reload" || event.reason === "resume") {
        await replay(session, ctx);
      }
    }),
  );

  // Quit, reload and session switch only detach: timers stop, but no resolved
  // entry is written, so the next start of this session replays the wait.
  pi.on("session_shutdown", () =>
    contained(() => {
      unsubscribePreference();
      invalidate();
    }),
  );

  // The host moves the leaf between these events, so the resolved entry is
  // written before the switch, on the branch that holds the pending entry.
  pi.on("session_before_tree", () =>
    contained(() => {
      interrupt();
      cancelRecovery();
    }),
  );

  pi.on("session_tree", () => contained(() => interrupt()));

  pi.on("before_agent_start", () =>
    contained(() => {
      if (state.ownTurnPending) {
        state.ownTurnPending = false;
        return;
      }
      interrupt();
      cancelRecovery();
      resetBudgets();
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
      interrupt();
      cancelRecovery();
    }),
  );

  pi.on("agent_settled", (_event, ctx) => contained(() => onSettled(ctx)));
}

/**
 * Whether this runtime belongs to a subagent child session. A probe that throws
 * counts as a child so the controller never switches models inside one.
 */
function isChildSession(
  readProbe: () => ChildSessionProbe | undefined,
  sessionId: string | undefined,
): boolean {
  try {
    const probe = readProbe();
    if (!probe) return false;
    if (probe.isChildSessionContext()) return true;
    return sessionId !== undefined && probe.isChildSessionId(sessionId);
  } catch {
    return true;
  }
}

export default function usageLimitPolicy(pi: ExtensionAPI): void {
  registerUsageLimitController<Model<Api>, ExtensionContext>(pi, DEFAULT_DEPS);
}
