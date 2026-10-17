import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ownerKeyFor } from "../../../choco-pi-compaction/src/ownership.ts";
import { registerSessionNativeRefresher } from "../../../choco-pi-compaction/src/background-host/native-refresh.ts";
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
  registerBackendFactory,
  registryAvailability,
} from "../../../choco-pi-compaction/src/background/registry.ts";
import {
  buildCodexBackgroundReplay,
  resolveCodexBackgroundCapture,
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

/**
 * Owner key a session's binding is published under: the main session's
 * `main-session:<id>`, or a subagent child's `subagent-child:<id>`, so the
 * child coordinator the runner bridge registers finds its child's binding.
 */
export const codexBackgroundOwnerKey = ownerKeyFor;

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

/** One published binding and the generation of the refresh that published it. */
interface PublishedBinding {
  readonly binding: CodexBackgroundBinding;
  readonly generation: number;
}
interface BindingTable {
  readonly bindings: Map<string, PublishedBinding>;
  /** Process-wide generation counter: later session starts always compare greater. */
  readonly counter: { value: number };
}

/**
 * Bindings by owner key, process-global like the backend registry: the
 * factory is registered once (first wins) and must see bindings published by
 * every Codex registration, including a child session's, whichever module
 * instance loaded it.
 */
const BINDING_TABLE_SYMBOL = Symbol.for("choco-pi:codex-background-bindings");
const CounterSchema = Type.Object({ value: Type.Integer({ minimum: 0 }) });
function isBindingTable<T>(value: T): value is T & BindingTable {
  return (
    Value.Check(Type.Object({ bindings: Type.Unknown(), counter: CounterSchema }), value) &&
    value.bindings instanceof Map
  );
}
function bindingTable(): BindingTable {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, BINDING_TABLE_SYMBOL);
  const found: unknown = descriptor?.value;
  if (isBindingTable(found)) return found;
  if (descriptor !== undefined) throw new Error("Invalid Codex background binding table");
  const table: BindingTable = { bindings: new Map(), counter: { value: 0 } };
  Object.defineProperty(globalThis, BINDING_TABLE_SYMBOL, { value: table, configurable: true });
  return table;
}
function nextGeneration(): number {
  const counter = bindingTable().counter;
  counter.value += 1;
  return counter.value;
}
/** The current binding published under an owner key, if any. */
export function publishedCodexBinding(ownerKey: string): CodexBackgroundBinding | undefined {
  return bindingTable().bindings.get(ownerKey)?.binding;
}
/**
 * Publish unless a newer, still-current binding holds the key: a stale
 * refresh (older generation) never replaces a newer session start's binding.
 */
function publishBinding(ownerKey: string, published: PublishedBinding): boolean {
  const bindings = bindingTable().bindings;
  const existing = bindings.get(ownerKey);
  if (
    existing !== undefined &&
    existing.binding !== published.binding &&
    existing.generation > published.generation &&
    existing.binding.isCurrent()
  )
    return false;
  bindings.set(ownerKey, published);
  return true;
}
/** Remove only this exact binding; a newer binding under the same key stays. */
function withdrawBinding(ownerKey: string, binding: CodexBackgroundBinding | undefined): void {
  if (binding === undefined) return;
  const bindings = bindingTable().bindings;
  if (bindings.get(ownerKey)?.binding === binding) bindings.delete(ownerKey);
}

/**
 * Register once per ID, yielding to any host-owned factory already registered.
 * A conflicting registry slot registers nothing; the host then keeps the
 * background feature off for this process.
 */
export function registerCodexBackgroundFactory(enabled: boolean): boolean {
  if (!enabled) return false;
  const availability = registryAvailability();
  if (
    availability.status !== "available" ||
    availability.registry.backendFactories.has(CODEX_BACKGROUND_BACKEND_ID)
  )
    return false;
  registerBackendFactory(CODEX_BACKGROUND_BACKEND_ID, (context) => {
    let selected: CodexBackgroundBinding | undefined;
    let backend: Backend | undefined;
    const resolve = (): Backend | undefined => {
      // Looked up on every call: a binding published after this backend was created is used.
      const binding = publishedCodexBinding(context.ownerKey);
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
/** The frozen cut with its Codex capture, or the refusal to record on the failure. */
function captureFrozenCut(
  context: BackendFactoryContext,
  binding: CodexBackgroundBinding,
  snapshot: FrozenSnapshot,
): { readonly snapshot: FrozenSnapshot } | { readonly refusal: string } {
  if (
    !binding.isCurrent() ||
    snapshot.ownerKey !== context.ownerKey ||
    snapshot.ownerGeneration !== context.ownerGeneration
  )
    return { refusal: "owner-changed" };
  const input = serializeActiveSessionToResponsesInput({
    model: binding.model,
    entries: [...snapshot.entries],
    options: { blockImages: binding.blockImages },
  });
  const request = resolveCodexBackgroundCapture({
    sessionId: binding.sessionId,
    providerScope: snapshot.providerScope,
    accountId: binding.accountId,
    reconstructedInput: input,
  });
  if (!request.ok) return { refusal: request.refusal };
  return {
    snapshot: Object.freeze({
      ...snapshot,
      backendCapture: freezeDetachedCapture(request.capture),
    }),
  };
}

/** Captures once per frozen cut; prepare never replaces it with newer foreground history. */
export function createCapturedCodexBackend(
  context: BackendFactoryContext,
  binding: CodexBackgroundBinding,
): Backend {
  const captures = new WeakMap<FrozenSnapshot, ReturnType<typeof captureFrozenCut>>();
  const slot: AdoptionConsumerSlot = {
    coordinator: undefined,
    removeConsumer: undefined,
    adopted: new Set(),
  };
  binding.cleanup.add(() => detachAdoptionConsumer(slot));
  const native = createNativeBackend(context, binding, slot);
  const capture = (snapshot: FrozenSnapshot): ReturnType<typeof captureFrozenCut> => {
    const known = captures.get(snapshot);
    if (known !== undefined) return known;
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
      return "refusal" in augmented
        ? { legal: false, reason: "no-legal-cut", detail: augmented.refusal }
        : native.isLegalCut(augmented.snapshot);
    },
    prepare: (snapshot, request) => {
      const augmented = capture(snapshot);
      return "refusal" in augmented
        ? Promise.resolve({
            ok: false,
            reason: "no-legal-cut",
            retryable: false,
            detail: augmented.refusal,
          })
        : native.prepare(augmented.snapshot, request);
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
  readonly sessionId: string;
  readonly generation: number;
  /** False while background compaction is disabled or unbound: legacy paths are never fenced. */
  readonly engaged: boolean;
}

/**
 * One session's binding state. `begin` replaces the slot (a new generation);
 * every refresh compares its expected generation and slot identity after each
 * await, so a superseded refresh never writes into the replacement.
 */
interface SessionSlot {
  readonly sessionId: string;
  /** Owner key the session's binding is published under, fixed at begin. */
  readonly ownerKey: string;
  /** Process-unique: later begins (any registration) compare greater. */
  readonly generation: number;
  binding: CodexBackgroundBinding | undefined;
  replayEpoch: string | undefined;
  settingsSnapshot: CodexBackgroundSettings | undefined;
  incompatibleCheckpoint: boolean;
  unregisterRefresher: (() => void) | undefined;
}

/** Controller state: one slot per session this registration serves. */
interface IntegrationState {
  readonly options: CodexBackgroundIntegrationOptions;
  readonly sessions: Map<string, SessionSlot>;
  /** Settings diagnostics survive generation restarts so each session is told once. */
  readonly diagnosed: Set<string>;
  /** Incompatibility warnings already shown, per session. */
  readonly incompatibilityNotices: Map<string, Set<string>>;
}

function isSlotCurrent(state: IntegrationState, slot: SessionSlot): boolean {
  return state.sessions.get(slot.sessionId) === slot;
}

function unbindSession(slot: SessionSlot): void {
  const binding = slot.binding;
  slot.binding = undefined;
  for (const cleanup of binding?.cleanup ?? []) cleanup();
  withdrawBinding(slot.ownerKey, binding);
}

/** Retire one slot: its binding, published entry and refresher; other sessions are untouched. */
function retireSlot(state: IntegrationState, slot: SessionSlot): void {
  if (isSlotCurrent(state, slot)) state.sessions.delete(slot.sessionId);
  unbindSession(slot);
  slot.unregisterRefresher?.();
  slot.unregisterRefresher = undefined;
  slot.replayEpoch = undefined;
  slot.settingsSnapshot = undefined;
  slot.incompatibleCheckpoint = false;
}

/** Session shutdown: retire only that session. Without an ID, every session (tests, teardown). */
function stopIntegration(state: IntegrationState, sessionId?: string): void {
  const slots =
    sessionId === undefined ? [...state.sessions.values()] : [state.sessions.get(sessionId)];
  for (const slot of slots) {
    if (slot === undefined) continue;
    retireSlot(state, slot);
    state.diagnosed.delete(slot.sessionId);
    state.incompatibilityNotices.delete(slot.sessionId);
  }
}

function beginSession(state: IntegrationState, ctx: CodexBackgroundContext): number {
  const sessionId = ctx.sessionManager.getSessionId();
  const previous = state.sessions.get(sessionId);
  if (previous !== undefined) retireSlot(state, previous);
  const slot: SessionSlot = {
    sessionId,
    ownerKey: codexBackgroundOwnerKey(sessionId),
    generation: nextGeneration(),
    binding: undefined,
    replayEpoch: undefined,
    settingsSnapshot: undefined,
    incompatibleCheckpoint: false,
    unregisterRefresher: undefined,
  };
  state.sessions.set(sessionId, slot);
  // A reattached child (or any caller knowing only the session) re-runs the committed restore.
  slot.unregisterRefresher = registerSessionNativeRefresher(
    sessionId,
    "codex-native",
    (refreshCtx) => refreshSlotForReattach(state, slot, refreshCtx),
  );
  return slot.generation;
}

/** Re-install the committed checkpoint for this slot's generation; nothing once superseded. */
async function refreshSlotForReattach(
  state: IntegrationState,
  slot: SessionSlot,
  ctx: CodexBackgroundContext,
): Promise<void> {
  if (!isSlotCurrent(state, slot)) return;
  slot.replayEpoch = undefined;
  await refreshContainingStaleContext(state, ctx, slot.generation);
}

function reportSettingsDiagnostic(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  settings: CodexBackgroundSettings,
): void {
  if (!settings.diagnostic || state.diagnosed.has(sessionId)) return;
  state.diagnosed.add(sessionId);
  ctx.ui.notify(settings.diagnostic, "warning");
}

/** Warn once per session and reason; refreshes run before every provider request. */
function notifyIncompatibleOnce(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  reason: string,
): void {
  let reasons = state.incompatibilityNotices.get(sessionId);
  if (reasons === undefined) {
    reasons = new Set();
    state.incompatibilityNotices.set(sessionId, reasons);
  }
  if (reasons.has(reason)) return;
  reasons.add(reason);
  ctx.ui.notify(
    `Codex background checkpoint incompatible: ${reason}; using the host's existing path`,
    "warning",
  );
}

/** Unbind, and fail closed to the host path when a committed background checkpoint exists. */
function markIncompatible(
  state: IntegrationState,
  slot: SessionSlot,
  ctx: CodexBackgroundContext,
  incompatibility: {
    readonly hasBackgroundCheckpoint: boolean;
    readonly reason: string;
  },
): undefined {
  const { hasBackgroundCheckpoint, reason } = incompatibility;
  unbindSession(slot);
  slot.replayEpoch = undefined;
  if (!hasBackgroundCheckpoint) return undefined;
  slot.incompatibleCheckpoint = true;
  state.options.state.pendingPiCompactionNativeWindow = undefined;
  notifyIncompatibleOnce(state, ctx, slot.sessionId, reason);
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
function createBinding(
  state: IntegrationState,
  slot: SessionSlot,
  request: BindingRequest,
): CodexBackgroundBinding {
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
    isCurrent: () => request.isRefreshCurrent() && slot.binding === binding,
    onInstalled: (id, epoch) => {
      if (slot.binding === binding) slot.replayEpoch = epoch;
      options.onInstalled(id, epoch);
    },
  };
  return binding;
}
function replaceBinding(
  state: IntegrationState,
  slot: SessionSlot,
  request: BindingRequest,
): CodexBackgroundBinding {
  unbindSession(slot);
  const binding = createBinding(state, slot, request);
  slot.binding = binding;
  return binding;
}
/** Preserve the binding object while its scope is unchanged: factory consumers close over it. */
function bindScope(state: IntegrationState, slot: SessionSlot, request: BindingRequest): void {
  const reusable =
    slot.binding !== undefined && sameBindingScope(slot.binding, request.scope)
      ? slot.binding
      : undefined;
  const active = reusable ?? replaceBinding(state, slot, request);
  active.runtime = request.runtime;
  // Idempotent for the same binding; refused while a newer session start's binding is current.
  publishBinding(slot.ownerKey, { binding: active, generation: slot.generation });
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
  slot: SessionSlot,
  checkpoint: CommittedBackgroundCheckpoint | undefined,
  request: BindingRequest,
): string | undefined {
  if (checkpoint === undefined) return undefined;
  const incompatibility = replayIncompatibility(request.ctx, checkpoint, request);
  if (incompatibility !== undefined) return incompatibility;
  if (slot.replayEpoch === checkpoint.entryId) return undefined;
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
  slot.replayEpoch = checkpoint.entryId;
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
  const slot = state.sessions.get(sessionId);
  if (slot === undefined || slot.generation !== expectedGeneration) return undefined;
  const current = (): boolean => isSlotCurrent(state, slot);
  const settings =
    slot.settingsSnapshot ??
    (await (state.options.resolveSettings ?? resolveCodexBackgroundSettings)(cwd, trusted));
  if (!current()) return undefined;
  slot.settingsSnapshot = settings;
  reportSettingsDiagnostic(state, ctx, sessionId, settings);
  if (!settings.enabled) {
    unbindSession(slot);
    return undefined;
  }
  const latest = resolveLatestNativeCompactionEntry(ctx.sessionManager.getBranch());
  const checkpoint = committedBackgroundCheckpoint(latest);
  const hasBackgroundCheckpoint = hasBackgroundCheckpointMarker(latest);
  const incompatible = (reason: string): undefined =>
    markIncompatible(state, slot, ctx, { hasBackgroundCheckpoint, reason });
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
  bindScope(state, slot, bindingRequest);
  registerCodexBackgroundFactory(true);
  const replayFailure = restoreCommittedReplay(state, slot, checkpoint, bindingRequest);
  if (replayFailure !== undefined) return incompatible(replayFailure);
  slot.incompatibleCheckpoint = false;
  state.incompatibilityNotices.delete(sessionId);
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
    sessions: new Map(),
    diagnosed: new Set(),
    incompatibilityNotices: new Map(),
  };
  const slotGeneration = (sessionId: string): number | undefined =>
    state.sessions.get(sessionId)?.generation;
  return {
    begin: (ctx: CodexBackgroundContext): number => beginSession(state, ctx),
    fence: (sessionId: string): CodexBackgroundFence => {
      const slot = state.sessions.get(sessionId);
      return {
        sessionId,
        generation: slot?.generation ?? 0,
        engaged: slot !== undefined && (slot.binding !== undefined || slot.incompatibleCheckpoint),
      };
    },
    isStale: (snapshot: CodexBackgroundFence): boolean =>
      snapshot.engaged && slotGeneration(snapshot.sessionId) !== snapshot.generation,
    /** Generations are process-unique, so a generation identifies its session's slot. */
    isGenerationCurrent: (expected: number): boolean =>
      [...state.sessions.values()].some((slot) => slot.generation === expected),
    requestState: (adapterState: AdapterState, sessionId: string) =>
      codexBackgroundRequestState(
        adapterState,
        state.sessions.get(sessionId)?.incompatibleCheckpoint === true,
      ),
    invalidateReplay: (sessionId: string) => {
      const slot = state.sessions.get(sessionId);
      if (slot !== undefined) slot.replayEpoch = undefined;
    },
    refresh: (ctx: CodexBackgroundContext, expectedGeneration?: number) =>
      refreshContainingStaleContext(
        state,
        ctx,
        expectedGeneration ?? slotGeneration(ctx.sessionManager.getSessionId()) ?? 0,
      ),
    /** Retire one session (session_shutdown); without an ID, every session. */
    stop: (sessionId?: string) => stopIntegration(state, sessionId),
  };
}
