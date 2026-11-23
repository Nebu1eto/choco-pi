import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ModelSelectSource,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ChildSessionProbe,
  GoalRecoveryOwnership,
  OnUsageLimit,
  UsageLimitClassification,
  UsageLimitPendingEntry,
  UsageLimitResolvedEntry,
} from "../usage-limit-contract.ts";
import type {
  SyntheticQuotaEvents,
  UsageLimitPolicyInstance,
  UsageLimitPolicyOptions,
} from "../usage-limit.ts";

export const USAGE_LIMIT_MESSAGE_TYPE = "choco-pi-usage-limit";
export const RESUME_MESSAGE = "Usage window reset; continue the previous task.";

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DEFAULT_CLOSE_MS = 30 * MINUTE_MS;
export const RESET_MARGIN_MS = 30 * SECOND_MS;
export const MAX_WAIT_MS = 24 * HOUR_MS;
export const POLL_INTERVAL_MS = 5 * MINUTE_MS;
export const POLL_LIMIT_MS = 6 * HOUR_MS;
export const REPLAY_GRACE_MS = 5 * SECOND_MS;
export const MAX_FALLBACK_SWITCHES = 2;
export const MAX_RESUME_ATTEMPTS = 3;
export const MAX_SELECTION_RESTORES = 3;
export const DEFAULT_ACCOUNT_ID = "default";
export const LOCAL_ACCOUNT_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex", "synthetic"]);

export type TimerHandle = { cancel(): void };

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type UsageLimitModel = { readonly provider: string; readonly id: string };

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

export type UsageLimitHostEvents<M extends UsageLimitModel> = {
  session_start: { readonly type: "session_start"; readonly reason: SessionStartEvent["reason"] };
  session_shutdown: {
    readonly type: "session_shutdown";
    readonly reason: SessionShutdownEvent["reason"];
  };
  session_before_tree: { readonly type: "session_before_tree" };
  session_tree: { readonly type: "session_tree" };
  before_agent_start: {
    readonly type: "before_agent_start";
    readonly messageType: "user" | "custom";
  };
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
  readGoalOwnership: (owner: string) => GoalRecoveryOwnership | undefined;
  lookupAccountId: (ctx: C, provider: string) => Promise<string | undefined>;
  onPreferenceChange: (listener: (change: UsageLimitPreferenceChange) => void) => () => void;
};

export type OwnerSession<C> = {
  sessionId: string;
  generation: number;
  ctx: C;
  policy: UsageLimitPolicyInstance;
  unregister: () => void;
  accountIds: Map<string, string>;
  accountLookups: Map<string, Promise<void>>;
};

export type Recovery = {
  recoveryId: string;
  sessionId: string;
  generation: number;
  modelKey: string;
  mode: OnUsageLimit;
  classification: UsageLimitClassification;
  accountId: string;
  attempts: number;
  resetAt?: number;
  pollDeadline?: number;
  timer?: TimerHandle;
  resolved?: boolean;
};

export type InFlightSwitch<M> = {
  userSelection?: { model: M; thinkingLevel: ThinkingLevel };
};

export type ControllerState<M, C> = {
  generation: number;
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

export type ModelRef = { provider: string; id: string };
export type LimitedTurn = { entryId: string; message: AssistantMessage };
export type PendingRecord = { pending: UsageLimitPendingEntry; recordedAt?: number };
