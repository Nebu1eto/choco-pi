import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { mainOwnerKey } from "../../../choco-pi-compaction/src/ownership.ts";
import {
  backgroundSettingsPaths,
  loadBackgroundSettings,
} from "../../../choco-pi-compaction/src/background/settings.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  Adoption,
  Backend,
  BackendFactoryContext,
  CoordinatorApi,
  FrozenSnapshot,
  ProviderScope,
} from "../../../choco-pi-compaction/src/background/contract.ts";
import {
  getCoordinator,
  getRegistry,
  registerBackendFactory,
} from "../../../choco-pi-compaction/src/background/registry.ts";
import {
  buildCodexBackgroundReplay,
  captureCodexBackgroundRequest,
  CODEX_BACKGROUND_BACKEND_ID,
  codexBackgroundAccountScope,
  createCodexBackgroundBackend,
  installCodexBackgroundCheckpoint,
  type CodexBackgroundBackendOptions,
} from "../adapter/compaction/background-v2.ts";
import {
  isBackgroundNativeCompactionDetails,
  resolveLatestNativeCompactionEntry,
} from "../adapter/compaction/details-store.ts";
import { serializeActiveSessionToResponsesInput } from "../adapter/compaction/serializer.ts";
import type { BackgroundNativeCompactionDetails } from "../adapter/compaction/types.ts";
import type { NativeCompactionRuntime } from "../adapter/compaction/compaction-runtime.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import { extractAccountId } from "../providers/openai-codex/headers.ts";
import { withLiveCtx } from "./live-context.ts";

export const codexBackgroundOwnerKey = mainOwnerKey;

const AdoptionSignalSchema = Type.Object(
  { version: Type.Literal(1), willAdopt: Type.Function([], Type.Unknown()) },
  { additionalProperties: true },
);
function isAdoptionSignal<T>(source: T): source is T & {
  readonly willAdopt: (sessionId: string, event: SessionBeforeCompactEvent) => Promise<boolean>;
} {
  return Value.Check(AdoptionSignalSchema, source);
}
/** Avoid importing the host extension's provider implementations into the Codex package. */
export async function willAdoptCodexBackgroundCheckpoint(
  sessionId: string,
  event: SessionBeforeCompactEvent,
): Promise<boolean> {
  const slot: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    Symbol.for("choco-pi:compaction-background-adoption"),
  )?.value;
  if (slot === undefined) return false;
  if (!isAdoptionSignal(slot)) throw new Error("Invalid background compaction adoption signal");
  const answer = await slot.willAdopt(sessionId, event);
  if (!Value.Check(Type.Boolean(), answer)) throw new Error("Invalid background adoption decision");
  return answer;
}

export function codexBackgroundAuthToken(
  apiKey: string | undefined,
  headers: Readonly<Record<string, string | null>> | undefined,
): string | undefined {
  if (apiKey) return apiKey;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "authorization" && value !== null) {
      const match = /^Bearer\s+(.+)$/i.exec(value);
      return match?.[1];
    }
  }
  return undefined;
}

const ImageSettingsSchema = Type.Object(
  {
    images: Type.Optional(
      Type.Object({ blockImages: Type.Optional(Type.Boolean()) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

/** Resolve background settings through the host seam; snapshot image policy with async I/O. */
async function resolveCodexBackgroundSettings(
  cwd: string,
  trusted: boolean,
): Promise<CodexBackgroundSettings> {
  const agentDir = getAgentDir();
  const loaded = await loadBackgroundSettings(
    backgroundSettingsPaths({ cwd, agentDir, projectTrusted: trusted }),
  );
  if (!loaded.settings.enabled || !loaded.settings.codexNative) {
    const disabled: CodexBackgroundSettings = { enabled: false, blockImages: false };
    return loaded.diagnostic === undefined
      ? disabled
      : { ...disabled, diagnostic: loaded.diagnostic };
  }
  let blockImages = false;
  for (const path of [
    join(agentDir, "settings.json"),
    ...(trusted ? [join(cwd, ".pi", "settings.json")] : []),
  ]) {
    let settings: unknown;
    try {
      settings = JSON.parse(await readFile(path, "utf8"));
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      return {
        enabled: false,
        blockImages: false,
        diagnostic: "Cannot snapshot image settings; Codex background compaction disabled",
      };
    }
    if (!Value.Check(ImageSettingsSchema, settings))
      return {
        enabled: false,
        blockImages: false,
        diagnostic: "Invalid image settings; Codex background compaction disabled",
      };
    if (settings.images?.blockImages !== undefined) blockImages = settings.images.blockImages;
  }
  return { enabled: true, blockImages };
}

export interface CodexBackgroundElisionState {
  epoch: string;
  cut: number;
}
export function updateCodexBackgroundElision(
  states: Map<string, CodexBackgroundElisionState>,
  sessionId: string,
  epoch: string,
): void {
  states.set(sessionId, { epoch, cut: 0 });
}

export type CodexBackgroundContext = Pick<
  ExtensionContext,
  "sessionManager" | "model" | "modelRegistry" | "cwd" | "isProjectTrusted"
> & { readonly ui: Pick<ExtensionContext["ui"], "notify"> };

interface CodexBackgroundSettings {
  readonly enabled: boolean;
  readonly blockImages: boolean;
  readonly diagnostic?: string;
}
export interface CodexBackgroundBinding {
  readonly sessionId: string;
  readonly ctx: CodexBackgroundContext;
  readonly model: Model<Api>;
  readonly scope: ProviderScope;
  readonly accountId: string;
  runtime: NativeCompactionRuntime;
  readonly state: Pick<AdapterState, "pendingPiCompactionNativeWindow">;
  readonly cleanup: Set<() => void>;
  readonly blockImages: boolean;
  readonly isCurrent: () => boolean;
  readonly onInstalled: (sessionId: string, epoch: string) => void;
  readonly fetch?: typeof globalThis.fetch;
}
const bindings = new Map<string, CodexBackgroundBinding>();

/** Register once per ID, yielding to any host-owned factory already registered. */
export function registerCodexBackgroundFactory(enabled: boolean): boolean {
  if (!enabled || getRegistry().backendFactories.has(CODEX_BACKGROUND_BACKEND_ID)) return false;
  registerBackendFactory(CODEX_BACKGROUND_BACKEND_ID, (context) => {
    let selected: CodexBackgroundBinding | undefined;
    let backend: Backend | undefined;
    const resolve = (): Backend | undefined => {
      const binding = bindings.get(context.ownerKey);
      if (binding === undefined || !binding.isCurrent()) return undefined;
      if (binding !== selected) {
        selected = binding;
        backend = createCapturedCodexBackend(context, binding);
      }
      return backend;
    };
    return {
      id: CODEX_BACKGROUND_BACKEND_ID,
      capability: (scope) =>
        resolve()?.capability(scope) ??
        Promise.resolve({ supported: false, reason: "unsupported" }),
      isLegalCut: (snapshot) =>
        resolve()?.isLegalCut(snapshot) ?? { legal: false, reason: "no-legal-cut" },
      prepare: (snapshot, request) =>
        resolve()?.prepare(snapshot, request) ??
        Promise.resolve({ ok: false, reason: "unsupported", retryable: false }),
    };
  });
  return true;
}

function freezeDetachedCapture<T>(source: T): T {
  if (
    Value.Check(
      Type.Union([Type.Array(Type.Unknown()), Type.Record(Type.String(), Type.Unknown())]),
      source,
    )
  ) {
    const children: unknown[] = Object.values(source);
    for (const child of children) freezeDetachedCapture(child);
    Object.freeze(source);
  }
  return source;
}

/** The adoption consumer registered with the owner's current coordinator, if any. */
interface AdoptionConsumerSlot {
  coordinator: CoordinatorApi | undefined;
  removeConsumer: (() => void) | undefined;
  readonly adopted: Set<string>;
}
function detachAdoptionConsumer(slot: AdoptionConsumerSlot): void {
  slot.removeConsumer?.();
  slot.adopted.clear();
}
/** Follow coordinator replacement; register only with the owner generation this backend serves. */
function attachAdoptionConsumer(
  slot: AdoptionConsumerSlot,
  context: BackendFactoryContext,
  binding: CodexBackgroundBinding,
): void {
  const current = getCoordinator(context.ownerKey);
  if (current === slot.coordinator) return;
  detachAdoptionConsumer(slot);
  slot.coordinator = current;
  if (current === undefined || current.ownerGeneration !== context.ownerGeneration) return;
  slot.removeConsumer = current.registerConsumer({
    id: `codex-native:${binding.sessionId}`,
    onAdopted: (adoption) => {
      withLiveCtx(() => consumeCodexBackgroundAdoption(binding, context, adoption, slot.adopted));
    },
  });
}

function createNativeBackend(
  context: BackendFactoryContext,
  binding: CodexBackgroundBinding,
  slot: AdoptionConsumerSlot,
): Backend<BackgroundNativeCompactionDetails> {
  const nativeOptions: CodexBackgroundBackendOptions = {
    modelRegistry: binding.ctx.modelRegistry,
    resolveRuntime: async () =>
      binding.isCurrent() ? binding.runtime : { ok: false, reason: "canceled", retryable: false },
    isCurrent: (_owner, generation) =>
      binding.isCurrent() &&
      generation === context.ownerGeneration &&
      (slot.coordinator === undefined || getCoordinator(context.ownerKey) === slot.coordinator),
  };
  return createCodexBackgroundBackend(
    binding.fetch === undefined ? nativeOptions : { ...nativeOptions, fetch: binding.fetch },
  );
}

/** Serialize the frozen cut and attach the canonical request; null when it cannot be captured. */
function captureFrozenCut(
  context: BackendFactoryContext,
  binding: CodexBackgroundBinding,
  snapshot: FrozenSnapshot,
): FrozenSnapshot | null {
  if (
    !binding.isCurrent() ||
    snapshot.ownerKey !== context.ownerKey ||
    snapshot.ownerGeneration !== context.ownerGeneration
  )
    return null;
  const input = serializeActiveSessionToResponsesInput({
    model: binding.model,
    entries: [...snapshot.entries],
    options: { blockImages: binding.blockImages },
  });
  const request = captureCodexBackgroundRequest({
    sessionId: binding.sessionId,
    providerScope: snapshot.providerScope,
    accountId: binding.accountId,
    reconstructedInput: input,
  });
  if (request === undefined) return null;
  return Object.freeze({ ...snapshot, backendCapture: freezeDetachedCapture(request) });
}

/** Captures once per frozen cut; prepare never replaces it with newer foreground history. */
export function createCapturedCodexBackend(
  context: BackendFactoryContext,
  binding: CodexBackgroundBinding,
): Backend {
  const captures = new WeakMap<FrozenSnapshot, FrozenSnapshot | null>();
  const slot: AdoptionConsumerSlot = {
    coordinator: undefined,
    removeConsumer: undefined,
    adopted: new Set(),
  };
  binding.cleanup.add(() => detachAdoptionConsumer(slot));
  const native = createNativeBackend(context, binding, slot);
  const capture = (snapshot: FrozenSnapshot): FrozenSnapshot | null => {
    if (captures.has(snapshot)) return captures.get(snapshot) ?? null;
    attachAdoptionConsumer(slot, context, binding);
    const result = captureFrozenCut(context, binding, snapshot);
    captures.set(snapshot, result);
    return result;
  };
  return {
    id: native.id,
    capability: (scope) => {
      attachAdoptionConsumer(slot, context, binding);
      return native.capability(scope);
    },
    isLegalCut: (snapshot) => {
      const augmented = capture(snapshot);
      return augmented === null
        ? { legal: false, reason: "no-legal-cut" }
        : native.isLegalCut(augmented);
    },
    prepare: (snapshot, request) => {
      const augmented = capture(snapshot);
      return augmented === null
        ? Promise.resolve({ ok: false, reason: "no-legal-cut", retryable: false })
        : native.prepare(augmented, request);
    },
  };
}

/** Verify the committed branch entry before touching any transport state. */
export function consumeCodexBackgroundAdoption(
  binding: CodexBackgroundBinding,
  context: BackendFactoryContext,
  adoption: Adoption,
  adopted: Set<string>,
): void {
  if (adopted.has(adoption.adoptionId) || !binding.isCurrent()) return;
  // A text-lane checkpoint on a Codex model is an expected fallback; nothing native to install.
  if (adoption.backendId !== CODEX_BACKGROUND_BACKEND_ID) return;
  const entry = binding.ctx.sessionManager
    .getBranch()
    .find((item) => item.id === adoption.committedEntryId);
  if (
    entry?.type !== "compaction" ||
    !isBackgroundNativeCompactionDetails(entry.details) ||
    entry.details.candidateId !== adoption.candidateId ||
    entry.details.prefixFingerprint !== adoption.fingerprint
  )
    throw new Error("Codex background adoption has no matching committed native checkpoint");
  buildCodexBackgroundReplay(entry.details, binding.scope, []);
  installCodexBackgroundCheckpoint({
    details: entry.details,
    sessionId: binding.sessionId,
    committedEntryId: entry.id,
    candidateId: adoption.candidateId,
    fingerprint: adoption.fingerprint,
    ownerKey: context.ownerKey,
    ownerGeneration: context.ownerGeneration,
    currentScope: binding.scope,
    state: binding.state,
  });
  adopted.add(adoption.adoptionId);
  binding.onInstalled(binding.sessionId, entry.id);
}

function codexBackgroundRequestState(state: AdapterState, incompatible: boolean): AdapterState {
  if (!incompatible) return state;
  return {
    ...state,
    config: {
      ...state.config,
      compaction: { ...state.config.compaction, responsesCompaction: false },
    },
    pendingPiCompactionNativeWindow: undefined,
  };
}

const BackgroundCheckpointMarkerSchema = Type.Object(
  { strategy: Type.Literal("openai-responses-compaction-v2"), schemaVersion: Type.Literal(1) },
  { additionalProperties: true },
);

interface CodexBackgroundIntegrationOptions {
  readonly resolveSettings?: (cwd: string, trusted: boolean) => Promise<CodexBackgroundSettings>;
  readonly state: Pick<AdapterState, "pendingPiCompactionNativeWindow">;
  readonly onInstalled: (sessionId: string, epoch: string) => void;
}

/** Generation snapshot taken before a handler's first await. */
interface CodexBackgroundFence {
  readonly generation: number;
  /** False while background compaction is disabled or unbound: legacy paths are never fenced. */
  readonly engaged: boolean;
}

/** Controller state; every handler snapshots `generation` before its first await. */
interface IntegrationState {
  readonly options: CodexBackgroundIntegrationOptions;
  generation: number;
  activeSessionId: string | undefined;
  active: CodexBackgroundBinding | undefined;
  replayEpoch: string | undefined;
  settingsSnapshot: CodexBackgroundSettings | undefined;
  incompatibleCheckpoint: boolean;
  /** Settings diagnostics survive generation restarts so each session is told once. */
  diagnosedSessionId: string | undefined;
  /** Incompatibility warnings already shown to one session; a newly bound session starts empty. */
  incompatibilityNotices: { readonly sessionId: string; readonly reasons: Set<string> } | undefined;
}

function unbindSession(state: IntegrationState, sessionId: string): void {
  for (const cleanup of state.active?.cleanup ?? []) cleanup();
  bindings.delete(codexBackgroundOwnerKey(sessionId));
  state.active = undefined;
}

function stopIntegration(state: IntegrationState): void {
  state.generation += 1;
  const { activeSessionId, active } = state;
  if (
    activeSessionId !== undefined &&
    bindings.get(codexBackgroundOwnerKey(activeSessionId)) === active
  )
    bindings.delete(codexBackgroundOwnerKey(activeSessionId));
  for (const cleanup of active?.cleanup ?? []) cleanup();
  state.active = undefined;
  state.activeSessionId = undefined;
  state.replayEpoch = undefined;
  state.settingsSnapshot = undefined;
  state.incompatibleCheckpoint = false;
}

function beginSession(state: IntegrationState, ctx: CodexBackgroundContext): number {
  stopIntegration(state);
  state.activeSessionId = ctx.sessionManager.getSessionId();
  return state.generation;
}

function reportSettingsDiagnostic(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  settings: CodexBackgroundSettings,
): void {
  if (!settings.diagnostic || state.diagnosedSessionId === sessionId) return;
  state.diagnosedSessionId = sessionId;
  ctx.ui.notify(settings.diagnostic, "warning");
}

/** Warn once per session and reason; refreshes run before every provider request. */
function notifyIncompatibleOnce(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  reason: string,
): void {
  if (state.incompatibilityNotices?.sessionId !== sessionId)
    state.incompatibilityNotices = { sessionId, reasons: new Set() };
  if (state.incompatibilityNotices.reasons.has(reason)) return;
  state.incompatibilityNotices.reasons.add(reason);
  ctx.ui.notify(
    `Codex background checkpoint incompatible: ${reason}; using the host's existing path`,
    "warning",
  );
}

/** Unbind, and fail closed to the host path when a committed background checkpoint exists. */
function markIncompatible(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  incompatibility: {
    readonly sessionId: string;
    readonly hasBackgroundCheckpoint: boolean;
    readonly reason: string;
  },
): undefined {
  const { sessionId, hasBackgroundCheckpoint, reason } = incompatibility;
  unbindSession(state, sessionId);
  state.replayEpoch = undefined;
  if (!hasBackgroundCheckpoint) return undefined;
  state.incompatibleCheckpoint = true;
  state.options.state.pendingPiCompactionNativeWindow = undefined;
  notifyIncompatibleOnce(state, ctx, sessionId, reason);
  return undefined;
}

type LatestNativeCompaction = ReturnType<typeof resolveLatestNativeCompactionEntry>;
interface CommittedBackgroundCheckpoint {
  readonly entryId: string;
  readonly index: number;
  readonly details: BackgroundNativeCompactionDetails;
}
function committedBackgroundCheckpoint(
  latest: LatestNativeCompaction,
): CommittedBackgroundCheckpoint | undefined {
  if (!latest.ok || !isBackgroundNativeCompactionDetails(latest.entry.details)) return undefined;
  return { entryId: latest.entry.id, index: latest.index, details: latest.entry.details };
}
function hasBackgroundCheckpointMarker(latest: LatestNativeCompaction): boolean {
  const details = latest.ok ? latest.entry.details : latest.latestCompaction?.details;
  return Value.Check(BackgroundCheckpointMarkerSchema, details);
}

type ModelAuth = Awaited<
  ReturnType<CodexBackgroundContext["modelRegistry"]["getApiKeyAndHeaders"]>
>;
type AccountIdentity =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly accountId: string;
      readonly baseUrl: string | undefined;
      readonly headers: Extract<ModelAuth, { ok: true }>["headers"];
    }
  | { readonly ok: false; readonly reason: string };
function resolveAccountIdentity(auth: ModelAuth): AccountIdentity {
  if (!auth?.ok) return { ok: false, reason: "account credentials unavailable" };
  const apiKey = codexBackgroundAuthToken(auth.apiKey, auth.headers);
  if (apiKey === undefined) return { ok: false, reason: "account credentials unavailable" };
  let accountId: string;
  try {
    accountId = extractAccountId(apiKey);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Failed to extract accountId from token")
      return { ok: false, reason: "account identity unavailable" };
    throw cause;
  }
  if (!Value.Check(Type.String({ minLength: 1 }), accountId))
    return { ok: false, reason: "account identity unavailable" };
  return { ok: true, apiKey, accountId, baseUrl: auth.baseUrl, headers: auth.headers };
}

function sameBindingScope(binding: CodexBackgroundBinding, scope: ProviderScope): boolean {
  return (
    binding.scope.provider === scope.provider &&
    binding.scope.model === scope.model &&
    binding.scope.baseUrl === scope.baseUrl &&
    binding.scope.accountScope === scope.accountScope
  );
}

interface BindingRequest {
  readonly sessionId: string;
  readonly ctx: CodexBackgroundContext;
  readonly model: Model<Api>;
  readonly scope: ProviderScope;
  readonly accountId: string;
  readonly runtime: NativeCompactionRuntime;
  readonly blockImages: boolean;
  readonly isRefreshCurrent: () => boolean;
}
function createBinding(state: IntegrationState, request: BindingRequest): CodexBackgroundBinding {
  const { options } = state;
  const binding: CodexBackgroundBinding = {
    sessionId: request.sessionId,
    ctx: request.ctx,
    model: request.model,
    scope: request.scope,
    accountId: request.accountId,
    runtime: request.runtime,
    state: options.state,
    cleanup: new Set(),
    blockImages: request.blockImages,
    isCurrent: () => request.isRefreshCurrent() && state.active === binding,
    onInstalled: (id, epoch) => {
      state.replayEpoch = epoch;
      options.onInstalled(id, epoch);
    },
  };
  return binding;
}
function replaceBinding(state: IntegrationState, request: BindingRequest): CodexBackgroundBinding {
  for (const cleanup of state.active?.cleanup ?? []) cleanup();
  const binding = createBinding(state, request);
  state.active = binding;
  bindings.set(codexBackgroundOwnerKey(request.sessionId), binding);
  return binding;
}
/** Preserve the binding object while its scope is unchanged: factory consumers close over it. */
function bindScope(state: IntegrationState, request: BindingRequest): void {
  const reusable =
    state.active !== undefined && sameBindingScope(state.active, request.scope)
      ? state.active
      : undefined;
  const active = reusable ?? replaceBinding(state, request);
  active.runtime = request.runtime;
}

/** The replay incompatibility message, or undefined when the committed replay is usable. */
function replayIncompatibility(
  ctx: CodexBackgroundContext,
  checkpoint: CommittedBackgroundCheckpoint,
  request: BindingRequest,
): string | undefined {
  try {
    const tail = serializeActiveSessionToResponsesInput({
      model: request.model,
      entries: ctx.sessionManager.getBranch().slice(checkpoint.index + 1),
      options: { blockImages: request.blockImages },
    });
    buildCodexBackgroundReplay(checkpoint.details, request.scope, tail);
    return undefined;
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith("Committed Codex native checkpoint is incompatible")
    )
      return cause.message;
    throw cause;
  }
}
/** Install the committed checkpoint once per epoch; returns an incompatibility reason. */
function restoreCommittedReplay(
  state: IntegrationState,
  checkpoint: CommittedBackgroundCheckpoint | undefined,
  request: BindingRequest,
): string | undefined {
  if (checkpoint === undefined) return undefined;
  const incompatibility = replayIncompatibility(request.ctx, checkpoint, request);
  if (incompatibility !== undefined) return incompatibility;
  if (state.replayEpoch === checkpoint.entryId) return undefined;
  const { details } = checkpoint;
  installCodexBackgroundCheckpoint({
    details,
    sessionId: request.sessionId,
    committedEntryId: checkpoint.entryId,
    candidateId: details.candidateId,
    fingerprint: details.prefixFingerprint,
    ownerKey: details.background.ownerKey,
    ownerGeneration: details.background.ownerGeneration,
    currentScope: request.scope,
    state: state.options.state,
  });
  state.replayEpoch = checkpoint.entryId;
  state.options.onInstalled(request.sessionId, checkpoint.entryId);
  return undefined;
}

/** The provider scope a binding serves and the runtime its preparation lane uses. */
interface ScopedRuntime {
  readonly scope: ProviderScope;
  readonly runtime: NativeCompactionRuntime;
}
function scopeAndRuntime(
  model: Model<Api>,
  identity: Extract<AccountIdentity, { ok: true }>,
): ScopedRuntime {
  const baseUrl = identity.baseUrl ?? model.baseUrl;
  const scope: ProviderScope = {
    provider: model.provider,
    model: model.id,
    baseUrl,
    authMode: "oauth",
    accountScope: codexBackgroundAccountScope(identity.accountId),
  };
  const runtime: NativeCompactionRuntime = {
    provider: model.provider,
    api: "openai-codex-responses",
    apiFamily: "openai-codex-responses",
    codexTransport: true,
    model: model.id,
    baseUrl,
    apiKey: identity.apiKey,
    headers: identity.headers,
    currentModel: model,
  };
  return { scope, runtime };
}

async function refreshIntegration(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  expectedGeneration: number,
): Promise<ProviderScope | undefined> {
  const sessionId = ctx.sessionManager.getSessionId();
  const model = ctx.model;
  const registry = ctx.modelRegistry;
  const cwd = ctx.cwd;
  const trusted = ctx.isProjectTrusted();
  const current = (): boolean =>
    state.generation === expectedGeneration && state.activeSessionId === sessionId;
  if (!current()) return undefined;
  const settings =
    state.settingsSnapshot ??
    (await (state.options.resolveSettings ?? resolveCodexBackgroundSettings)(cwd, trusted));
  if (!current()) return undefined;
  state.settingsSnapshot = settings;
  reportSettingsDiagnostic(state, ctx, sessionId, settings);
  if (!settings.enabled) {
    unbindSession(state, sessionId);
    return undefined;
  }
  const latest = resolveLatestNativeCompactionEntry(ctx.sessionManager.getBranch());
  const checkpoint = committedBackgroundCheckpoint(latest);
  const hasBackgroundCheckpoint = hasBackgroundCheckpointMarker(latest);
  const incompatible = (reason: string): undefined =>
    markIncompatible(state, ctx, { sessionId, hasBackgroundCheckpoint, reason });
  if (hasBackgroundCheckpoint && checkpoint === undefined)
    return incompatible("invalid checkpoint metadata");
  if (model === undefined || model.api !== "openai-codex-responses")
    return incompatible("provider/model changed");
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!current()) return undefined;
  const identity = resolveAccountIdentity(auth);
  if (!identity.ok) return incompatible(identity.reason);
  const { scope, runtime } = scopeAndRuntime(model, identity);
  const bindingRequest: BindingRequest = {
    sessionId,
    ctx,
    model,
    scope,
    accountId: identity.accountId,
    runtime,
    blockImages: settings.blockImages,
    isRefreshCurrent: current,
  };
  bindScope(state, bindingRequest);
  registerCodexBackgroundFactory(true);
  const replayFailure = restoreCommittedReplay(state, checkpoint, bindingRequest);
  if (replayFailure !== undefined) return incompatible(replayFailure);
  state.incompatibleCheckpoint = false;
  if (state.incompatibilityNotices?.sessionId === sessionId)
    state.incompatibilityNotices = undefined;
  return scope;
}

/** Contain only stale-context failures; everything else reaches the caller. */
async function refreshContainingStaleContext(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  expectedGeneration: number,
): Promise<ProviderScope | undefined> {
  try {
    return await refreshIntegration(state, ctx, expectedGeneration);
  } catch (cause) {
    return withLiveCtx(() => {
      throw cause;
    });
  }
}

/** No new event hooks: the existing Codex lifecycle calls this controller. */
export function createCodexBackgroundIntegration(options: CodexBackgroundIntegrationOptions) {
  const state: IntegrationState = {
    options,
    generation: 0,
    activeSessionId: undefined,
    active: undefined,
    replayEpoch: undefined,
    settingsSnapshot: undefined,
    incompatibleCheckpoint: false,
    diagnosedSessionId: undefined,
    incompatibilityNotices: undefined,
  };
  return {
    begin: (ctx: CodexBackgroundContext): number => beginSession(state, ctx),
    fence: (): CodexBackgroundFence => ({
      generation: state.generation,
      engaged: state.active !== undefined || state.incompatibleCheckpoint,
    }),
    isStale: (snapshot: CodexBackgroundFence): boolean =>
      snapshot.engaged && state.generation !== snapshot.generation,
    isGenerationCurrent: (expected: number): boolean => state.generation === expected,
    requestState: (adapterState: AdapterState, sessionId: string) =>
      codexBackgroundRequestState(
        adapterState,
        state.activeSessionId === sessionId && state.incompatibleCheckpoint,
      ),
    invalidateReplay: () => {
      state.replayEpoch = undefined;
    },
    refresh: (ctx: CodexBackgroundContext, expectedGeneration?: number) =>
      refreshContainingStaleContext(state, ctx, expectedGeneration ?? state.generation),
    stop: () => stopIntegration(state),
  };
}
