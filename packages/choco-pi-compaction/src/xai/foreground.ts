/**
 * Foreground xAI server-side compaction.
 *
 * Answers the host's own `session_before_compact` for an admitted Grok model
 * with an opaque compaction item from `POST /v1/responses/compact`, cut at the
 * latest legal wire position at or before the host's cut. A failure returns
 * undefined so the local summarizer answers the same compaction; a manual
 * (`/compact`) fallback is reported every time, an automatic one once per
 * session and transition. A successful attempt that forwarded a `/compact`
 * focus is journaled silently (`instructions-forwarded`). A cancelled or auth-failed attempt
 * instead answers `{ cancel: true }` so the host reports the failure
 * (`foreground-failure.ts`); a combination still cooling down after an auth
 * failure (`auth-cooling`, the gate's verdict, no credential read failed now)
 * falls back with a notice instead. One attempt. Runs in main and subagent
 * child sessions alike, reading only its own context and session state.
 * Fallbacks, cancels and a resumed checkpoint without captures are journaled
 * through the optional `announce` seam.
 */
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import type { AnthropicCapabilityGate } from "../anthropic/capability.ts";
import type { AnthropicServerSideSession } from "../anthropic/mode.ts";
import type { FailureReason, PreparationBudget, ProviderScope } from "../background/contract.ts";
import { type LaneRoute, ownedReasonOf, REASONS } from "../background/lane-journal.ts";
import type { AnnouncedRecord, NoticeLevel, NoticePolicy } from "../background-host/notices.ts";
import { isStaleContextError } from "../lifecycle.ts";
import {
  SURFACED_FAILURE_RESULT,
  surfacedFailureMessage,
  surfacesForegroundFailure,
} from "../foreground-failure.ts";
import { type CodexCompactionSnapshot, resolveOwner } from "../ownership.ts";
import { capturedSince, latestCompactionId, retainableEntryIds } from "../retained-entries.ts";
import { chooseLegalXaiCutEntry, runXaiCompaction, xaiCaptureMatchesScope } from "./backend.ts";
import { xaiAuthModeFromAuth, xaiGateAdmitsModel } from "./capability.ts";
import type { XaiWireCapture } from "./capture.ts";
import { placeholderSummary } from "./details.ts";
import type { XaiCompactionMode } from "./mode.ts";
import { findActiveXaiCheckpoint } from "./replay.ts";
import { hostTriggerOf, type CompactionTrigger } from "../trigger.ts";

/** Upper bound on one foreground compaction request. */
const FOREGROUND_TIMEOUT_MS = 300_000;
const FOREGROUND_MAX_RESULT_BYTES = 1_048_576;
const NOTICE_PREFIX = "xAI server-side compaction";
/** Bound on the silent-fallback dedupe memo (cleared when reached). */
const MAX_JOURNALED_FALLBACKS = 256;

/**
 * Journal one lane record and notify per policy (`background-host/notices.ts`
 * `announce`, bound to the registration). `always` shows `text` verbatim.
 */
export type XaiAnnounce = (
  ctx: ExtensionContext,
  record: AnnouncedRecord,
  text: string,
  level: NoticeLevel,
  policy: NoticePolicy,
) => void;

export interface XaiForegroundDeps {
  readonly gate: AnthropicCapabilityGate;
  readonly session: AnthropicServerSideSession;
  readonly mode: () => XaiCompactionMode;
  readonly codexCompaction: () => CodexCompactionSnapshot | undefined;
  /** Registration lifecycle; any change invalidates an in-flight compaction. */
  readonly generation: () => number;
  /** Captures of a session, oldest first. */
  readonly captures: (sessionId: string) => readonly XaiWireCapture[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Journal seam; without it notices are shown directly and nothing is journaled. */
  readonly announce?: XaiAnnounce;
}

type ForegroundModel = NonNullable<ExtensionContext["model"]>;

/** Host scalars snapshotted before the first await. */
interface ForegroundRun {
  readonly ctx: ExtensionContext;
  readonly sessionId: string;
  readonly generation: number;
  readonly model: ForegroundModel;
  readonly registry: ExtensionContext["modelRegistry"];
  readonly preparation: SessionBeforeCompactEvent["preparation"];
  readonly branchEntryIds: readonly string[];
  /** The branch's newest compaction entry; a capture sent before it is stale. */
  readonly latestCompactionId: string | undefined;
  readonly instructions: string | undefined;
  readonly route: LaneRoute;
  /** The host's reason, journaled on the fallback record and stamped on the checkpoint. */
  readonly trigger: CompactionTrigger;
  readonly signal: AbortSignal;
}

/** Local fallback reasons: a coordinator failure, no usable capture, or an auth cooldown verdict. */
type FallbackReason = FailureReason | "no-capture" | "auth-cooling";

type Attempt =
  | { readonly kind: "compacted"; readonly result: SessionBeforeCompactResult }
  | { readonly kind: "abstain" }
  | {
      readonly kind: "fallback";
      readonly reason: FallbackReason;
      /** The compact request carried the user's `/compact` instructions to xAI. */
      readonly forwarded?: boolean;
    };

const ABSTAIN: Attempt = { kind: "abstain" };

function fallback(reason: FallbackReason): Attempt {
  return { kind: "fallback", reason };
}

function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    if (error instanceof Error && isStaleContextError(error)) return undefined;
    throw error;
  }
}

function show(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.notify(text, "warning");
  } catch (error) {
    if (!(error instanceof Error && isStaleContextError(error))) throw error;
  }
}

/** Journal (when wired) and notify per policy; unwired, only the notice is shown. */
function report(
  deps: XaiForegroundDeps,
  ctx: ExtensionContext,
  record: AnnouncedRecord,
  message: string,
  policy: NoticePolicy,
): void {
  const text = `${NOTICE_PREFIX}: ${message}`;
  if (deps.announce !== undefined) {
    deps.announce(ctx, record, text, "warning", policy);
    return;
  }
  if (policy !== "silent") show(ctx, text);
}

/** Whether a `/compact` focus is present (blank instructions are not forwarded). */
function hasInstructions(instructions: string | undefined): boolean {
  return instructions !== undefined && instructions.trim().length > 0;
}

/** A foreground attempt record before its event is chosen. */
type AttemptRecord = Omit<AnnouncedRecord, "event">;

function fallbackRecord(
  deps: XaiForegroundDeps,
  run: ForegroundRun,
  attempt: FallbackAttempt,
): AttemptRecord {
  const cooling = attempt.reason === "auth-cooling";
  const record: AttemptRecord = {
    at: (deps.now ?? Date.now)(),
    sessionId: run.sessionId,
    provider: "xai",
    route: run.route,
    trigger: run.trigger,
    from: "xai-native",
    to: "local",
    reason: cooling ? REASONS.cooldown : ownedReasonOf(attempt.reason),
  };
  if (cooling) record.detail = "auth-cooling";
  else if (attempt.forwarded === true) record.detail = REASONS.instructionsForwarded;
  return record;
}

type FallbackAttempt = Extract<Attempt, { readonly kind: "fallback" }>;

/** A native compaction that carried the user's `/compact` focus to xAI: journaled silently. */
function journalForwarded(deps: XaiForegroundDeps, run: ForegroundRun): void {
  report(
    deps,
    run.ctx,
    {
      at: (deps.now ?? Date.now)(),
      sessionId: run.sessionId,
      provider: "xai",
      route: run.route,
      event: "yield",
      from: "xai-native",
      to: "xai-native",
      reason: REASONS.instructionsForwarded,
      detail: REASONS.instructionsForwarded,
    },
    "the /compact focus was forwarded",
    "silent",
  );
}

/** `session_before_compact` handler; undefined means the local summarizer answers. */
export function createXaiForegroundCompactHandler(
  deps: XaiForegroundDeps,
): (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined> {
  /** Sessions whose resumed checkpoint without captures was journaled (once per session). */
  const resumed = new Set<string>();
  /** Silent fallbacks already journaled, per session and record (D4: once per transition). */
  const journaled = new Set<string>();
  return async (event, ctx) => {
    const run = snapshotRun(deps, event, ctx, resumed);
    if (run === undefined) return undefined;
    const attempt = await attemptCompaction(deps, run);
    if (attempt.kind === "compacted") {
      if (hasInstructions(run.instructions)) journalForwarded(deps, run);
      return attempt.result;
    }
    if (attempt.kind !== "fallback" || !isCurrent(deps, run)) return undefined;
    const reason = attempt.reason;
    const record = fallbackRecord(deps, run, attempt);
    if (reason !== "auth-cooling" && surfacesForegroundFailure(reason)) {
      // Cancelled or auth-failed: the host fails this compaction instead of summarizing.
      report(deps, ctx, { ...record, event: "cancel" }, surfacedFailureMessage(reason), "always");
      return SURFACED_FAILURE_RESULT;
    }
    if (reason === "auth-cooling") {
      // Every cooled-down attempt is told: the user may be waiting for the login to work again.
      report(
        deps,
        ctx,
        { ...record, event: "fallback" },
        "not used for this compaction (auth-cooling): the credentials were rejected recently and the cooldown has not ended; the local summarizer answers instead.",
        "always",
      );
      return undefined;
    }
    const message = `not used for this compaction (${reason}); the local summarizer answers instead.`;
    if (record.route === "manual") {
      // A user action is answered every time: one notice and one record per `/compact`.
      report(deps, ctx, { ...record, event: "fallback" }, message, "always");
      return undefined;
    }
    // Automatic routes: once per session and transition (D4).
    const key = [run.sessionId, record.route, record.reason, record.detail ?? ""].join("|");
    if (journaled.has(key)) return undefined;
    if (journaled.size >= MAX_JOURNALED_FALLBACKS) journaled.clear();
    journaled.add(key);
    report(deps, ctx, { ...record, event: "fallback" }, message, "per-session-reason");
    return undefined;
  };
}

function snapshotRun(
  deps: XaiForegroundDeps,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  resumed: Set<string>,
): ForegroundRun | undefined {
  const model = ctx.model;
  if (model === undefined || model.api !== "openai-responses") return undefined;
  const owner = resolveOwner(ctx, deps.codexCompaction(), {
    xaiServerSide: deps.mode() === "server-side",
  });
  if (owner !== "xai-native") return undefined;
  const sessionId = readSessionId(ctx);
  if (sessionId === undefined) return undefined;
  deps.session.bind(sessionId);
  if (deps.session.isDisabled(sessionId)) return undefined;
  noteResumeWithoutCaptures(deps, { ctx, sessionId, branch: event.branchEntries, resumed });
  // Static policy first (either auth mode): an unsupported model or endpoint never reads credentials.
  if (!xaiGateAdmitsModel(deps.gate, model)) return undefined;
  return {
    ctx,
    sessionId,
    generation: deps.generation(),
    model,
    registry: ctx.modelRegistry,
    preparation: event.preparation,
    branchEntryIds: retainableEntryIds(event.branchEntries),
    latestCompactionId: latestCompactionId(event.branchEntries),
    instructions: event.customInstructions,
    route: event.reason === "manual" ? "manual" : "foreground",
    trigger: hostTriggerOf(event),
    signal: event.signal,
  };
}

/**
 * A committed xAI checkpoint with no capture in this process (a resumed
 * session, a new registration, a mode or model switch back): the native lane
 * cannot compact until a turn is captured. Journaled once per session, without
 * a notice; what the user sees is the guard on the compaction attempt.
 */
function noteResumeWithoutCaptures(
  deps: XaiForegroundDeps,
  input: {
    readonly ctx: ExtensionContext;
    readonly sessionId: string;
    readonly branch: SessionBeforeCompactEvent["branchEntries"];
    readonly resumed: Set<string>;
  },
): void {
  const { ctx, sessionId, resumed } = input;
  if (resumed.has(sessionId) || deps.captures(sessionId).length > 0) return;
  const lookup = findActiveXaiCheckpoint(input.branch);
  if (lookup.kind !== "active") return;
  resumed.add(sessionId);
  report(
    deps,
    ctx,
    {
      at: (deps.now ?? Date.now)(),
      sessionId,
      provider: "xai",
      route: "resume",
      event: "yield",
      from: "xai-native",
      to: "local",
      reason: REASONS.noCapture,
      checkpointEntryId: lookup.checkpoint.entryId,
    },
    "no capture for the committed checkpoint yet",
    "silent",
  );
}

function isCurrent(deps: XaiForegroundDeps, run: ForegroundRun): boolean {
  return (
    deps.generation() === run.generation &&
    readSessionId(run.ctx) === run.sessionId &&
    !deps.session.isDisabled(run.sessionId)
  );
}

/** The capture entry the host's cut maps to (entry before the first kept one, or the capture tail). */
function preferredCut(
  capture: XaiWireCapture,
  firstKeptEntryId: string,
  branchEntryIds: readonly string[],
): string | undefined {
  const projection = capture.mapping?.projection ?? [];
  const kept = projection.findIndex((ref) => ref.entryId === firstKeptEntryId);
  if (kept >= 1) return projection[kept - 1]?.entryId;
  if (kept === 0) return undefined;
  const last = projection.at(-1)?.entryId;
  if (last === undefined) return undefined;
  const lastPosition = branchEntryIds.indexOf(last);
  return lastPosition >= 0 && branchEntryIds.indexOf(firstKeptEntryId) > lastPosition
    ? last
    : undefined;
}

type CaptureChoice =
  | { readonly ok: true; readonly capture: XaiWireCapture; readonly cutEntryId: string }
  | { readonly ok: false; readonly reason: "no-capture" | "no-legal-cut" };

function chooseCapture(
  captures: readonly XaiWireCapture[],
  scope: ProviderScope,
  run: ForegroundRun,
): CaptureChoice {
  let matched = false;
  for (let index = captures.length - 1; index >= 0; index--) {
    const capture = captures[index];
    if (capture === undefined || capture.status !== 200) continue;
    if (!xaiCaptureMatchesScope(capture, scope)) continue;
    // A capture from before the newest compaction maps only already-compacted history;
    // cutting it re-compacts the same prefix and the cut never advances.
    if (!capturedSince(capture.mapping, run.latestCompactionId)) continue;
    matched = true;
    const preferred = preferredCut(capture, run.preparation.firstKeptEntryId, run.branchEntryIds);
    if (preferred === undefined) continue;
    const cut = chooseLegalXaiCutEntry(capture, preferred, { branchExtendsCapture: true });
    if (cut !== "defer") return { ok: true, capture, cutEntryId: cut };
  }
  return { ok: false, reason: matched ? "no-legal-cut" : "no-capture" };
}

async function attemptCompaction(deps: XaiForegroundDeps, run: ForegroundRun): Promise<Attempt> {
  if (run.signal.aborted) return fallback("canceled");
  const auth = await run.registry.getApiKeyAndHeaders(run.model);
  if (!isCurrent(deps, run)) return ABSTAIN;
  if (run.signal.aborted) return fallback("canceled");
  if (!auth.ok) return fallback("auth");
  const scope: ProviderScope = {
    provider: run.model.provider,
    model: run.model.id,
    baseUrl: auth.baseUrl ?? run.model.baseUrl,
  };
  // Header-aware (D10): the same classification as the backend's resolveRequest.
  const authMode = xaiAuthModeFromAuth(auth);
  if (authMode === undefined) return fallback("auth");
  scope.authMode = authMode;
  const verdict = deps.gate.check(scope);
  if (!verdict.supported) {
    if (verdict.reason === "unsupported") return ABSTAIN;
    // A cooldown after an earlier auth failure: no credential failed now, so fall back locally.
    return fallback(verdict.reason === "auth" ? "auth-cooling" : verdict.reason);
  }
  const choice = chooseCapture(deps.captures(run.sessionId), scope, run);
  if (!choice.ok) return fallback(choice.reason);
  const outcome = await runXaiCompaction(
    { gate: deps.gate, fetch: deps.fetch, now: deps.now },
    {
      scope,
      model: run.model,
      auth,
      capture: choice.capture,
      cutEntryId: choice.cutEntryId,
      entryIds: run.branchEntryIds,
      signal: run.signal,
      budget: foregroundBudget(deps, run),
      instructions: run.instructions,
    },
  );
  if (!isCurrent(deps, run)) return ABSTAIN;
  if (!outcome.ok) {
    // The request reached xAI (a client outcome exists) with the user's focus in `instructions`.
    const forwarded = outcome.client !== undefined && hasInstructions(run.instructions);
    return { kind: "fallback", reason: outcome.failure.reason, forwarded };
  }
  const details = outcome.details;
  return {
    kind: "compacted",
    result: {
      compaction: {
        summary: placeholderSummary(details.wire.compactedItems),
        firstKeptEntryId: details.cut.firstKeptEntryId,
        tokensBefore: run.preparation.tokensBefore,
        details,
      },
    },
  };
}

function foregroundBudget(deps: XaiForegroundDeps, run: ForegroundRun): PreparationBudget {
  const now = deps.now ?? Date.now;
  const { contextWindow } = run.model;
  return {
    maxInputTokens: contextWindow > 0 ? contextWindow : Number.MAX_SAFE_INTEGER,
    maxOutputTokens: 0,
    maxResultBytes: FOREGROUND_MAX_RESULT_BYTES,
    deadlineMs: now() + FOREGROUND_TIMEOUT_MS,
    maxAttempts: 1,
  };
}
