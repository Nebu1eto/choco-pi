/**
 * Foreground Anthropic server-side compaction.
 *
 * Answers the host's own `session_before_compact` (threshold, overflow or
 * `/compact`) for an admitted Anthropic model with a signed `compaction` block
 * from the isolated lane, cut at the latest legal wire position at or before
 * the host's cut. Any failure returns undefined so the local reconciled
 * summarizer answers the same compaction; the first fallback in a session is
 * reported once. The handler never cancels and never produces a second result.
 */
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import { resolveMaxTokens } from "../budget.ts";
import type { FailureReason, PreparationBudget, ProviderScope } from "../background/contract.ts";
import { isStaleContextError } from "../lifecycle.ts";
import { type CodexCompactionSnapshot, isChildSession, resolveOwner } from "../ownership.ts";
import {
  type AnthropicBackendDeps,
  captureMatchesWireScope,
  chooseLegalCutEntry,
  runNativeCompaction,
} from "./backend.ts";
import type { AnthropicCapabilityGate } from "./capability.ts";
import { authModeOf } from "./capability.ts";
import type { WireCapture } from "./capture.ts";
import type { LaneStream } from "./lane-client.ts";
import type { AnthropicCompactionMode, AnthropicServerSideSession } from "./mode.ts";

/** Upper bound on one foreground summarization request. */
const FOREGROUND_TIMEOUT_MS = 300_000;
const FOREGROUND_MAX_RESULT_BYTES = 1_048_576;
const NOTICE_PREFIX = "Anthropic server-side compaction";

export interface ForegroundCompactionDeps {
  readonly gate: AnthropicCapabilityGate;
  readonly session: AnthropicServerSideSession;
  readonly mode: () => AnthropicCompactionMode;
  readonly codexCompaction: () => CodexCompactionSnapshot | undefined;
  /** Registration lifecycle; any change invalidates an in-flight compaction. */
  readonly generation: () => number;
  /** Captures of a session, oldest first. */
  readonly captures: (sessionId: string) => readonly WireCapture[];
  readonly fetch?: typeof globalThis.fetch;
  readonly stream?: LaneStream;
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

/** Session ID, or undefined once the context outlived its session. */
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

/**
 * `session_before_compact` handler for the server-side path. Undefined means
 * "not answered here": the caller runs the local summarizer next.
 */
export function createForegroundCompactHandler(
  deps: ForegroundCompactionDeps,
): (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined> {
  return async (event, ctx) => {
    const run = snapshotRun(deps, event, ctx);
    if (run === undefined) return undefined;
    const attempt = await attemptCompaction(deps, run);
    if (attempt.kind === "compacted") return attempt.result;
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
  deps: ForegroundCompactionDeps,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): ForegroundRun | undefined {
  const model = ctx.model;
  if (model === undefined || model.api !== "anthropic-messages") return undefined;
  const owner = resolveOwner(ctx, deps.codexCompaction(), {
    anthropicServerSide: deps.mode() === "server-side",
  });
  if (owner !== "anthropic-native") return undefined;
  const sessionId = readSessionId(ctx);
  if (sessionId === undefined || isChildSession(sessionId)) return undefined;
  deps.session.bind(sessionId);
  if (deps.session.isDisabled(sessionId)) return undefined;
  // Static policy first: an unsupported model or endpoint never reads credentials.
  const candidate: ProviderScope = {
    provider: model.provider,
    model: model.id,
    baseUrl: model.baseUrl,
    authMode: "oauth",
  };
  if (deps.gate.match(candidate) === undefined) return undefined;
  return {
    ctx,
    sessionId,
    generation: deps.generation(),
    model,
    registry: ctx.modelRegistry,
    preparation: event.preparation,
    branchEntryIds: event.branchEntries.map((entry) => entry.id),
    instructions: event.customInstructions,
    signal: event.signal,
  };
}

function isCurrent(deps: ForegroundCompactionDeps, run: ForegroundRun): boolean {
  return (
    deps.generation() === run.generation &&
    readSessionId(run.ctx) === run.sessionId &&
    !deps.session.isDisabled(run.sessionId)
  );
}

/**
 * The entry the host's cut maps to in a capture: the entry before the host's
 * first kept entry, or the capture's last entry when the first kept entry was
 * appended after the capture (for example the final answer of the last turn).
 */
function preferredCut(
  capture: WireCapture,
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
  | { readonly ok: true; readonly capture: WireCapture; readonly cutEntryId: string }
  | { readonly ok: false; readonly reason: "no-capture" | "no-legal-cut" };

/**
 * Newest successfully answered capture of this scope with a legal cut at or
 * before the host's cut. The cut only ever moves earlier (more is kept).
 */
function chooseCapture(
  captures: readonly WireCapture[],
  scope: ProviderScope,
  run: ForegroundRun,
): CaptureChoice {
  let matched = false;
  for (let index = captures.length - 1; index >= 0; index--) {
    const capture = captures[index];
    if (capture === undefined || capture.status !== 200) continue;
    if (!captureMatchesWireScope(capture, scope)) continue;
    matched = true;
    const preferred = preferredCut(capture, run.preparation.firstKeptEntryId, run.branchEntryIds);
    if (preferred === undefined) continue;
    const cut = chooseLegalCutEntry(capture, preferred, { branchExtendsCapture: true });
    if (cut !== "defer") return { ok: true, capture, cutEntryId: cut };
  }
  return { ok: false, reason: matched ? "no-legal-cut" : "no-capture" };
}

async function attemptCompaction(
  deps: ForegroundCompactionDeps,
  run: ForegroundRun,
): Promise<Attempt> {
  if (run.signal.aborted) return fallback("canceled");
  const auth = await run.registry.getApiKeyAndHeaders(run.model);
  if (!isCurrent(deps, run)) return ABSTAIN;
  if (run.signal.aborted) return fallback("canceled");
  if (!auth.ok) return ABSTAIN;
  const scope: ProviderScope = {
    provider: run.model.provider,
    model: run.model.id,
    baseUrl: auth.baseUrl ?? run.model.baseUrl,
  };
  const authMode = authModeOf(auth.apiKey);
  if (authMode !== undefined) scope.authMode = authMode;
  const verdict = deps.gate.check(scope);
  // Not admitted (API key, foreign endpoint): the local path is the policy, not a failure.
  if (!verdict.supported)
    return verdict.reason === "unsupported" ? ABSTAIN : fallback(verdict.reason);
  const choice = chooseCapture(deps.captures(run.sessionId), scope, run);
  if (!choice.ok) return fallback(choice.reason);
  const { capture, cutEntryId } = choice;
  const backendDeps: AnthropicBackendDeps = {
    gate: deps.gate,
    resolveModel: () => run.model,
    resolveAuth: async () => auth,
    findCapture: () => capture,
    fetch: deps.fetch,
    stream: deps.stream,
    now: deps.now,
  };
  const outcome = await runNativeCompaction(backendDeps, {
    scope,
    capture: () => capture,
    cutEntryId,
    entryIds: run.branchEntryIds,
    signal: run.signal,
    budget: foregroundBudget(deps, run),
    instructions: run.instructions,
  });
  if (!isCurrent(deps, run)) return ABSTAIN;
  if (!outcome.ok) return fallback(outcome.failure.reason);
  const details = outcome.details;
  return {
    kind: "compacted",
    result: {
      compaction: {
        summary: details.block.content,
        firstKeptEntryId: details.cut.firstKeptEntryId,
        tokensBefore: run.preparation.tokensBefore,
        details,
      },
    },
  };
}

function foregroundBudget(deps: ForegroundCompactionDeps, run: ForegroundRun): PreparationBudget {
  const now = deps.now ?? Date.now;
  const { contextWindow, maxTokens, reasoning } = run.model;
  return {
    maxInputTokens: contextWindow > 0 ? contextWindow : Number.MAX_SAFE_INTEGER,
    maxOutputTokens: resolveMaxTokens(
      { contextWindow, maxTokens, reasoning },
      run.preparation.settings,
    ),
    maxResultBytes: FOREGROUND_MAX_RESULT_BYTES,
    deadlineMs: now() + FOREGROUND_TIMEOUT_MS,
    maxAttempts: 1,
  };
}
