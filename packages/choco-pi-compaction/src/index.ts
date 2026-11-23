import type { RetryPolicy } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { hostTriggerOf, withTrigger } from "./trigger.ts";

import { appendLaneRecord } from "./background/lane-journal.ts";
import {
  type BackgroundCompactionOptions,
  createBeforeCompactHandler,
  registerBackgroundCompaction,
} from "./extension.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import {
  guardBeforeLocalSummary,
  installOpaqueBlockProvider,
  type OpaqueGuardAnnounce,
  opaqueLossAuthorized,
} from "./opaque-guard.ts";
import { resolveOwner } from "./ownership.ts";
import {
  type CompactionSessionState,
  type HostCompactionPolicyReader,
  readCodexCompactionSnapshot,
  readHostSettings,
} from "./session-state.ts";

export { RESPONSE_MARGIN_TOKENS } from "./budget.ts";
export {
  COMPACTION_BACKENDS_SYMBOL,
  type CompactionBackendProvider,
  type ForegroundCompactHandler,
  registerCompactionBackendProvider,
} from "./background-host/backend-registry.ts";
export {
  COMPACTION_TOKEN_COUNTERS_SYMBOL,
  type CompactionTokenCounter,
  type CompactionTokenCountOutcome,
  type CompactionTokenCountRequest,
  registerCompactionTokenCounter,
} from "./background-host/token-counter-registry.ts";
export {
  ANTHROPIC_COMPACTION_MODE_KEY,
  type AnthropicCompactionMode,
  DEFAULT_ANTHROPIC_COMPACTION_MODE,
  OPAQUE_HISTORY_KEY,
  readAnthropicCompactionMode,
  writeAnthropicCompactionMode,
} from "./anthropic/mode.ts";
export { bearerCredentialOf } from "./auth.ts";
export {
  appendLaneRecord,
  LANE_RECORD_TYPE,
  type LaneRecord,
  LaneRecordSchema,
  laneRecordsOf,
} from "./background/lane-journal.ts";
export {
  laneMayAnswerOverOpaque,
  lossAuthorizedFor,
  opaqueCheckpointOf,
} from "./opaque-checkpoint.ts";
export {
  DEFAULT_XAI_COMPACTION_MODE,
  readXaiCompactionMode,
  writeXaiCompactionMode,
  XAI_COMPACTION_MODE_KEY,
  type XaiCompactionMode,
} from "./xai/mode.ts";
export {
  type LocalCompactionDetails,
  LocalCompactionDetailsSchema,
  parseLocalCompactionDetails,
} from "./details.ts";
export {
  ANCHOR_ENTRY_TYPE,
  type AdoptionRoute,
  BACKGROUND_ADOPTION_SIGNAL_SYMBOL,
  type BackgroundAdoptionListener,
  type BackgroundAdoptionNotice,
  type BackgroundAdoptionSignal,
  type BackgroundCompaction,
  type BackgroundCompactionOptions,
  CANDIDATE_RECORD_TYPE,
  createBeforeCompactHandler,
  getBackgroundAdoptionSignal,
  readAdoptionIdentity,
  registerBackgroundCompaction,
} from "./extension.ts";
export { EMPTY_NEXT_STEPS, normalizeSummary } from "./normalize.ts";
export {
  type NativeRefreshContext,
  refreshSessionNativeState,
  registerSessionNativeRefresher,
  type SessionNativeRefresher,
} from "./background-host/native-refresh.ts";
export {
  CHILD_OWNER_KEY_PREFIX,
  type CodexCompactionSnapshot,
  type CompactionOwner,
  isChildSession,
  mainOwnerKey,
  ownerKeyFor,
  resolveOwner,
} from "./ownership.ts";
export {
  BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL,
  type BackgroundCompactionPreferencesProvider,
  type BackgroundCompactionPreferencesSection,
  waitForBackgroundCompactionPreferenceChanges,
} from "./preferences-section.ts";
export {
  type CompactionSessionState,
  type HostCompactionPolicy,
  type HostCompactionPolicyReader,
  readCodexCompactionSnapshot,
  readHostSettings,
  readRetryPolicy,
} from "./session-state.ts";
export {
  backgroundCompactionActive,
  backgroundSettingsPaths,
  globalBackgroundSettingsPath,
  isBackendEnabled,
  type LoadedBackgroundSettings,
  loadBackgroundSettings,
  parseBackgroundSettings,
  writeGlobalBackgroundEnabled,
} from "./background/settings.ts";

export interface RegisterCompactionOptions {
  readonly retryPolicy?: RetryPolicy;
  readonly compactionPolicy?: HostCompactionPolicyReader;
  readonly background?: BackgroundCompactionOptions;
}

export default function registerCompaction(
  pi: ExtensionAPI,
  options: RegisterCompactionOptions = {},
): void {
  const injectedRetryPolicy = options.retryPolicy;
  const injectedCompactionPolicy = options.compactionPolicy;
  let state: CompactionSessionState = {
    generation: 0,
    retryPolicy: injectedRetryPolicy,
    codexCompaction: undefined,
    compactionPolicy: injectedCompactionPolicy,
  };
  const readState = (): CompactionSessionState => state;

  pi.on("session_start", async (_event, ctx) => {
    const host = injectedRetryPolicy === undefined ? readHostSettings(ctx.cwd) : undefined;
    const cwd = ctx.cwd;
    const projectTrusted = ctx.isProjectTrusted();
    const generation = state.generation + 1;
    state = {
      generation,
      retryPolicy: injectedRetryPolicy ?? host?.retryPolicy,
      codexCompaction: undefined,
      compactionPolicy: injectedCompactionPolicy ?? host?.compactionPolicy,
    };
    const codexCompaction = await readCodexCompactionSnapshot(cwd, projectTrusted);
    if (state.generation !== generation) return;
    state = { ...state, codexCompaction };
  });
  pi.on("session_shutdown", () => {
    state = { ...state, generation: state.generation + 1 };
  });
  const backgroundOptions = injectedBackgroundOptions(options);
  const background = registerBackgroundCompaction(pi, readState, backgroundOptions);
  const summarize = createBeforeCompactHandler(readState, {
    lossAuthorized: (sessionId, entryId) =>
      opaqueLossAuthorized(background.modes(), sessionId, entryId),
  });
  const announceGuard = guardAnnouncer(pi);
  installOpaqueBlockProvider(pi, { modes: () => background.modes(), announce: announceGuard });
  pi.on("session_before_compact", async (event, ctx) => {
    const answer = await answerBeforeCompact(event, ctx);
    return answer?.compaction === undefined
      ? answer
      : { ...answer, compaction: withTrigger(answer.compaction, hostTriggerOf(event)) };
  });

  async function answerBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined> {
    const adopted = await background.beforeCompact(event, ctx);
    if (adopted !== undefined) return adopted;
    if (await background.childAdopts(event, ctx)) return undefined;
    const native = await background.foregroundCompact(event, ctx);
    if (native !== undefined) return native;
    const modes = background.modes();
    const owner = resolveOwner(ctx, readState().codexCompaction, {
      anthropicServerSide: modes.anthropic === "server-side",
      xaiServerSide: modes.xai === "server-side",
    });
    const guarded = guardBeforeLocalSummary({ modes, owner, announce: announceGuard }, event, ctx);
    if (guarded !== undefined) return guarded;
    const summarized = await summarize(event, ctx);
    return summarized === undefined ? undefined : summarized;
  }
}

function guardAnnouncer(pi: ExtensionAPI): OpaqueGuardAnnounce {
  const show = (ctx: ExtensionContext, text: string): void => {
    try {
      ctx.ui.notify(text, "warning");
    } catch (error) {
      if (!(error instanceof Error && isStaleContextError(error))) throw error;
    }
  };
  return (ctx, record, text) => {
    appendLaneRecord(
      (customType, data) => pi.appendEntry(customType, data),
      { ...record, noticeAttempted: true },
      (message) => show(ctx, message),
    );
    show(ctx, text);
  };
}

function injectedBackgroundOptions(
  options: RegisterCompactionOptions,
): BackgroundCompactionOptions | undefined {
  if (options.retryPolicy === undefined) return options.background;
  const background = options.background ?? { settingsPaths: () => [] };
  const anthropic =
    background.anthropic?.readMode === undefined
      ? { ...background.anthropic, readMode: async () => "choco-pi" as const }
      : background.anthropic;
  const xai =
    background.xai?.readMode === undefined
      ? { ...background.xai, readMode: async () => "choco-pi" as const }
      : background.xai;
  const readOpaqueHistoryMode =
    background.readOpaqueHistoryMode ?? (async () => "preserve" as const);
  return { ...background, anthropic, xai, readOpaqueHistoryMode };
}
