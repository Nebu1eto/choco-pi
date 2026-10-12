/**
 * Anthropic native on-demand compaction backend
 * (`anthropic-compaction-on-demand-v1`).
 *
 * Preparation summarizes the frozen prefix of an actually transmitted request
 * (a transport capture) on an isolated lane. Cut legality is decided from the
 * captured wire roles only: the captured
 * messages are never stripped, edited or reordered to manufacture a legal cut.
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

import type {
  Backend,
  BackendFactory,
  BackendFactoryContext,
  CapabilityVerdict,
  FailureReason,
  FrozenSnapshot,
  LegalityVerdict,
  PreparationBudget,
  PreparedCheckpoint,
  PrepareFailure,
  ProviderScope,
} from "../background/contract.ts";
import { type AnthropicCapabilityGate, authModeOf, normalizeBaseUrl } from "./capability.ts";
import {
  bindingDigests,
  hasThinking,
  isWireCapture,
  toolResultIds,
  toolUseIds,
  type WireCapture,
  type WireMessage,
} from "./capture.ts";
import { ANTHROPIC_STRATEGY, type AnthropicDetails, isAnthropicDetails } from "./details.ts";
import { buildLanePayload, type LaneStream, runLaneRequest } from "./lane-client.ts";

export const ANTHROPIC_BACKEND_ID = "anthropic-native";

// ---------------------------------------------------------------------------
// Cut legality (wire roles only, never edits the wire)
// ---------------------------------------------------------------------------

type WireCutVerdict =
  | "legal"
  | "first-kept-system"
  | "first-kept-not-user"
  | "same-role"
  | "open-tool-call"
  | "out-of-range";

/**
 * Legality of keeping `wire[cut..]` after summarizing `wire[0..cut)`. The
 * replayed block is an assistant message, so the first kept message must be a
 * `user` message that differs in role from the last summarized one; it is
 * never a mid-conversation `system` message; no tool call is open at the cut.
 * Summarizing the whole captured request (trailing system messages included)
 * is legal.
 */
export function judgeWireCut(wire: readonly WireMessage[], cut: number): WireCutVerdict {
  if (cut < 1 || cut > wire.length) return "out-of-range";
  const prefix = wire.slice(0, cut);
  const used = new Set(prefix.flatMap(toolUseIds));
  const answered = new Set(prefix.flatMap(toolResultIds));
  if ([...used].some((id) => !answered.has(id))) return "open-tool-call";
  const firstKept = wire[cut];
  if (firstKept === undefined) return "legal";
  if (firstKept.role === "system") return "first-kept-system";
  if (firstKept.role !== "user") return "first-kept-not-user";
  if (prefix.at(-1)?.role === firstKept.role) return "same-role";
  return "legal";
}

type CutResolution =
  | {
      readonly ok: true;
      /** Wire messages summarized: `capture.body.messages.slice(0, prefixLength)`. */
      readonly prefixLength: number;
      /** Next projected entry after the cut when the capture already had one. */
      readonly projectedSuccessor: string | undefined;
      readonly unmappedPrefixKeys: number;
      readonly keptThinking: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: Extract<FailureReason, "no-legal-cut" | "incompatible">;
      readonly code: string;
    };

function refused(
  reason: Extract<FailureReason, "no-legal-cut" | "incompatible">,
  code: string,
): CutResolution {
  return { ok: false, reason, code };
}

/**
 * Map an entry-level cut (`cutEntryId` = last summarized entry) onto the
 * captured wire and judge it. Ambiguous alignment across the cut, gaps in the
 * summarized prefix and kept content the capture cannot place all refuse.
 */
export function resolveEntryCut(capture: WireCapture, cutEntryId: string): CutResolution {
  const mapping = capture.mapping;
  if (mapping === undefined) return refused("incompatible", "unmapped-capture");
  const position = new Map(mapping.projection.map((ref, index) => [ref.entryId, index]));
  const cut = position.get(cutEntryId);
  if (cut === undefined) return refused("incompatible", "cut-not-captured");
  const side = (entryId: string): "prefix" | "kept" =>
    (position.get(entryId) ?? Number.POSITIVE_INFINITY) <= cut ? "prefix" : "kept";
  for (const message of mapping.messages) {
    for (const ambiguous of message.ambiguous) {
      if (ambiguous.outOfOrder) return refused("incompatible", "ambiguous-order");
      const sides = new Set(ambiguous.candidates.map(side));
      if (sides.size > 1) return refused("incompatible", "ambiguous-cut");
    }
  }
  const classes = mapping.messages.map((message) => {
    const sides = new Set(message.entryIds.map(side));
    if (sides.size === 0) return "neutral";
    if (sides.size > 1) return "straddle";
    return sides.has("prefix") ? "prefix" : "kept";
  });
  if (classes.includes("straddle")) return refused("no-legal-cut", "straddles-cut");
  const messages = capture.body.messages;
  const firstKeptIndex = classes.indexOf("kept");
  const prefixLength = firstKeptIndex < 0 ? messages.length : firstKeptIndex;
  if (classes.slice(prefixLength).includes("prefix")) return refused("incompatible", "order");
  const summarized = new Set(
    mapping.messages.slice(0, prefixLength).flatMap((message) => message.entryIds),
  );
  const missing = mapping.projection
    .slice(0, cut + 1)
    .some((ref) => ref.keyed && !summarized.has(ref.entryId));
  if (missing) return refused("incompatible", "prefix-gap");
  const firstVisibleKept = mapping.projection.slice(cut + 1).find((ref) => ref.visible);
  if (firstVisibleKept !== undefined) {
    const placed = mapping.messages[prefixLength]?.entryIds.includes(firstVisibleKept.entryId);
    if (placed !== true) return refused("incompatible", "first-kept-unplaced");
  }
  const verdict = judgeWireCut(messages, prefixLength);
  if (verdict !== "legal") return refused("no-legal-cut", verdict);
  return {
    ok: true,
    prefixLength,
    projectedSuccessor: mapping.projection[cut + 1]?.entryId,
    unmappedPrefixKeys: mapping.messages
      .slice(0, prefixLength)
      .reduce((total, message) => total + message.unmapped.length, 0),
    keptThinking: messages.slice(prefixLength).some(hasThinking),
  };
}

/**
 * Latest legal entry cut at or before `preferredCutEntryId` in the capture's
 * projection, else "defer". For coordinators selecting a native cut.
 */
export function chooseLegalCutEntry(
  capture: WireCapture,
  preferredCutEntryId: string,
): string | "defer" {
  const projection = capture.mapping?.projection ?? [];
  const preferred = projection.findIndex((ref) => ref.entryId === preferredCutEntryId);
  for (let index = preferred; index >= 0; index--) {
    const entryId = projection[index]?.entryId;
    if (entryId !== undefined && resolveEntryCut(capture, entryId).ok) return entryId;
  }
  return "defer";
}

/** Wire-capture match: exact provider and model, and equal normalized base URLs; a scope without baseUrl never matches. */
function captureMatchesWireScope(capture: WireCapture, scope: ProviderScope): boolean {
  return (
    capture.provider === scope.provider &&
    capture.modelId === scope.model &&
    scope.baseUrl !== undefined &&
    normalizeBaseUrl(capture.baseUrl) === normalizeBaseUrl(scope.baseUrl)
  );
}

/** Newest successfully answered, mapped capture of this scope whose projection holds the cut. */
export function selectCapture(
  captures: readonly WireCapture[],
  cutEntryId: string,
  scope: ProviderScope,
): WireCapture | undefined {
  for (let index = captures.length - 1; index >= 0; index--) {
    const capture = captures[index];
    if (
      capture !== undefined &&
      capture.status === 200 &&
      captureMatchesWireScope(capture, scope) &&
      capture.mapping?.projection.some((ref) => ref.entryId === cutEntryId) === true
    ) {
      return capture;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/** Structurally compatible with `ModelRegistry.getApiKeyAndHeaders` results. */
type LaneAuthResolution =
  | {
      readonly ok: true;
      readonly apiKey?: string;
      readonly headers?: ProviderHeaders;
      readonly baseUrl?: string;
      readonly env?: Record<string, string>;
    }
  | { readonly ok: false; readonly error: string };

export interface AnthropicBackendDeps {
  readonly gate: AnthropicCapabilityGate;
  /** e.g. `(scope) => ctx.modelRegistry.find(scope.provider, scope.model)`. */
  readonly resolveModel: (scope: ProviderScope) => Model<Api> | undefined;
  /** e.g. `(model) => ctx.modelRegistry.getApiKeyAndHeaders(model)`; resolved per request, kept in memory only. */
  readonly resolveAuth: (model: Model<Api>) => Promise<LaneAuthResolution>;
  /** Capture lookup when `snapshot.backendCapture` is absent. */
  readonly findCapture: (snapshot: FrozenSnapshot) => WireCapture | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly stream?: LaneStream;
  readonly now?: () => number;
}

function prepareFailure(
  reason: FailureReason,
  retryable: boolean,
  retryAfterMs?: number,
): PrepareFailure {
  if (retryAfterMs === undefined) return { ok: false, reason, retryable };
  return { ok: false, reason, retryable, retryAfterMs };
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

/** Approximate request tokens from its serialized size (4 bytes per token). */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text) / 4);
}

class AnthropicNativeBackend implements Backend<AnthropicDetails> {
  readonly id = ANTHROPIC_BACKEND_ID;
  private readonly deps: AnthropicBackendDeps;

  constructor(deps: AnthropicBackendDeps) {
    this.deps = deps;
  }

  async capability(scope: ProviderScope): Promise<CapabilityVerdict> {
    return this.deps.gate.check(scope);
  }

  private captureFor(snapshot: FrozenSnapshot): WireCapture | undefined {
    if (snapshot.backendCapture !== undefined) {
      return isWireCapture(snapshot.backendCapture) ? snapshot.backendCapture : undefined;
    }
    return this.deps.findCapture(snapshot);
  }

  isLegalCut(snapshot: FrozenSnapshot): LegalityVerdict {
    const capture = this.captureFor(snapshot);
    if (capture === undefined || !captureMatchesWireScope(capture, snapshot.providerScope)) {
      return { legal: false, reason: "incompatible" };
    }
    const resolution = resolveEntryCut(capture, snapshot.cutEntryId);
    return resolution.ok ? { legal: true } : { legal: false, reason: resolution.reason };
  }

  async prepare(
    snapshot: FrozenSnapshot,
    options: {
      readonly signal: AbortSignal;
      readonly budget: PreparationBudget;
      readonly candidateId: string;
    },
  ): Promise<PreparedCheckpoint<AnthropicDetails> | PrepareFailure> {
    const { signal, budget, candidateId } = options;
    const now = this.deps.now ?? Date.now;
    const scope = structuredClone(snapshot.providerScope);
    const cutEntryId = snapshot.cutEntryId;
    const entryIds = snapshot.entries.map((entry) => entry.id);
    if (signal.aborted) return prepareFailure("canceled", false);
    const verdict = this.deps.gate.check(scope);
    if (!verdict.supported) return prepareFailure(verdict.reason, false);
    if (scope.authMode !== "oauth" && scope.authMode !== "api-key") {
      return prepareFailure("unsupported", false);
    }
    const capture = this.captureFor(snapshot);
    if (capture === undefined || !captureMatchesWireScope(capture, scope)) {
      return prepareFailure("incompatible", false);
    }
    const cut = resolveEntryCut(capture, cutEntryId);
    if (!cut.ok) return prepareFailure(cut.reason, false);
    const cutPosition = entryIds.indexOf(cutEntryId);
    const firstKeptEntryId =
      (cutPosition >= 0 ? entryIds[cutPosition + 1] : undefined) ?? cut.projectedSuccessor;
    // No retained entry exists yet: defer before any request (never a null pointer).
    if (firstKeptEntryId === undefined || firstKeptEntryId === cutEntryId) {
      return prepareFailure("no-legal-cut", true);
    }
    if (budget.deadlineMs <= now()) return prepareFailure("timeout", true);
    const found = this.deps.resolveModel(scope);
    if (
      found === undefined ||
      !isAnthropicMessagesModel(found) ||
      found.provider !== capture.provider ||
      found.id !== capture.modelId
    ) {
      return prepareFailure("unsupported", false);
    }
    const maxOutputTokens =
      found.maxTokens > 0
        ? Math.min(budget.maxOutputTokens, found.maxTokens)
        : budget.maxOutputTokens;
    const lane = buildLanePayload(capture.body, cut.prefixLength, {
      betas: capture.betas,
      maxOutputTokens,
    });
    if (estimateTokens(JSON.stringify(lane.payload)) > budget.maxInputTokens) {
      return prepareFailure("oversized", false);
    }
    const auth = await this.deps.resolveAuth(found);
    if (signal.aborted) return prepareFailure("canceled", false);
    if (!auth.ok) {
      this.deps.gate.recordFailure(scope, "auth");
      return prepareFailure("auth", false);
    }
    if (authModeOf(auth.apiKey) !== scope.authMode) return prepareFailure("unsupported", false);
    const model: Model<"anthropic-messages"> =
      auth.baseUrl === undefined ? found : { ...found, baseUrl: auth.baseUrl };
    if (normalizeBaseUrl(model.baseUrl) !== normalizeBaseUrl(capture.baseUrl)) {
      return prepareFailure("incompatible", false);
    }
    const result = await runLaneRequest({
      model,
      auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
      payload: lane.payload,
      signal,
      deadlineMs: budget.deadlineMs,
      maxResultBytes: budget.maxResultBytes,
      fetch: this.deps.fetch,
      stream: this.deps.stream,
      now,
    });
    if (!result.ok) {
      this.deps.gate.recordFailure(scope, result.reason, result.retryAfterMs);
      return prepareFailure(result.reason, result.retryable, result.retryAfterMs);
    }
    if (Buffer.byteLength(JSON.stringify(result.block)) > budget.maxResultBytes) {
      this.deps.gate.recordFailure(scope, "oversized");
      return prepareFailure("oversized", false);
    }
    const digests = bindingDigests(capture.body);
    const details = {
      strategy: ANTHROPIC_STRATEGY,
      schemaVersion: 1,
      block: result.block,
      scope: {
        provider: capture.provider,
        model: capture.modelId,
        baseUrl: normalizeBaseUrl(capture.baseUrl),
        authMode: scope.authMode,
      },
      betas: [...lane.betas],
      cut: { cutEntryId, firstKeptEntryId },
      wire: {
        prefixLength: cut.prefixLength,
        capturedLength: capture.body.messages.length,
        keptThinking: cut.keptThinking,
        systemDigest: digests.systemDigest,
        toolsDigest: digests.toolsDigest,
        unmappedPrefixKeys: cut.unmappedPrefixKeys,
      },
      laneUsage: result.usage,
      stopReason: "compaction",
      preparedAt: now(),
    };
    if (!isAnthropicDetails(details)) {
      this.deps.gate.recordFailure(scope, "malformed");
      return prepareFailure("malformed", false);
    }
    this.deps.gate.recordSuccess(scope);
    return {
      candidateId,
      backendId: ANTHROPIC_BACKEND_ID,
      schemaVersion: 1,
      draft: {
        type: "compaction",
        summary: details.block.content,
        firstKeptEntryId,
        details,
      },
      details,
      usage: result.usage,
      reasonCodes: ["prepared"],
    };
  }
}

export function createAnthropicNativeBackend(
  deps: AnthropicBackendDeps,
): Backend<AnthropicDetails> {
  return new AnthropicNativeBackend(deps);
}

/** Registry factory; `depsFor` closes over the owner's host capabilities. */
export function anthropicBackendFactory(
  depsFor: (context: BackendFactoryContext) => AnthropicBackendDeps,
): BackendFactory {
  return (context) => createAnthropicNativeBackend(depsFor(context));
}
