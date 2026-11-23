import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import { resolveMaxTokens } from "../budget.ts";
import type { FailureReason, PreparationBudget, ProviderScope } from "../background/contract.ts";
import { ownedReasonOf } from "../background/lane-journal.ts";
import type { AnnouncedRecord, NoticeLevel, NoticePolicy } from "../background-host/notices.ts";
import {
  SURFACED_FAILURE_RESULT,
  surfacedFailureMessage,
  surfacesForegroundFailure,
} from "../foreground-failure.ts";
import { type CodexCompactionSnapshot, resolveOwner } from "../ownership.ts";
import { capturedSince, latestCompactionId, retainableEntryIds } from "../retained-entries.ts";
import {
  type AnthropicBackendDeps,
  authModeFromAuth,
  captureMatchesWireScope,
  chooseLegalCutEntry,
  runNativeCompaction,
} from "./backend.ts";
import type { AnthropicCapabilityGate } from "./capability.ts";
import type { WireCapture } from "./capture.ts";
import type { LaneStream } from "./lane-client.ts";
import type { AnthropicCompactionMode, AnthropicServerSideSession } from "./mode.ts";
import { hostTriggerOf, type CompactionTrigger } from "../trigger.ts";
import { readSessionId } from "../shared/session.ts";

const FOREGROUND_TIMEOUT_MS = 300_000;
const FOREGROUND_MAX_RESULT_BYTES = 1_048_576;
const NOTICE_PREFIX = "Anthropic server-side compaction";

export interface ForegroundCompactionDeps {
  readonly gate: AnthropicCapabilityGate;
  readonly session: AnthropicServerSideSession;
  readonly mode: () => AnthropicCompactionMode;
  readonly codexCompaction: () => CodexCompactionSnapshot | undefined;
  readonly generation: () => number;
  readonly captures: (sessionId: string) => readonly WireCapture[];
  readonly fetch?: typeof globalThis.fetch;
  readonly stream?: LaneStream;
  readonly now?: () => number;
  readonly announce: (
    ctx: ExtensionContext,
    record: AnnouncedRecord,
    text: string,
    level: NoticeLevel,
    policy: NoticePolicy,
  ) => void;
}

type ForegroundModel = NonNullable<ExtensionContext["model"]>;

interface ForegroundRun {
  readonly ctx: ExtensionContext;
  readonly sessionId: string;
  readonly generation: number;
  readonly model: ForegroundModel;
  readonly registry: ExtensionContext["modelRegistry"];
  readonly preparation: SessionBeforeCompactEvent["preparation"];
  readonly branchEntryIds: readonly string[];
  readonly latestCompactionId: string | undefined;
  readonly instructions: string | undefined;
  readonly signal: AbortSignal;
  readonly manual: boolean;
  readonly trigger: CompactionTrigger;
}

type Attempt =
  | { readonly kind: "compacted"; readonly result: SessionBeforeCompactResult }
  | { readonly kind: "abstain" }
  | { readonly kind: "stale" }
  | { readonly kind: "fallback"; readonly reason: FailureReason | "no-capture" };

const ABSTAIN: Attempt = { kind: "abstain" };
const STALE: Attempt = { kind: "stale" };

function fallback(reason: FailureReason | "no-capture"): Attempt {
  return { kind: "fallback", reason };
}

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
    if (attempt.kind === "abstain") return undefined;
    const state = runState(deps, run);
    if (attempt.kind === "stale" || state === "stale") return SURFACED_FAILURE_RESULT;
    if (state === "disabled") return undefined;
    return announceFallback(deps, run, attempt.reason);
  };
}

function announceFallback(
  deps: ForegroundCompactionDeps,
  run: ForegroundRun,
  reason: FailureReason | "no-capture",
): SessionBeforeCompactResult | undefined {
  const surfaced = surfacesForegroundFailure(reason);
  const record: AnnouncedRecord = {
    at: (deps.now ?? Date.now)(),
    sessionId: run.sessionId,
    provider: "anthropic",
    route: run.manual ? "manual" : "foreground",
    trigger: run.trigger,
    event: surfaced ? "cancel" : "fallback",
    from: "anthropic-native",
    to: surfaced ? undefined : "local",
    reason: ownedReasonOf(reason),
  };
  const text = surfaced
    ? surfacedFailureMessage(reason)
    : `not used for this compaction (${reason}); the local summarizer answers instead.`;
  deps.announce(
    run.ctx,
    record,
    `${NOTICE_PREFIX}: ${text}`,
    "warning",
    run.manual ? "always" : "per-session-reason",
  );
  return surfaced ? SURFACED_FAILURE_RESULT : undefined;
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
  if (sessionId === undefined) return undefined;
  deps.session.bind(sessionId);
  if (deps.session.isDisabled(sessionId)) return undefined;
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
    branchEntryIds: retainableEntryIds(event.branchEntries),
    latestCompactionId: latestCompactionId(event.branchEntries),
    instructions: event.customInstructions,
    signal: event.signal,
    manual: event.reason === "manual",
    trigger: hostTriggerOf(event),
  };
}

function runState(
  deps: ForegroundCompactionDeps,
  run: ForegroundRun,
): "current" | "stale" | "disabled" {
  if (deps.generation() !== run.generation || readSessionId(run.ctx) !== run.sessionId) {
    return "stale";
  }
  return deps.session.isDisabled(run.sessionId) ? "disabled" : "current";
}

function interrupted(deps: ForegroundCompactionDeps, run: ForegroundRun): Attempt | undefined {
  const state = runState(deps, run);
  if (state === "stale") return STALE;
  return state === "disabled" ? ABSTAIN : undefined;
}

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
    if (!capturedSince(capture.mapping, run.latestCompactionId)) continue;
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
  const afterAuth = interrupted(deps, run);
  if (afterAuth !== undefined) return afterAuth;
  if (run.signal.aborted) return fallback("canceled");
  if (!auth.ok) return fallback("auth");
  const scope: ProviderScope = {
    provider: run.model.provider,
    model: run.model.id,
    baseUrl: auth.baseUrl ?? run.model.baseUrl,
  };
  const authMode = authModeFromAuth(auth);
  if (authMode !== undefined) scope.authMode = authMode;
  const verdict = deps.gate.check(scope);
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
  const afterLane = interrupted(deps, run);
  if (afterLane !== undefined) return afterLane;
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
