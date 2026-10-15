import { createHash, randomUUID } from "node:crypto";
import { CODEX_TURN_STATE_HEADER } from "../../providers/openai-codex/turn-state.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  JsonValueSchema,
  ProviderScopeSchema,
  type Backend,
  type FrozenSnapshot,
  type PreparationBudget,
  type PrepareFailure,
  type ProviderScope,
} from "../../../../choco-pi-compaction/src/background/contract.ts";
import type { AdapterState } from "../activation/state.ts";
import { isResponsesBody, type ResponsesBody } from "../../providers/openai-codex/types.ts";
import {
  cleanupOpenAICodexTransportSession,
  resetOpenAICodexTransportSession,
} from "../../providers/openai-codex/transport-cleanup.ts";
import { executeRemoteCompactionV2, type RemoteCompactionV2Result } from "./remote-v2-client.ts";
import { buildRemoteCompactionV2Window } from "./remote-v2-history.ts";
import type { NativeCompactionRuntime } from "./compaction-runtime.ts";
import {
  isBackgroundNativeCompactionDetails,
  isCodexBackgroundScopeCompatible,
  persistCodexBackgroundDetails,
  cloneCodexCompactionJson,
} from "./details-store.ts";
import {
  NATIVE_COMPACTION_STRATEGY,
  NATIVE_COMPACTION_SHIM_SUMMARY,
  type BackgroundNativeCompactionDetails,
} from "./types.ts";
import type { ResponsesInputItem } from "./serializer.ts";
import { isCanonicalCodexBaseUrl } from "../prompt/codex-model.ts";
import {
  canonicalCompactionRequestBody,
  resolveCanonicalCompactionPrefixInput,
} from "../../providers/openai-codex/session-continuity.ts";
import {
  extractAccountId,
  resolveCodexWebSocketUrl,
} from "../../providers/openai-codex/headers.ts";

export const CODEX_BACKGROUND_BACKEND_ID = "codex-native-v2";

/** Full canonical request, not the last WebSocket delta; captured before preparation. */
interface CodexBackgroundCapture {
  readonly sessionId: string;
  readonly providerScope: ProviderScope;
  readonly body: ResponsesBody;
}
const CaptureSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    providerScope: ProviderScopeSchema,
    body: JsonValueSchema,
  },
  { additionalProperties: false },
);
export function isCodexBackgroundCapture<T>(value: T): value is T & CodexBackgroundCapture {
  return (
    Value.Check(CaptureSchema, value) &&
    isResponsesBody(value.body) &&
    value.body.model === value.providerScope.model
  );
}

/** Why a capture at the cut was refused; surfaces as the failure's detail code. */
export type CodexCaptureRefusal =
  | "no-base-url"
  | "unsupported-scope"
  | "account-scope-mismatch"
  | "no-canonical-body"
  | "empty_cut"
  | "no_state"
  | "model_mismatch"
  | "identity_mismatch"
  | "input_shorter_than_baseline"
  | "request_prefix_mismatch"
  | "response_prefix_mismatch"
  | "not_applicable"
  | "capture-shape";

export type CodexCaptureResult =
  | { readonly ok: true; readonly capture: CodexBackgroundCapture }
  | { readonly ok: false; readonly refusal: CodexCaptureRefusal };

/**
 * Synchronous capture at the cut. The cut must be a prefix of the canonical history (it may end
 * before the latest response); the captured input is the canonical items for that prefix.
 */
export function captureCodexBackgroundRequest(args: {
  sessionId: string;
  providerScope: ProviderScope;
  accountId: string;
  reconstructedInput: readonly ResponsesInputItem[];
}): CodexBackgroundCapture | undefined {
  const result = resolveCodexBackgroundCapture(args);
  return result.ok ? result.capture : undefined;
}

/** `captureCodexBackgroundRequest` with the refusal named. */
export function resolveCodexBackgroundCapture(args: {
  sessionId: string;
  providerScope: ProviderScope;
  accountId: string;
  reconstructedInput: readonly ResponsesInputItem[];
}): CodexCaptureResult {
  const { sessionId, providerScope, accountId, reconstructedInput } = args;
  if (!providerScope.baseUrl) return { ok: false, refusal: "no-base-url" };
  if (!supportedScope(providerScope)) return { ok: false, refusal: "unsupported-scope" };
  if (codexBackgroundAccountScope(accountId) !== providerScope.accountScope)
    return { ok: false, refusal: "account-scope-mismatch" };
  const identity = { url: resolveCodexWebSocketUrl(providerScope.baseUrl), accountId };
  const resolved = resolveCanonicalCompactionPrefixInput(
    sessionId,
    providerScope.model,
    identity,
    reconstructedInput,
  );
  const body = canonicalCompactionRequestBody(sessionId, providerScope.model, identity);
  if (resolved.decision !== "validated") return { ok: false, refusal: resolved.decision };
  if (!body || !resolved.input) return { ok: false, refusal: "no-canonical-body" };
  const detached = cloneCodexCompactionJson({
    sessionId,
    providerScope,
    body: { ...body, input: resolved.input },
  });
  return isCodexBackgroundCapture(detached)
    ? { ok: true, capture: detached }
    : { ok: false, refusal: "capture-shape" };
}

export interface CodexBackgroundBackendOptions {
  readonly modelRegistry: ModelRegistry;
  readonly resolveRuntime: (
    scope: ProviderScope,
    signal: AbortSignal,
  ) => Promise<NativeCompactionRuntime | PrepareFailure>;
  readonly isCurrent: (ownerKey: string, generation: number, scope: ProviderScope) => boolean;
  readonly fetch?: typeof globalThis.fetch;
}
export function codexBackgroundAccountScope(accountId: string): string {
  return `sha256:${createHash("sha256").update(accountId).digest("hex")}`;
}
function supportedScope(scope: ProviderScope): boolean {
  return (
    scope.provider === "openai-codex" &&
    scope.authMode === "oauth" &&
    /^sha256:[a-f0-9]{64}$/.test(scope.accountScope ?? "") &&
    isCanonicalCodexBaseUrl(scope.baseUrl)
  );
}
/** Cooldown before retrying after rejected credentials. */
const AUTH_RETRY_AFTER_MS = 60_000;
/** Cooldown before retrying an endpoint, model or request shape the lane cannot use. */
const UNSUPPORTED_RETRY_AFTER_MS = 60_000;
/** Cooldown for HTTP 429 when the provider sent no usable Retry-After. */
const RATE_LIMIT_DEFAULT_RETRY_AFTER_MS = 60_000;
/** Short backoff after the preparation deadline elapsed. */
const TIMEOUT_RETRY_AFTER_MS = 1_000;
/** Largest delay `setTimeout` accepts without overflowing to an immediate timer. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Conservative UTF-8 bytes-per-token ratio for the pre-flight input estimate. */
const ESTIMATED_BYTES_PER_TOKEN = 4;

/** Terminal failure: the scheduler must not retry this candidate. */
function rejected(reason: PrepareFailure["reason"]): PrepareFailure {
  return { ok: false, reason, retryable: false };
}
function authFailure(): PrepareFailure {
  return { ok: false, reason: "auth", retryable: false, retryAfterMs: AUTH_RETRY_AFTER_MS };
}
function unsupportedCooldownFailure(): PrepareFailure {
  return {
    ok: false,
    reason: "unsupported",
    retryable: false,
    retryAfterMs: UNSUPPORTED_RETRY_AFTER_MS,
  };
}
function rateLimitFailure(retryAfterMs = RATE_LIMIT_DEFAULT_RETRY_AFTER_MS): PrepareFailure {
  return { ok: false, reason: "429", retryable: true, retryAfterMs };
}
function timeoutFailure(): PrepareFailure {
  return { ok: false, reason: "timeout", retryable: true, retryAfterMs: TIMEOUT_RETRY_AFTER_MS };
}

function isAuthRejection(result: Extract<RemoteCompactionV2Result, { ok: false }>): boolean {
  return (
    result.status === 401 ||
    result.status === 403 ||
    /unauthori[sz]ed|forbidden/i.test(result.errorMessage)
  );
}
function isUnsupportedRejection(result: Extract<RemoteCompactionV2Result, { ok: false }>): boolean {
  return (
    result.reason === "unsupported" ||
    result.reason === "unavailable" ||
    result.status === 404 ||
    /unsupported|not included/i.test(result.errorMessage)
  );
}
function classifyFailure(result: Extract<RemoteCompactionV2Result, { ok: false }>): PrepareFailure {
  if (result.reason === "aborted") return rejected("canceled");
  if (result.status === 429) return rateLimitFailure(result.retryAfterMs);
  if (isAuthRejection(result)) return authFailure();
  if (result.reason === "oversized") return rejected("oversized");
  if (result.reason === "invalid-output") return rejected("malformed");
  if (isUnsupportedRejection(result)) return unsupportedCooldownFailure();
  if (/timeout|timed out/i.test(result.errorMessage)) return timeoutFailure();
  return rejected("malformed");
}
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Codex background preparation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([operation, canceled]).finally(() => {
    if (abort) signal.removeEventListener("abort", abort);
  });
}

const JsonRecordSchema = Type.Record(Type.String(), JsonValueSchema);
const CallIdSchema = Type.String({ minLength: 1 });

/** Tracks open function/custom-tool groups; false when the input cannot form a legal cut. */
function acceptLegalCutItem(
  item: ResponsesBody["input"][number],
  open: Set<string>,
  seen: Set<string>,
): boolean {
  if (!Value.Check(JsonRecordSchema, item)) return false;
  if (item["type"] === "compaction_trigger" || item["status"] === "in_progress") return false;
  if (item["type"] === "function_call" || item["type"] === "custom_tool_call") {
    if (!Value.Check(CallIdSchema, item["call_id"]) || seen.has(item["call_id"])) return false;
    seen.add(item["call_id"]);
    open.add(item["call_id"]);
  }
  if (item["type"] === "function_call_output" || item["type"] === "custom_tool_call_output")
    return Value.Check(Type.String(), item["call_id"]) && open.delete(item["call_id"]);
  return true;
}

/** Undefined when the captured input can be cut; otherwise the reason it cannot. */
function illegalCaptureDetail(snapshot: FrozenSnapshot): string | undefined {
  const capture = snapshot.backendCapture;
  if (!isCodexBackgroundCapture(capture)) return "no-capture";
  if (!Value.Equal(capture.providerScope, snapshot.providerScope)) return "scope-mismatch";
  // Never summarize an open function/custom-tool group or an in-progress message.
  const open = new Set<string>();
  const seen = new Set<string>();
  for (const item of capture.body.input) {
    if (!acceptLegalCutItem(item, open, seen)) return "illegal-input-item";
  }
  return open.size === 0 ? undefined : "open-tool-call";
}

type PrepareRequest = Parameters<Backend<BackgroundNativeCompactionDetails>["prepare"]>[1];
type PrepareResult = Awaited<ReturnType<Backend<BackgroundNativeCompactionDetails>["prepare"]>>;

/** Every input/settings/identity scalar detached before the first await. */
interface FrozenPreparation {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly prefixFingerprint: string;
  readonly cutEntryId: string;
  readonly tokenEstimate: number;
  readonly scope: ProviderScope;
  readonly budget: PreparationBudget;
  readonly candidateId: string;
  readonly callerSignal: AbortSignal;
  readonly captureSessionId: string;
  readonly body: ResponsesBody;
  readonly input: ResponsesInputItem[];
  readonly laneSessionId: string;
  readonly remainingMs: number;
}

function exceedsInputBudget(
  tokenEstimate: number,
  body: ResponsesBody,
  budget: PreparationBudget,
): boolean {
  const estimatedBodyTokens = Math.ceil(
    Buffer.byteLength(JSON.stringify(body), "utf8") / ESTIMATED_BYTES_PER_TOKEN,
  );
  return (
    !Number.isFinite(tokenEstimate) ||
    tokenEstimate > budget.maxInputTokens ||
    estimatedBodyTokens > budget.maxInputTokens
  );
}
function isWellFormedBudget(budget: PreparationBudget): boolean {
  const limits = [
    budget.maxAttempts,
    budget.maxInputTokens,
    budget.maxOutputTokens,
    budget.maxResultBytes,
  ];
  return (
    limits.every((value) => Number.isSafeInteger(value) && value > 0) &&
    Number.isFinite(budget.deadlineMs)
  );
}
function withoutTurnStateHeader<T>(
  entries: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries ?? {}).filter(([key]) => key.toLowerCase() !== CODEX_TURN_STATE_HEADER),
  );
}

/** Fresh lane identity and prompt cache key; stale foreground turn-state hints are dropped. */
function isolateLaneRequest(body: ResponsesBody, captureSessionId: string): string {
  const laneSessionId = `${captureSessionId}:background-compaction:${randomUUID()}`;
  body.prompt_cache_key = randomUUID();
  body.client_metadata = {
    ...withoutTurnStateHeader(body.client_metadata),
    session_id: laneSessionId,
    thread_id: laneSessionId,
  };
  return laneSessionId;
}

function freezePreparation(
  snapshot: FrozenSnapshot,
  request: PrepareRequest,
): FrozenPreparation | PrepareFailure {
  const { ownerKey, ownerGeneration, prefixFingerprint, cutEntryId, tokenEstimate } = snapshot;
  const scope = Object.freeze(structuredClone(snapshot.providerScope));
  const budget = { ...request.budget };
  const { candidateId, signal: callerSignal } = request;
  if (callerSignal.aborted) return rejected("canceled");
  if (!supportedScope(scope)) return rejected("unsupported");
  const illegal = illegalCaptureDetail(snapshot);
  if (illegal !== undefined || !isCodexBackgroundCapture(snapshot.backendCapture)) {
    const failure: PrepareFailure = {
      ok: false,
      reason: "no-legal-cut",
      retryable: false,
      detail: illegal ?? "no-capture",
    };
    return failure;
  }
  const capture = structuredClone(snapshot.backendCapture);
  const body = capture.body;
  if (body.access_programs !== undefined) return unsupportedCooldownFailure();
  body.previous_response_id = undefined;
  const input = body.input.filter((item): item is ResponsesInputItem =>
    Value.Check(JsonRecordSchema, item),
  );
  if (exceedsInputBudget(tokenEstimate, body, budget)) return rejected("oversized");
  if (!isWellFormedBudget(budget)) return rejected("malformed");
  const remainingMs = budget.deadlineMs - Date.now();
  if (remainingMs <= 0) return timeoutFailure();
  const laneSessionId = isolateLaneRequest(body, capture.sessionId);
  return {
    ownerKey,
    ownerGeneration,
    prefixFingerprint,
    cutEntryId,
    tokenEstimate,
    scope,
    budget,
    candidateId,
    callerSignal,
    captureSessionId: capture.sessionId,
    body,
    input,
    laneSessionId,
    remainingMs,
  };
}

/** Caller cancellation, the preparation deadline, and lane teardown share one signal. */
interface PreparationLane {
  readonly callerSignal: AbortSignal;
  readonly deadlineSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly close: () => void;
}
function openPreparationLane(callerSignal: AbortSignal, remainingMs: number): PreparationLane {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    Math.min(Math.ceil(remainingMs), MAX_TIMER_DELAY_MS),
  );
  const lane = new AbortController();
  return {
    callerSignal,
    deadlineSignal: deadline.signal,
    signal: AbortSignal.any([callerSignal, deadline.signal, lane.signal]),
    close: () => {
      lane.abort();
      clearTimeout(timer);
    },
  };
}
function stopFailure(lane: PreparationLane): PrepareFailure | undefined {
  if (lane.callerSignal.aborted) return rejected("canceled");
  if (lane.deadlineSignal.aborted) return timeoutFailure();
  return undefined;
}
/** The post-await currency check: cancellation, deadline, then owner/scope. */
function interruptedFailure(
  lane: PreparationLane,
  isOwnerCurrent: () => boolean,
): PrepareFailure | undefined {
  return stopFailure(lane) ?? (isOwnerCurrent() ? undefined : rejected("incompatible"));
}

function isRuntimeForScope(runtime: NativeCompactionRuntime, scope: ProviderScope): boolean {
  return (
    Boolean(runtime.baseUrl) &&
    runtime.codexTransport &&
    runtime.api === "openai-codex-responses" &&
    runtime.apiFamily === "openai-codex-responses" &&
    runtime.provider === scope.provider &&
    runtime.model === scope.model &&
    runtime.baseUrl === scope.baseUrl &&
    runtime.currentModel.provider === scope.provider &&
    runtime.currentModel.api === "openai-codex-responses" &&
    isCanonicalCodexBaseUrl(runtime.currentModel.baseUrl) &&
    runtime.currentModel.id === scope.model
  );
}
function runtimeAccountScope(apiKey: string): string | undefined {
  try {
    return codexBackgroundAccountScope(extractAccountId(apiKey));
  } catch {
    return undefined;
  }
}
function validateRuntime(
  runtime: NativeCompactionRuntime,
  scope: ProviderScope,
): PrepareFailure | undefined {
  if (!isRuntimeForScope(runtime, scope)) return rejected("incompatible");
  if (!runtime.apiKey) return authFailure();
  const accountScope = runtimeAccountScope(runtime.apiKey);
  if (accountScope === undefined) return authFailure();
  if (accountScope !== scope.accountScope) return rejected("incompatible");
  return undefined;
}
/** Stale foreground turn-state hints never reach the detached lane's headers. */
function freezeLaneRuntime(runtime: NativeCompactionRuntime): NativeCompactionRuntime {
  return {
    ...runtime,
    currentModel: {
      ...structuredClone(runtime.currentModel),
      headers: withoutTurnStateHeader(runtime.currentModel.headers),
    },
    headers: withoutTurnStateHeader(runtime.headers),
  };
}

async function runLaneCompaction(
  options: CodexBackgroundBackendOptions,
  frozen: FrozenPreparation,
  runtime: NativeCompactionRuntime,
  signal: AbortSignal,
): Promise<RemoteCompactionV2Result> {
  const { laneSessionId, budget } = frozen;
  const operation = executeRemoteCompactionV2({
    runtime,
    modelRegistry: options.modelRegistry,
    context: normalizeContext({ messages: [] }),
    promptInput: frozen.input,
    requestOptions: {},
    tokensBefore: frozen.tokenEstimate,
    sessionId: laneSessionId,
    signal,
    transport: "sse",
    promptInputSource: "reconstructed",
    frozenRequestBody: frozen.body,
    maxRetries: 0,
    maxOutputTokens: budget.maxOutputTokens,
    maxResultBytes: budget.maxResultBytes,
    fetch: options.fetch,
  });
  return withAbort(
    operation.finally(() => cleanupOpenAICodexTransportSession(laneSessionId)),
    signal,
  );
}

function buildPreparedCheckpoint(
  frozen: FrozenPreparation,
  runtime: NativeCompactionRuntime,
  result: RemoteCompactionV2Result,
): PrepareResult {
  if (!result.ok) return classifyFailure(result);
  const usage = result.usage;
  if (!usage) return rejected("malformed");
  if (usage.inputTokens > frozen.budget.maxInputTokens) return rejected("oversized");
  const details = persistCodexBackgroundDetails({
    strategy: NATIVE_COMPACTION_STRATEGY,
    schemaVersion: 1,
    candidateId: frozen.candidateId,
    prefixFingerprint: frozen.prefixFingerprint,
    provider: runtime.provider,
    api: runtime.api,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    compactedWindow: buildRemoteCompactionV2Window(frozen.input, result.compaction),
    compactResponseId: result.responseId,
    createdAt: result.createdAt,
    background: {
      sessionId: frozen.captureSessionId,
      ownerKey: frozen.ownerKey,
      ownerGeneration: frozen.ownerGeneration,
      cutEntryId: frozen.cutEntryId,
      providerScope: frozen.scope,
      retentionPolicyVersion: 1,
    },
    usage,
  });
  if (Buffer.byteLength(JSON.stringify(details), "utf8") > frozen.budget.maxResultBytes)
    return rejected("oversized");
  return {
    candidateId: frozen.candidateId,
    backendId: CODEX_BACKGROUND_BACKEND_ID,
    schemaVersion: 1,
    draft: {
      type: "compaction",
      summary: NATIVE_COMPACTION_SHIM_SUMMARY,
      firstKeptEntryId: frozen.cutEntryId,
      details,
    },
    details,
    usage: { input: usage.inputTokens, output: usage.outputTokens },
    reasonCodes: ["prepared"],
  };
}

async function runPreparation(
  options: CodexBackgroundBackendOptions,
  frozen: FrozenPreparation,
  lane: PreparationLane,
  isOwnerCurrent: () => boolean,
): Promise<PrepareResult> {
  const resolved = await withAbort(options.resolveRuntime(frozen.scope, lane.signal), lane.signal);
  const afterRuntime = interruptedFailure(lane, isOwnerCurrent);
  if (afterRuntime) return afterRuntime;
  if ("ok" in resolved) return resolved;
  const invalidRuntime = validateRuntime(resolved, frozen.scope);
  if (invalidRuntime) return invalidRuntime;
  const runtime = freezeLaneRuntime(resolved);
  const result = await runLaneCompaction(options, frozen, runtime, lane.signal);
  const afterCompaction = interruptedFailure(lane, isOwnerCurrent);
  if (afterCompaction) return afterCompaction;
  return buildPreparedCheckpoint(frozen, runtime, result);
}

async function prepareBackgroundCheckpoint(
  options: CodexBackgroundBackendOptions,
  snapshot: FrozenSnapshot,
  request: PrepareRequest,
): Promise<PrepareResult> {
  const frozen = freezePreparation(snapshot, request);
  if ("ok" in frozen) return frozen;
  const { ownerKey, ownerGeneration, scope } = frozen;
  const isOwnerCurrent = () => options.isCurrent(ownerKey, ownerGeneration, scope);
  if (!isOwnerCurrent()) return rejected("incompatible");
  const lane = openPreparationLane(frozen.callerSignal, frozen.remainingMs);
  try {
    return await runPreparation(options, frozen, lane, isOwnerCurrent);
  } catch (error) {
    const stopped = stopFailure(lane);
    if (stopped) return stopped;
    throw error;
  } finally {
    lane.close();
    cleanupOpenAICodexTransportSession(frozen.laneSessionId);
  }
}

/** Backend only: the coordinator owns scheduling, persistence and commit observation. */
export function createCodexBackgroundBackend(
  options: CodexBackgroundBackendOptions,
): Backend<BackgroundNativeCompactionDetails> {
  const frozenOptions: CodexBackgroundBackendOptions = { ...options };
  return {
    id: CODEX_BACKGROUND_BACKEND_ID,
    capability: (scope) =>
      Promise.resolve(
        supportedScope(scope) ? { supported: true } : { supported: false, reason: "unsupported" },
      ),
    isLegalCut: (snapshot) => {
      const illegal = illegalCaptureDetail(snapshot);
      return illegal === undefined
        ? { legal: true }
        : { legal: false, reason: "no-legal-cut", detail: illegal };
    },
    prepare: (snapshot, request) => prepareBackgroundCheckpoint(frozenOptions, snapshot, request),
  };
}

/** Call only after the coordinator's commit acknowledgment; fail closed on reload/switch. */
export function installCodexBackgroundCheckpoint(args: {
  readonly sessionId: string;
  readonly committedEntryId: string;
  readonly candidateId: string;
  readonly fingerprint: string;
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly currentScope: ProviderScope;
  readonly details: BackgroundNativeCompactionDetails;
  readonly state: Pick<AdapterState, "pendingPiCompactionNativeWindow">;
}): void {
  const { details } = args;
  if (
    !args.sessionId ||
    !args.committedEntryId ||
    !isBackgroundNativeCompactionDetails(details) ||
    details.background.sessionId !== args.sessionId ||
    details.candidateId !== args.candidateId ||
    details.prefixFingerprint !== args.fingerprint ||
    details.background.ownerKey !== args.ownerKey ||
    details.background.ownerGeneration !== args.ownerGeneration ||
    !isCodexBackgroundScopeCompatible(details, args.currentScope)
  )
    throw new Error("Codex native checkpoint incompatible with adoption owner or provider scope");
  const window = details.compactedWindow;
  resetOpenAICodexTransportSession(args.sessionId);
  args.state.pendingPiCompactionNativeWindow = {
    window: structuredClone(window),
    provider: details.provider,
    api: details.api,
    baseUrl: details.baseUrl,
    sessionId: args.sessionId,
    sourceCompactionEntryId: args.committedEntryId,
  };
}

/** Mandatory compatibility guard for committed checkpoints, even when preparation is disabled. */
export function buildCodexBackgroundReplay(
  details: BackgroundNativeCompactionDetails,
  scope: ProviderScope,
  exactTail: readonly ResponsesInputItem[],
): ResponsesInputItem[] {
  if (
    !isBackgroundNativeCompactionDetails(details) ||
    !isCodexBackgroundScopeCompatible(details, scope)
  )
    throw new Error(
      "Committed Codex native checkpoint is incompatible with current model/account/endpoint; replay refused",
    );
  const window: readonly ResponsesInputItem[] = details.compactedWindow;
  return [...window.map((item) => structuredClone(item)), ...structuredClone(exactTail)];
}
