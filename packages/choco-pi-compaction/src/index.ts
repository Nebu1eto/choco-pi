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
import { isStaleContextError } from "./lifecycle.ts";
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

/** Registration options. Production registers with none of them. */
export interface RegisterCompactionOptions {
  /**
   * Retry policy to use instead of the session's settings. Tests inject one so
   * they never read the developer's real settings; production leaves it unset
   * and the policy comes from the host settings at `session_start`.
   */
  readonly retryPolicy?: RetryPolicy;
  /**
   * Host compaction cut policy to use instead of the session's settings
   * (tests). Only consulted when `retryPolicy` is injected too, so injected
   * registrations never read real settings.
   */
  readonly compactionPolicy?: HostCompactionPolicyReader;
  /** Background-compaction seams (tests). */
  readonly background?: BackgroundCompactionOptions;
}

/**
 * Compaction reconciliation extension.
 *
 * Pi's default summarizer only receives the messages compaction is about to
 * discard, so evidence of completed work that lives in the retained recent
 * tail never reaches it and the checkpoint can report finished work as still
 * pending. This extension takes over `session_before_compact` for locally
 * summarized models and feeds the summarizer the tail as current-state
 * evidence alongside the discarded history.
 *
 * The generation counter is per registration, not per process: a session
 * start or shutdown invalidates any compaction still awaiting a provider
 * response, so a late result can never be committed onto a different session.
 *
 * `session_start` also resolves the two configuration snapshots the handler
 * needs — the summarization retry policy and codex's native-compaction
 * settings — so no configuration file is read on the compaction path.
 *
 * Background compaction (on by default) is wired by
 * `registerBackgroundCompaction`; a ready background candidate answers
 * `session_before_compact` before the summarizer runs.
 */
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

  pi.on("session_start", (_event, ctx) => {
    const host = injectedRetryPolicy === undefined ? readHostSettings(ctx.cwd) : undefined;
    state = {
      generation: state.generation + 1,
      retryPolicy: injectedRetryPolicy ?? host?.retryPolicy,
      codexCompaction: readCodexCompactionSnapshot(ctx.cwd, ctx.isProjectTrusted()),
      compactionPolicy: injectedCompactionPolicy ?? host?.compactionPolicy,
    };
  });
  pi.on("session_shutdown", () => {
    state = { ...state, generation: state.generation + 1 };
  });
  const backgroundOptions = injectedBackgroundOptions(options);
  const background = registerBackgroundCompaction(pi, readState, backgroundOptions);
  // The summarizer honors the same loss authorization as the guard (setting or consent).
  const summarize = createBeforeCompactHandler(readState, {
    lossAuthorized: (sessionId, entryId) =>
      opaqueLossAuthorized(background.modes(), sessionId, entryId),
  });
  const announceGuard = guardAnnouncer(pi);
  // Registered after the background handlers, so the overlay wraps the capture transports
  // that a session start registers; every `context` event re-checks it before a request.
  installOpaqueBlockProvider(pi, { modes: () => background.modes(), announce: announceGuard });
  pi.on("session_before_compact", async (event, ctx) => {
    const answer = await answerBeforeCompact(event, ctx);
    // Every checkpoint this extension answers carries what started it; a
    // producer that set its own trigger (a background adoption) keeps it.
    return answer?.compaction === undefined
      ? answer
      : { ...answer, compaction: withTrigger(answer.compaction, hostTriggerOf(event)) };
  });

  async function answerBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined> {
    // A ready, still-valid background candidate replaces the summarizer.
    const adopted = await background.beforeCompact(event, ctx);
    if (adopted !== undefined) return adopted;
    // A child's runner bridge commits its own adoption after this handler.
    if (await background.childAdopts(event, ctx)) return undefined;
    // Anthropic or xAI server-side compaction (main and child sessions). Unconfigured,
    // unadmitted or failed attempts fall through to the summarizer; a cancelled or
    // auth-failed one answers { cancel: true } so the host reports the failure.
    // The summarizer is the last resort, so precedence stays: background, child, native, local.
    const native = await background.foregroundCompact(event, ctx);
    if (native !== undefined) return native;
    // Over an opaque checkpoint no summarizer may answer without authorized loss (D2).
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

/** Journal a guard record on the session and show its notice; only stale contexts are contained. */
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

/**
 * Injected registrations (tests) never read real background settings or the
 * real Anthropic or xAI compaction mode: unless a test supplies its own
 * reader, each mode is the local summarizer ("choco-pi").
 */
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
  // Nor the real opaque-history setting: tests get the default unless they inject a reader.
  const readOpaqueHistoryMode =
    background.readOpaqueHistoryMode ?? (async () => "preserve" as const);
  return { ...background, anthropic, xai, readOpaqueHistoryMode };
}
