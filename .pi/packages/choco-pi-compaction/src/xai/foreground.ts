/**
 * Foreground xAI server-side compaction.
 *
 * Answers the host's own `session_before_compact` for an admitted Grok model
 * with an opaque compaction item from `POST /v1/responses/compact`, cut at the
 * latest legal wire position at or before the host's cut. A failure returns
 * undefined so the local summarizer answers the same compaction; the first
 * fallback in a session is reported once. A cancelled or auth-failed attempt
 * instead answers `{ cancel: true }` so the host reports the failure
 * (`foreground-failure.ts`). One attempt. Runs in main and subagent child
 * sessions alike, reading only its own context and session state.
 */
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import type { AnthropicCapabilityGate } from "../anthropic/capability.ts";
import type { AnthropicServerSideSession } from "../anthropic/mode.ts";
import type { FailureReason, PreparationBudget, ProviderScope } from "../background/contract.ts";
import { isStaleContextError } from "../lifecycle.ts";
import {
  SURFACED_FAILURE_RESULT,
  surfacedFailureMessage,
  surfacesForegroundFailure,
} from "../foreground-failure.ts";
import { type CodexCompactionSnapshot, resolveOwner } from "../ownership.ts";
import { retainableEntryIds } from "../retained-entries.ts";
import { chooseLegalXaiCutEntry, runXaiCompaction, xaiCaptureMatchesScope } from "./backend.ts";
import { xaiAuthModeOf, xaiGateAdmitsModel } from "./capability.ts";
import type { XaiWireCapture } from "./capture.ts";
import { placeholderSummary } from "./details.ts";
import type { XaiCompactionMode } from "./mode.ts";

/** Upper bound on one foreground compaction request. */
const FOREGROUND_TIMEOUT_MS = 300_000;
const FOREGROUND_MAX_RESULT_BYTES = 1_048_576;
const NOTICE_PREFIX = "xAI server-side compaction";

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
  readonly instructions: string | undefined;
  readonly signal: AbortSignal;
}

type Attempt =
  | { readonly kind: "compacted"; readonly result: SessionBeforeCompactResult }
  | { readonly kind: "abstain" }
  | { readonly kind: "fallback"; readonly reason: FailureReason | "no-capture" };

const ABSTAIN: Attempt = { kind: "abstain" };

function fallback(reason: FailureReason | "no-capture"): Attempt {
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

function notify(ctx: ExtensionContext, message: string): void {
  try {
    ctx.ui.notify(`${NOTICE_PREFIX}: ${message}`, "warning");
  } catch (error) {
    if (!(error instanceof Error && isStaleContextError(error))) throw error;
  }
}

/** `session_before_compact` handler; undefined means the local summarizer answers. */
export function createXaiForegroundCompactHandler(
  deps: XaiForegroundDeps,
): (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined> {
  return async (event, ctx) => {
    const run = snapshotRun(deps, event, ctx);
    if (run === undefined) return undefined;
    const attempt = await attemptCompaction(deps, run);
    if (attempt.kind === "compacted") return attempt.result;
    if (attempt.kind === "fallback" && surfacesForegroundFailure(attempt.reason)) {
      // Cancelled or auth-failed: the host fails this compaction instead of summarizing.
      if (!isCurrent(deps, run)) return undefined;
      notify(ctx, surfacedFailureMessage(attempt.reason));
      return SURFACED_FAILURE_RESULT;
    }
    if (attempt.kind === "fallback" && isCurrent(deps, run)) {
      if (deps.session.claimFallbackNotice(run.sessionId)) {
        notify(
          ctx,
          `not used for this compaction (${attempt.reason}); the local summarizer answers instead. Later fallbacks in this session are silent.`,
        );
      }
    }
    return undefined;
  };
}

function snapshotRun(
  deps: XaiForegroundDeps,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
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
    instructions: event.customInstructions,
    signal: event.signal,
  };
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
  const authMode = xaiAuthModeOf(auth.apiKey);
  if (authMode === undefined) return fallback("auth");
  scope.authMode = authMode;
  const verdict = deps.gate.check(scope);
  if (!verdict.supported) {
    return verdict.reason === "unsupported" ? ABSTAIN : fallback(verdict.reason);
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
  if (!outcome.ok) return fallback(outcome.failure.reason);
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
