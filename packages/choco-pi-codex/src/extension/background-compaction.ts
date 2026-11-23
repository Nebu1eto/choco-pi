import {
  isBoolean,
  isNonEmptyString,
  isNonNegativeInteger,
} from "@choco-pi/code-mode/value-guards";
import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import { jsonEqual } from "../../../choco-pi-compaction/src/background/json-equal.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { ownerKeyFor } from "../../../choco-pi-compaction/src/ownership.ts";
import { registerSessionNativeRefresher } from "../../../choco-pi-compaction/src/background-host/native-refresh.ts";
import { loadEffectiveBackgroundSettings } from "../../../choco-pi-compaction/src/background/settings.ts";
import { readAnthropicCompactionMode } from "../../../choco-pi-compaction/src/anthropic/mode.ts";
import {
  appendLaneRecord,
  type LaneAppend,
  type LaneRecordInput,
  type LaneRoute,
  type LaneTransitionKey,
  LaneTransitionMemo,
} from "../../../choco-pi-compaction/src/background/lane-journal.ts";
import {
  lossAuthorizedFor,
  OPAQUE_GUARD_NOTICE,
  opaqueCheckpointOf,
  opaqueLaneOf,
} from "../../../choco-pi-compaction/src/opaque-checkpoint.ts";
import {
  clearOpaqueBlockOf,
  setOpaqueBlock,
} from "../../../choco-pi-compaction/src/opaque-block.ts";
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
  codexLaneRoute,
  isBackgroundNativeCompactionDetails,
  resolveLatestNativeCompactionEntry,
} from "../adapter/compaction/details-store.ts";
import { serializeActiveSessionToResponsesInput } from "../adapter/compaction/serializer.ts";
import type { BackgroundNativeCompactionDetails } from "../adapter/compaction/types.ts";
import type { NativeCompactionRuntime } from "../adapter/compaction/compaction-runtime.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import { extractAccountId } from "../providers/openai-codex/headers.ts";
import { withLiveCtx } from "./live-context.ts";

export const codexBackgroundOwnerKey = ownerKeyFor;

function isAdoptionSignal<T>(source: T): source is T & {
  readonly willAdopt: (sessionId: string, event: SessionBeforeCompactEvent) => Promise<boolean>;
} {
  return isJsonObject(source) && source["version"] === 1 && source["willAdopt"] instanceof Function;
}
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
  if (!isBoolean(answer)) throw new Error("Invalid background adoption decision");
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

function readBlockImagesSetting<T>(settings: T): boolean | undefined | "invalid" {
  if (!isJsonObject(settings)) return "invalid";
  const images = settings["images"];
  if (images === undefined) return undefined;
  if (!isJsonObject(images)) return "invalid";
  const blockImages = images["blockImages"];
  if (blockImages === undefined) return undefined;
  return isBoolean(blockImages) ? blockImages : "invalid";
}

export interface CodexBackgroundSettingsInput {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly openaiServerSide: boolean;
  readonly agentDir?: string | undefined;
}

export async function resolveCodexBackgroundSettings(
  input: CodexBackgroundSettingsInput,
): Promise<CodexBackgroundSettings> {
  const { cwd, trusted, openaiServerSide } = input;
  const agentDir = input.agentDir ?? getAgentDir();
  const loaded = await loadEffectiveBackgroundSettings(
    { cwd, agentDir, projectTrusted: trusted },
    {
      openaiServerSide,
      anthropicServerSide: (await readAnthropicCompactionMode(agentDir)) === "server-side",
    },
  );
  if (!loaded.settings.enabled || !loaded.settings.codexNative) {
    return { enabled: false, blockImages: false };
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
    const setting = readBlockImagesSetting(settings);
    if (setting === "invalid")
      return {
        enabled: false,
        blockImages: false,
        diagnostic: "Invalid image settings; Codex background compaction disabled",
      };
    if (setting !== undefined) blockImages = setting;
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
  readonly userMessageRetentionTokens?: (() => number) | undefined;
}

const requestRefusals = new Map<string, string>();

export function recordCodexRequestDecision(sessionId: string, refusal: string | undefined): void {
  if (refusal === undefined) requestRefusals.delete(sessionId);
  else requestRefusals.set(sessionId, refusal);
}

function payloadSessionId(payload: {
  readonly client_metadata?: Readonly<Record<string, string>> | undefined;
}): string | undefined {
  return payload.client_metadata?.["session_id"];
}

export function assertCodexRequestAllowed(payload: {
  readonly client_metadata?: Readonly<Record<string, string>> | undefined;
}): void {
  const sessionId = payloadSessionId(payload);
  if (sessionId === undefined) return;
  const refusal = requestRefusals.get(sessionId);
  if (refusal === undefined) return;
  requestRefusals.delete(sessionId);
  throw new Error(refusal);
}

interface PublishedBinding {
  readonly binding: CodexBackgroundBinding;
  readonly generation: number;
}
interface BindingTable {
  readonly bindings: Map<string, PublishedBinding>;
  readonly counter: { value: number };
}

const BINDING_TABLE_SYMBOL = Symbol.for("choco-pi:codex-background-bindings");
function isBindingTable<T>(value: T): value is T & BindingTable {
  if (!isJsonObject(value)) return false;
  const counter = value["counter"];
  return (
    isJsonObject(counter) &&
    isNonNegativeInteger(counter["value"]) &&
    value["bindings"] instanceof Map
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
export function publishedCodexBinding(ownerKey: string): CodexBackgroundBinding | undefined {
  return bindingTable().bindings.get(ownerKey)?.binding;
}
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
function withdrawBinding(ownerKey: string, binding: CodexBackgroundBinding | undefined): void {
  if (binding === undefined) return;
  const bindings = bindingTable().bindings;
  if (bindings.get(ownerKey)?.binding === binding) bindings.delete(ownerKey);
}

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
  if (Array.isArray(source) || isJsonObject(source)) {
    const children: unknown[] = Object.values(source);
    for (const child of children) freezeDetachedCapture(child);
    Object.freeze(source);
  }
  return source;
}

interface AdoptionConsumerSlot {
  coordinator: CoordinatorApi | undefined;
  removeConsumer: (() => void) | undefined;
  readonly adopted: Set<string>;
}
function detachAdoptionConsumer(slot: AdoptionConsumerSlot): void {
  slot.removeConsumer?.();
  slot.adopted.clear();
}
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
    userMessageRetentionTokens: binding.userMessageRetentionTokens,
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

export function consumeCodexBackgroundAdoption(
  binding: CodexBackgroundBinding,
  context: BackendFactoryContext,
  adoption: Adoption,
  adopted: Set<string>,
): void {
  if (adopted.has(adoption.adoptionId) || !binding.isCurrent()) return;
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

interface CodexBackgroundIntegrationOptions {
  readonly resolveSettings?: (cwd: string, trusted: boolean) => Promise<CodexBackgroundSettings>;
  readonly state: Pick<AdapterState, "pendingPiCompactionNativeWindow">;
  readonly onInstalled: (sessionId: string, epoch: string) => void;
  readonly openaiServerSide?: (() => boolean) | undefined;
  readonly userMessageRetentionTokens?: (() => number) | undefined;
  readonly append?: LaneAppend | undefined;
}

interface CodexBackgroundFence {
  readonly sessionId: string;
  readonly generation: number;
  readonly engaged: boolean;
}

interface SessionSlot {
  readonly sessionId: string;
  readonly ownerKey: string;
  readonly generation: number;
  binding: CodexBackgroundBinding | undefined;
  replayEpoch: string | undefined;
  settingsSnapshot: CodexBackgroundSettings | undefined;
  incompatibleCheckpoint: boolean;
  foregroundReplayOnly: boolean;
  checkpointEntryId: string | undefined;
  unregisterRefresher: (() => void) | undefined;
}

interface IntegrationState {
  readonly options: CodexBackgroundIntegrationOptions;
  readonly sessions: Map<string, SessionSlot>;
  readonly diagnosed: Set<string>;
  readonly incompatibilityNotices: Map<string, Set<string>>;
  readonly transitions: LaneTransitionMemo;
}

type CodexLaneRecord = Pick<
  LaneRecordInput,
  "route" | "event" | "from" | "reason" | "noticeAttempted"
> &
  Partial<Pick<LaneRecordInput, "to" | "detail" | "checkpointEntryId">>;

function journalOnce(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  record: CodexLaneRecord,
): void {
  const append = state.options.append;
  if (append === undefined) return;
  const key: LaneTransitionKey =
    record.checkpointEntryId === undefined
      ? { route: record.route, event: record.event, reason: record.reason }
      : {
          route: record.route,
          event: record.event,
          reason: record.reason,
          checkpointEntryId: record.checkpointEntryId,
        };
  if (state.transitions.seen(sessionId, key)) return;
  appendLaneRecord(append, { at: Date.now(), sessionId, provider: "codex", ...record }, (message) =>
    ctx.ui.notify(message, "warning"),
  );
}

function notifyOnce(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  key: string,
  notice: { readonly text: string; readonly level: "warning" | "error" },
): boolean {
  let keys = state.incompatibilityNotices.get(sessionId);
  if (keys === undefined) {
    keys = new Set();
    state.incompatibilityNotices.set(sessionId, keys);
  }
  if (keys.has(key)) return false;
  keys.add(key);
  ctx.ui.notify(notice.text, notice.level);
  return true;
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

function retireSlot(state: IntegrationState, slot: SessionSlot): void {
  if (isSlotCurrent(state, slot)) state.sessions.delete(slot.sessionId);
  unbindSession(slot);
  slot.unregisterRefresher?.();
  slot.unregisterRefresher = undefined;
  slot.replayEpoch = undefined;
  slot.settingsSnapshot = undefined;
  slot.incompatibleCheckpoint = false;
  slot.foregroundReplayOnly = false;
  slot.checkpointEntryId = undefined;
}

function stopIntegration(state: IntegrationState, sessionId?: string): void {
  const slots =
    sessionId === undefined ? [...state.sessions.values()] : [state.sessions.get(sessionId)];
  for (const slot of slots) {
    if (slot === undefined) continue;
    retireSlot(state, slot);
    state.diagnosed.delete(slot.sessionId);
    state.incompatibilityNotices.delete(slot.sessionId);
    state.transitions.reset(slot.sessionId);
    recordCodexRequestDecision(slot.sessionId, undefined);
    clearCodexOpaqueBlock(slot.sessionId);
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
    foregroundReplayOnly: false,
    checkpointEntryId: undefined,
    unregisterRefresher: undefined,
  };
  state.sessions.set(sessionId, slot);
  slot.unregisterRefresher = registerSessionNativeRefresher(
    sessionId,
    "codex-native",
    (refreshCtx) => refreshSlotForReattach(state, slot, refreshCtx),
  );
  return slot.generation;
}

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

function notifyIncompatibleOnce(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  incompatibility: { readonly reason: string; readonly entryId: string },
): void {
  const { reason, entryId } = incompatibility;
  const tail = lossAuthorizedFor(sessionId, entryId)
    ? "its history is dropped (loss authorized)"
    : OPAQUE_GUARD_NOTICE("codex", entryId);
  notifyOnce(state, ctx, sessionId, reason, {
    text: `Codex background checkpoint incompatible: ${reason}; ${tail}`,
    level: "warning",
  });
}

function markIncompatible(
  state: IntegrationState,
  slot: SessionSlot,
  ctx: CodexBackgroundContext,
  incompatibility: {
    readonly hasBackgroundCheckpoint: boolean;
    readonly entryId: string | undefined;
    readonly reason: string;
  },
): undefined {
  const { hasBackgroundCheckpoint, entryId, reason } = incompatibility;
  unbindSession(slot);
  slot.replayEpoch = undefined;
  slot.foregroundReplayOnly = false;
  if (!hasBackgroundCheckpoint || entryId === undefined) return undefined;
  slot.incompatibleCheckpoint = true;
  slot.checkpointEntryId = entryId;
  state.options.state.pendingPiCompactionNativeWindow = undefined;
  notifyIncompatibleOnce(state, ctx, slot.sessionId, { reason, entryId });
  return undefined;
}

function yieldTransientIdentity(
  state: IntegrationState,
  slot: SessionSlot,
  ctx: CodexBackgroundContext,
  reason: string,
): undefined {
  unbindSession(slot);
  slot.replayEpoch = undefined;
  journalOnce(state, ctx, slot.sessionId, {
    route: "replay",
    event: "yield",
    from: "codex-native-v2",
    reason: "auth-transient",
    detail: reason,
    noticeAttempted: false,
  });
  return undefined;
}

function onlyModelChanged(recorded: ProviderScope, current: ProviderScope): boolean {
  return (
    recorded.model !== current.model && jsonEqual({ ...recorded, model: current.model }, current)
  );
}

function useForegroundReplay(
  state: IntegrationState,
  slot: SessionSlot,
  ctx: CodexBackgroundContext,
  change: { readonly entryId: string; readonly from: string; readonly to: string },
): undefined {
  unbindSession(slot);
  slot.replayEpoch = undefined;
  slot.incompatibleCheckpoint = false;
  slot.foregroundReplayOnly = true;
  slot.checkpointEntryId = change.entryId;
  const noticed = notifyOnce(state, ctx, slot.sessionId, `model:${change.entryId}`, {
    text: `Codex background checkpoint ${change.entryId} was made for model ${change.from}; replaying it for ${change.to} through the foreground path`,
    level: "warning",
  });
  journalOnce(state, ctx, slot.sessionId, {
    route: "replay",
    event: "fallback",
    from: "codex-native-v2",
    to: "codex-foreground",
    reason: "incompatible",
    detail: "model",
    checkpointEntryId: change.entryId,
    noticeAttempted: noticed,
  });
  return undefined;
}

function incompatibleRefusal(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  site: { readonly route: LaneRoute; readonly event: "refuse" | "cancel" },
): string | undefined {
  const slot = state.sessions.get(sessionId);
  const entryId = slot?.checkpointEntryId;
  if (slot === undefined || !slot.incompatibleCheckpoint || entryId === undefined) return undefined;
  if (lossAuthorizedFor(sessionId, entryId)) {
    const noticed = notifyOnce(state, ctx, sessionId, `loss:${entryId}`, {
      text: `Codex checkpoint ${entryId} cannot be replayed; its history is dropped (loss authorized).`,
      level: "warning",
    });
    journalOnce(state, ctx, sessionId, {
      route: "replay",
      event: "loss",
      from: "codex-native-v2",
      reason: "loss",
      checkpointEntryId: entryId,
      noticeAttempted: noticed,
    });
    return undefined;
  }
  journalOnce(state, ctx, sessionId, {
    route: site.route,
    event: site.event,
    from: "codex-native-v2",
    reason: "scope-mismatch",
    checkpointEntryId: entryId,
    noticeAttempted: true,
  });
  return OPAQUE_GUARD_NOTICE("codex", entryId);
}

type LatestNativeCompaction = ReturnType<typeof resolveLatestNativeCompactionEntry>;

export interface CodexOpaqueGuardInput {
  readonly served: boolean;
  readonly codexTransport: boolean;
  readonly site: "request" | "bind";
}

function clearCodexOpaqueBlock(sessionId: string): void {
  clearOpaqueBlockOf(sessionId, "codex-native");
}

function announceOpaqueLoss(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  entryId: string,
): void {
  const noticed = notifyOnce(state, ctx, sessionId, `loss:${entryId}`, {
    text: `Codex checkpoint ${entryId} cannot be replayed; its history is dropped (loss authorized).`,
    level: "warning",
  });
  journalOnce(state, ctx, sessionId, {
    route: "replay",
    event: "loss",
    from: opaqueLaneOf("codex-native"),
    reason: "loss",
    checkpointEntryId: entryId,
    noticeAttempted: noticed,
  });
}

function opaqueCheckpointRefusal(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  sessionId: string,
  input: CodexOpaqueGuardInput,
): string | undefined {
  const opaque = opaqueCheckpointOf(ctx.sessionManager.getBranch());
  if (opaque?.owner !== "codex-native" || input.served) {
    clearCodexOpaqueBlock(sessionId);
    return undefined;
  }
  const { entryId } = opaque;
  if (lossAuthorizedFor(sessionId, entryId)) {
    clearCodexOpaqueBlock(sessionId);
    if (input.site === "request") announceOpaqueLoss(state, ctx, sessionId, entryId);
    return undefined;
  }
  if (!input.codexTransport) {
    setOpaqueBlock(sessionId, { entryId, owner: "codex-native" });
    return undefined;
  }
  clearCodexOpaqueBlock(sessionId);
  if (input.site !== "request") return undefined;
  const text = OPAQUE_GUARD_NOTICE("codex", entryId);
  const noticed = notifyOnce(state, ctx, sessionId, `opaque:${entryId}`, { text, level: "error" });
  journalOnce(state, ctx, sessionId, {
    route: "replay",
    event: "refuse",
    from: opaqueLaneOf("codex-native"),
    reason: "opaque-checkpoint",
    checkpointEntryId: entryId,
    noticeAttempted: noticed,
  });
  return text;
}

function opaqueCompactionCancel(
  state: IntegrationState,
  ctx: CodexBackgroundContext,
  event: Pick<SessionBeforeCompactEvent, "reason">,
): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  const opaque = opaqueCheckpointOf(ctx.sessionManager.getBranch());
  if (opaque?.owner !== "codex-native" || lossAuthorizedFor(sessionId, opaque.entryId))
    return undefined;
  const text = OPAQUE_GUARD_NOTICE("codex", opaque.entryId);
  ctx.ui.notify(text, "error");
  const append = state.options.append;
  if (append !== undefined)
    appendLaneRecord(
      append,
      {
        at: Date.now(),
        sessionId,
        provider: "codex",
        route: codexLaneRoute(event.reason),
        event: "cancel",
        from: opaqueLaneOf("codex-native"),
        to: "local",
        reason: "opaque-checkpoint",
        checkpointEntryId: opaque.entryId,
        noticeAttempted: true,
      },
      (message) => ctx.ui.notify(message, "warning"),
    );
  return text;
}

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
  return (
    isJsonObject(details) &&
    details["strategy"] === "openai-responses-compaction-v2" &&
    details["schemaVersion"] === 1
  );
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
  if (!isNonEmptyString(accountId)) return { ok: false, reason: "account identity unavailable" };
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
    userMessageRetentionTokens: options.userMessageRetentionTokens,
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
function bindScope(state: IntegrationState, slot: SessionSlot, request: BindingRequest): void {
  const reusable =
    slot.binding !== undefined && sameBindingScope(slot.binding, request.scope)
      ? slot.binding
      : undefined;
  const active = reusable ?? replaceBinding(state, slot, request);
  active.runtime = request.runtime;
  publishBinding(slot.ownerKey, { binding: active, generation: slot.generation });
}

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
  const openaiServerSide = state.options.openaiServerSide?.() ?? false;
  const settings =
    slot.settingsSnapshot ??
    (await (state.options.resolveSettings?.(cwd, trusted) ??
      resolveCodexBackgroundSettings({ cwd, trusted, openaiServerSide })));
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
  const entryId = latest.ok ? latest.entry.id : latest.latestCompaction?.id;
  const incompatible = (reason: string): undefined =>
    markIncompatible(state, slot, ctx, { hasBackgroundCheckpoint, entryId, reason });
  if (hasBackgroundCheckpoint && checkpoint === undefined)
    return incompatible("invalid checkpoint metadata");
  if (model === undefined || model.api !== "openai-codex-responses")
    return incompatible("provider/model changed");
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!current()) return undefined;
  const identity = resolveAccountIdentity(auth);
  if (!identity.ok) return yieldTransientIdentity(state, slot, ctx, identity.reason);
  const { scope, runtime } = scopeAndRuntime(model, identity);
  const recordedScope = checkpoint?.details.background.providerScope;
  if (
    checkpoint !== undefined &&
    recordedScope !== undefined &&
    onlyModelChanged(recordedScope, scope)
  )
    return useForegroundReplay(state, slot, ctx, {
      entryId: checkpoint.entryId,
      from: recordedScope.model,
      to: scope.model,
    });
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
  slot.foregroundReplayOnly = false;
  slot.checkpointEntryId = undefined;
  state.incompatibilityNotices.delete(sessionId);
  return scope;
}

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

export function createCodexBackgroundIntegration(options: CodexBackgroundIntegrationOptions) {
  const state: IntegrationState = {
    options,
    sessions: new Map(),
    diagnosed: new Set(),
    incompatibilityNotices: new Map(),
    transitions: new LaneTransitionMemo(),
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
    isGenerationCurrent: (expected: number): boolean =>
      [...state.sessions.values()].some((slot) => slot.generation === expected),
    requestState: (adapterState: AdapterState, sessionId: string) =>
      codexBackgroundRequestState(
        adapterState,
        state.sessions.get(sessionId)?.incompatibleCheckpoint === true,
      ),
    requestRefusal: (ctx: CodexBackgroundContext, sessionId: string): string | undefined =>
      incompatibleRefusal(state, ctx, sessionId, { route: "replay", event: "refuse" }),
    compactionRefusal: (
      ctx: CodexBackgroundContext,
      sessionId: string,
      event: Pick<SessionBeforeCompactEvent, "reason">,
    ): string | undefined =>
      incompatibleRefusal(state, ctx, sessionId, {
        route: codexLaneRoute(event.reason),
        event: "cancel",
      }),
    isForegroundReplayOnly: (sessionId: string): boolean =>
      state.sessions.get(sessionId)?.foregroundReplayOnly === true,
    invalidateSettings: (): void => {
      for (const slot of state.sessions.values()) slot.settingsSnapshot = undefined;
    },
    opaqueRefusal: (
      ctx: CodexBackgroundContext,
      sessionId: string,
      input: CodexOpaqueGuardInput,
    ): string | undefined => opaqueCheckpointRefusal(state, ctx, sessionId, input),
    opaqueCompactionCancel: (
      ctx: CodexBackgroundContext,
      event: Pick<SessionBeforeCompactEvent, "reason">,
    ): string | undefined => opaqueCompactionCancel(state, ctx, event),
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
    stop: (sessionId?: string) => stopIntegration(state, sessionId),
  };
}
