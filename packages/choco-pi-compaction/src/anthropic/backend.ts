import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

import { type BearerAuth, bearerCredentialOf } from "../auth.ts";
import type {
  Backend,
  BackgroundUsage,
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
import { readFirstKeptEntryId } from "../background/snapshot.ts";
import { type AnthropicCapabilityGate, authModeOf, normalizeBaseUrl } from "./capability.ts";
import {
  bindingDigests,
  capturesFor,
  hasThinking,
  isWireCapture,
  toolResultIds,
  toolUseIds,
  type WireCapture,
  type WireMessage,
} from "./capture.ts";
import { ANTHROPIC_STRATEGY, type AnthropicDetails, isAnthropicDetails } from "./details.ts";
import {
  buildLanePayload,
  instructionLength,
  type LaneFailure,
  type LaneStream,
  MAX_COMPACTION_INSTRUCTIONS,
  runLaneRequest,
} from "./lane-client.ts";

export const ANTHROPIC_BACKEND_ID = "anthropic-native";

type WireCutVerdict =
  | "legal"
  | "first-kept-system"
  | "first-kept-not-user"
  | "same-role"
  | "open-tool-call"
  | "out-of-range";

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
      readonly prefixLength: number;
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

export function chooseLegalCutEntry(
  capture: WireCapture,
  preferredCutEntryId: string,
  options: {
    readonly branchExtendsCapture?: boolean;
  } = {},
): string | "defer" {
  const first = legalCutEntries(capture, preferredCutEntryId, options).next();
  return first.done === true ? "defer" : first.value;
}

export function* legalCutEntries(
  capture: WireCapture,
  preferredCutEntryId: string,
  options: { readonly branchExtendsCapture?: boolean } = {},
): Generator<string, void, undefined> {
  const projection = capture.mapping?.projection ?? [];
  const preferred = projection.findIndex((ref) => ref.entryId === preferredCutEntryId);
  for (let index = preferred; index >= 0; index--) {
    const entryId = projection[index]?.entryId;
    if (entryId === undefined) continue;
    const cut = resolveEntryCut(capture, entryId);
    if (!cut.ok) continue;
    if (cut.projectedSuccessor !== undefined || options.branchExtendsCapture === true)
      yield entryId;
  }
}

export function captureMatchesWireScope(capture: WireCapture, scope: ProviderScope): boolean {
  return (
    capture.provider === scope.provider &&
    capture.modelId === scope.model &&
    scope.baseUrl !== undefined &&
    normalizeBaseUrl(capture.baseUrl) === normalizeBaseUrl(scope.baseUrl)
  );
}

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

export function hasUsableCapture(sessionId: string, scope: ProviderScope): boolean {
  return capturesFor(sessionId).some(
    (capture) =>
      capture.status === 200 &&
      capture.mapping !== undefined &&
      captureMatchesWireScope(capture, scope),
  );
}

export function authModeFromAuth(auth: BearerAuth | undefined): "oauth" | "api-key" | undefined {
  return authModeOf(bearerCredentialOf(auth));
}

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
  readonly resolveModel: (scope: ProviderScope) => Model<Api> | undefined;
  readonly resolveAuth: (model: Model<Api>) => Promise<LaneAuthResolution>;
  readonly findCapture: (snapshot: FrozenSnapshot) => WireCapture | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly stream?: LaneStream;
  readonly now?: () => number;
  readonly disabled?: () => boolean;
}

function prepareFailure(
  reason: FailureReason,
  retryable: boolean,
  retryAfterMs?: number,
  detail?: string,
): PrepareFailure {
  const base = { ok: false as const, reason, retryable };
  const timed = retryAfterMs === undefined ? base : { ...base, retryAfterMs };
  return detail === undefined ? timed : { ...timed, detail };
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

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
    if (this.deps.disabled?.() === true) return { supported: false, reason: "unsupported" };
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
      return {
        legal: false,
        reason: "incompatible",
        detail: capture === undefined ? "no-capture" : "scope-mismatch",
      };
    }
    const resolution = resolveEntryCut(capture, snapshot.cutEntryId);
    return resolution.ok
      ? { legal: true }
      : { legal: false, reason: resolution.reason, detail: resolution.code };
  }

  async prepare(
    snapshot: FrozenSnapshot,
    options: {
      readonly signal: AbortSignal;
      readonly budget: PreparationBudget;
      readonly candidateId: string;
      readonly customInstructions?: string;
    },
  ): Promise<PreparedCheckpoint<AnthropicDetails> | PrepareFailure> {
    const { candidateId } = options;
    const firstKept = readFirstKeptEntryId(snapshot);
    const entryIds = snapshot.entries.map((entry) => entry.id);
    if (firstKept !== undefined) entryIds.push(firstKept);
    const outcome = await runNativeCompaction(this.deps, {
      scope: snapshot.providerScope,
      capture: () => this.captureFor(snapshot),
      cutEntryId: snapshot.cutEntryId,
      entryIds,
      signal: options.signal,
      budget: options.budget,
      instructions: options.customInstructions,
    });
    if (!outcome.ok) return outcome.failure;
    const details = outcome.details;
    return {
      candidateId,
      backendId: ANTHROPIC_BACKEND_ID,
      schemaVersion: 1,
      draft: {
        type: "compaction",
        summary: details.block.content,
        firstKeptEntryId: details.cut.firstKeptEntryId,
        details,
      },
      details,
      usage: outcome.usage,
      reasonCodes: ["prepared"],
    };
  }
}

export interface NativeCompactionRequest {
  readonly scope: ProviderScope;
  readonly capture: () => WireCapture | undefined;
  readonly cutEntryId: string;
  readonly entryIds: readonly string[];
  readonly signal: AbortSignal;
  readonly budget: PreparationBudget;
  readonly instructions?: string;
}

export type NativeCompactionOutcome =
  | {
      readonly ok: true;
      readonly details: AnthropicDetails;
      readonly usage: BackgroundUsage;
    }
  | {
      readonly ok: false;
      readonly failure: PrepareFailure;
      readonly lane?: LaneFailure;
    };

function failed(failure: PrepareFailure, lane?: LaneFailure): NativeCompactionOutcome {
  return lane === undefined ? { ok: false, failure } : { ok: false, failure, lane };
}

interface ResolvedNativeRequest {
  readonly scope: ProviderScope & { readonly authMode: "oauth" | "api-key" };
  readonly capture: WireCapture;
  readonly cut: Extract<CutResolution, { readonly ok: true }>;
  readonly firstKeptEntryId: string;
}

function resolveNativeRequest(
  deps: AnthropicBackendDeps,
  request: NativeCompactionRequest,
  now: () => number,
): ResolvedNativeRequest | PrepareFailure {
  const scope = structuredClone(request.scope);
  const { cutEntryId, entryIds } = request;
  if (request.signal.aborted) return prepareFailure("canceled", false);
  const verdict = deps.gate.check(scope);
  if (!verdict.supported) return prepareFailure(verdict.reason, false);
  const authMode = scope.authMode;
  if (authMode !== "oauth" && authMode !== "api-key") return prepareFailure("unsupported", false);
  const capture = request.capture();
  if (capture === undefined || !captureMatchesWireScope(capture, scope)) {
    return prepareFailure(
      "incompatible",
      false,
      undefined,
      capture === undefined ? "no-capture" : "scope-mismatch",
    );
  }
  const cut = resolveEntryCut(capture, cutEntryId);
  if (!cut.ok) return prepareFailure(cut.reason, false, undefined, cut.code);
  const cutPosition = entryIds.indexOf(cutEntryId);
  const firstKeptEntryId =
    (cutPosition >= 0 ? entryIds[cutPosition + 1] : undefined) ?? cut.projectedSuccessor;
  if (firstKeptEntryId === undefined || firstKeptEntryId === cutEntryId) {
    return prepareFailure("no-legal-cut", true, undefined, "no-retained-entry");
  }
  if (
    request.instructions !== undefined &&
    instructionLength(request.instructions) > MAX_COMPACTION_INSTRUCTIONS
  ) {
    return prepareFailure("oversized", false);
  }
  if (request.budget.deadlineMs <= now()) return prepareFailure("timeout", true);
  return { scope: { ...scope, authMode }, capture, cut, firstKeptEntryId };
}

export async function runNativeCompaction(
  deps: AnthropicBackendDeps,
  request: NativeCompactionRequest,
): Promise<NativeCompactionOutcome> {
  const now = deps.now ?? Date.now;
  const { signal, budget } = request;
  const resolved = resolveNativeRequest(deps, request, now);
  if ("ok" in resolved) return failed(resolved);
  const { scope, capture, cut, firstKeptEntryId } = resolved;
  const found = deps.resolveModel(scope);
  if (
    found === undefined ||
    !isAnthropicMessagesModel(found) ||
    found.provider !== capture.provider ||
    found.id !== capture.modelId
  ) {
    return failed(prepareFailure("unsupported", false));
  }
  const maxOutputTokens =
    found.maxTokens > 0
      ? Math.min(budget.maxOutputTokens, found.maxTokens)
      : budget.maxOutputTokens;
  const lane = buildLanePayload(capture.body, cut.prefixLength, {
    betas: capture.betas,
    maxOutputTokens,
    instructions: request.instructions,
  });
  if (estimateTokens(JSON.stringify(lane.payload)) > budget.maxInputTokens) {
    return failed(prepareFailure("oversized", false));
  }
  const auth = await deps.resolveAuth(found);
  if (signal.aborted) return failed(prepareFailure("canceled", false));
  if (!auth.ok) {
    deps.gate.recordFailure(scope, "auth");
    return failed(prepareFailure("auth", false));
  }
  if (authModeFromAuth(auth) !== scope.authMode) {
    return failed(prepareFailure("unsupported", false));
  }
  const model: Model<"anthropic-messages"> =
    auth.baseUrl === undefined ? found : { ...found, baseUrl: auth.baseUrl };
  if (normalizeBaseUrl(model.baseUrl) !== normalizeBaseUrl(capture.baseUrl)) {
    return failed(prepareFailure("incompatible", false));
  }
  const result = await runLaneRequest({
    model,
    auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
    payload: lane.payload,
    signal,
    deadlineMs: budget.deadlineMs,
    maxResultBytes: budget.maxResultBytes,
    fetch: deps.fetch,
    stream: deps.stream,
    now,
  });
  if (!result.ok) {
    deps.gate.recordFailure(scope, result.reason, result.retryAfterMs);
    return failed(prepareFailure(result.reason, result.retryable, result.retryAfterMs), result);
  }
  if (Buffer.byteLength(JSON.stringify(result.block)) > budget.maxResultBytes) {
    deps.gate.recordFailure(scope, "oversized");
    return failed(prepareFailure("oversized", false));
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
    cut: { cutEntryId: request.cutEntryId, firstKeptEntryId },
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
    deps.gate.recordFailure(scope, "malformed");
    return failed(prepareFailure("malformed", false));
  }
  deps.gate.recordSuccess(scope);
  return { ok: true, details, usage: result.usage };
}

export function createAnthropicNativeBackend(
  deps: AnthropicBackendDeps,
): Backend<AnthropicDetails> {
  return new AnthropicNativeBackend(deps);
}

export function anthropicBackendFactory(
  depsFor: (context: BackendFactoryContext) => AnthropicBackendDeps,
): BackendFactory {
  return (context) => createAnthropicNativeBackend(depsFor(context));
}
