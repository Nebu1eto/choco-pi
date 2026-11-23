import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import type { LaneId, LaneRecordInput, LaneRoute } from "./background/lane-journal.ts";
import type { CompactionModes } from "./background-host/runtime.ts";
import { isNonNegativeInteger, isRecord, readProperty } from "./guards.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { type OpaqueBlock, pendingOpaqueBlock, pendingOpaqueBlocks } from "./opaque-block.ts";
import {
  laneMayAnswerOverOpaque,
  lossAuthorizedFor,
  OPAQUE_GUARD_NOTICE,
  opaqueCheckpointOf,
  opaqueLaneOf,
  opaqueProviderOf,
} from "./opaque-checkpoint.ts";
import type { CompactionOwner } from "./ownership.ts";

export {
  clearOpaqueBlock,
  clearOpaqueBlockOf,
  OPAQUE_BLOCK_SYMBOL,
  type OpaqueBlock,
  type PendingOpaqueBlock,
  pendingOpaqueBlock,
  pendingOpaqueBlocks,
  setOpaqueBlock,
} from "./opaque-block.ts";

const OPAQUE_CHECKPOINT_REASON = "opaque-checkpoint";
const LOSS_REASON = "loss";

export type OpaqueGuardRecord = Omit<LaneRecordInput, "noticeAttempted">;

export type OpaqueGuardContext = Pick<ExtensionContext, "sessionManager">;

export type OpaqueGuardAnnounce<C extends OpaqueGuardContext = ExtensionContext> = (
  ctx: C,
  record: OpaqueGuardRecord,
  text: string,
) => void;

export interface OpaqueGuardInput<C extends OpaqueGuardContext = ExtensionContext> {
  readonly modes: CompactionModes;
  readonly owner: CompactionOwner;
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
  readonly announce: OpaqueGuardAnnounce<C>;
  readonly now?: () => number;
}

const CANCEL: SessionBeforeCompactResult = { cancel: true };

export function answeringLaneOf(owner: CompactionOwner): LaneId {
  return owner === "codex-native" ? "codex-foreground" : "local";
}

export function opaqueLossAuthorized(
  modes: Pick<CompactionModes, "opaqueHistory">,
  sessionId: string,
  entryId: string,
  consent: (sessionId: string, entryId: string) => boolean = lossAuthorizedFor,
): boolean {
  return modes.opaqueHistory === "allow-loss" || consent(sessionId, entryId);
}

export function guardBeforeLocalSummary<C extends OpaqueGuardContext>(
  input: OpaqueGuardInput<C>,
  event: SessionBeforeCompactEvent,
  ctx: C,
): SessionBeforeCompactResult | undefined {
  const opaque = opaqueCheckpointOf(event.branchEntries);
  if (opaque === undefined) return undefined;
  const lane = answeringLaneOf(input.owner);
  if (laneMayAnswerOverOpaque(lane, opaque)) return undefined;
  let sessionId: string;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return CANCEL;
    throw cause;
  }
  const provider = opaqueProviderOf(opaque.owner);
  const route: LaneRoute = event.reason === "manual" ? "manual" : "foreground";
  const base = {
    at: (input.now ?? Date.now)(),
    sessionId,
    provider,
    route,
    from: opaqueLaneOf(opaque.owner),
    to: lane,
    checkpointEntryId: opaque.entryId,
  } as const;
  if (opaqueLossAuthorized(input.modes, sessionId, opaque.entryId, input.lossAuthorized)) {
    input.announce(
      ctx,
      { ...base, event: "loss", reason: LOSS_REASON },
      `Compaction: summarizing without the opaque ${provider} server-side record ${opaque.entryId} (loss authorized); its compacted history is not part of the summary.`,
    );
    return undefined;
  }
  input.announce(
    ctx,
    { ...base, event: "cancel", reason: OPAQUE_CHECKPOINT_REASON },
    OPAQUE_GUARD_NOTICE(provider, opaque.entryId),
  );
  return CANCEL;
}

export const OPAQUE_BLOCK_REFUSAL_PREFIX = "choco-pi compaction: request not sent";

export interface OpaqueBlockProviderHost<C extends OverlayContext = ExtensionContext> {
  modes(): Pick<CompactionModes, "opaqueHistory">;
  readonly announce: (ctx: C, record: OpaqueGuardRecord, text: string) => void;
  readonly now?: () => number;
}

export interface OpaqueBlockProvider<C extends OverlayContext = ExtensionContext> {
  sync(ctx: C): void;
  release(): void;
}

type ProviderRegistration = Parameters<ExtensionAPI["registerProvider"]>[1];
type ProviderStream = NonNullable<ProviderRegistration["streamSimple"]>;

export interface OverlayRegistry {
  getRegisteredProviderConfig(provider: string): ProviderRegistration | undefined;
  getRegisteredNativeProvider(provider: string): Provider | undefined;
  getProvider(provider: string): { readonly streamSimple: ProviderStream } | undefined;
}

export interface OverlayContext {
  readonly model: Pick<Model<Api>, "provider" | "api"> | undefined;
  readonly modelRegistry: OverlayRegistry;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}

export interface OverlayHostApi {
  registerProvider(provider: Provider): void;
  registerProvider(name: string, config: ProviderRegistration): void;
  unregisterProvider(name: string): void;
}

interface ConfigOverlay {
  readonly kind: "config";
  readonly provider: string;
  readonly api: Api;
  readonly previous: ProviderRegistration | undefined;
  readonly stream: ProviderStream;
  readonly registry: OverlayRegistry;
}

interface NativeOverlay {
  readonly kind: "native";
  readonly provider: string;
  readonly previous: Provider;
  readonly wrapper: Provider;
  readonly registry: OverlayRegistry;
}

type ProviderOverlay = ConfigOverlay | NativeOverlay;

interface RegistrationToken {
  readonly registration: true;
}

type OverlayEvent = "refuse" | "loss";

interface SessionOwnerEntry {
  readonly allowLoss: () => boolean;
  readonly announce: (
    event: OverlayEvent,
    block: OpaqueBlock,
    text: string,
    detail: string | undefined,
  ) => void;
}

interface OverlaySlot {
  readonly version: 3;
  readonly overlays: WeakSet<object>;
  readonly owners: Map<string, SessionOwnerEntry>;
  readonly users: Map<string, Set<RegistrationToken>>;
  generation: number;
}

const OVERLAY_SLOT_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-opaque-block-overlay");

const ISOLATED_SLOTS = new WeakSet<OverlaySlot>();

function isOverlaySlot<T>(value: T): value is T & OverlaySlot {
  return (
    isRecord(value) &&
    readProperty(value, "version") === 3 &&
    isNonNegativeInteger(readProperty(value, "generation")) &&
    readProperty(value, "overlays") instanceof WeakSet &&
    readProperty(value, "owners") instanceof Map &&
    readProperty(value, "users") instanceof Map
  );
}

function newOverlaySlot(): OverlaySlot {
  return {
    version: 3,
    overlays: new WeakSet(),
    owners: new Map(),
    users: new Map(),
    generation: 0,
  };
}

function overlaySlot(): OverlaySlot {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, OVERLAY_SLOT_SYMBOL);
  if (descriptor === undefined) {
    const created = newOverlaySlot();
    Object.defineProperty(globalThis, OVERLAY_SLOT_SYMBOL, { value: created, configurable: true });
    return created;
  }
  const found: unknown = descriptor.value;
  if (isOverlaySlot(found)) return found;
  const isolated = newOverlaySlot();
  ISOLATED_SLOTS.add(isolated);
  return isolated;
}

const REFUSE_REASON = "opaque-checkpoint";
const UNATTRIBUTED_DETAIL = "unattributed-request";

interface GatedRequest {
  readonly sessionId?: string;
}

type StreamGate = (
  provider: string,
  model: Pick<Model<Api>, "provider">,
  options: GatedRequest | undefined,
) => void;

function sessionIdOf(ctx: OverlayContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return undefined;
    throw cause;
  }
}

export function installOpaqueBlockProvider(
  pi: ExtensionAPI,
  host: OpaqueBlockProviderHost,
): OpaqueBlockProvider {
  const overlay = createOpaqueBlockOverlay(pi, host);
  pi.on("session_start", (_event, ctx) => overlay.sync(ctx));
  pi.on("model_select", (_event, ctx) => overlay.sync(ctx));
  pi.on("context", (_event, ctx) => {
    overlay.sync(ctx);
    return undefined;
  });
  pi.on("session_shutdown", () => overlay.release());
  return overlay;
}

export function createOpaqueBlockOverlay<C extends OverlayContext>(
  pi: OverlayHostApi,
  host: OpaqueBlockProviderHost<C>,
): OpaqueBlockProvider<C> {
  const slot = overlaySlot();
  let current: ProviderOverlay | undefined;
  let owned: { readonly sessionId: string; readonly entry: SessionOwnerEntry } | undefined;
  const announced = new Map<string, Set<string>>();
  const token: RegistrationToken = { registration: true };
  let serving: string | undefined;

  const serve = (provider: string | undefined): void => {
    if (serving === provider) return;
    if (serving !== undefined) {
      const previous = slot.users.get(serving);
      previous?.delete(token);
      if (previous?.size === 0) slot.users.delete(serving);
    }
    serving = provider;
    if (provider !== undefined) {
      let users = slot.users.get(provider);
      if (users === undefined) {
        users = new Set();
        slot.users.set(provider, users);
      }
      users.add(token);
    }
    slot.generation += 1;
  };

  const ownSession = (ctx: C): void => {
    const sessionId = sessionIdOf(ctx);
    if (sessionId === undefined) return;
    if (owned !== undefined && owned.sessionId !== sessionId) withdraw();
    const changed = owned === undefined || slot.owners.get(sessionId) !== owned.entry;
    const entry: SessionOwnerEntry = {
      allowLoss: () => host.modes().opaqueHistory === "allow-loss",
      announce: (event, block, text, detail) => {
        const key = `${block.entryId}|${event}|${detail ?? ""}`;
        let keys = announced.get(sessionId);
        if (keys === undefined) {
          keys = new Set();
          announced.set(sessionId, keys);
        }
        if (keys.has(key)) return;
        keys.add(key);
        const record: OpaqueGuardRecord = {
          at: (host.now ?? Date.now)(),
          sessionId,
          provider: opaqueProviderOf(block.owner),
          route: "replay",
          event,
          from: opaqueLaneOf(block.owner),
          reason: event === "refuse" ? REFUSE_REASON : LOSS_REASON,
          checkpointEntryId: block.entryId,
        };
        if (detail !== undefined) record.detail = detail;
        host.announce(ctx, record, text);
      },
    };
    slot.owners.set(sessionId, entry);
    owned = { sessionId, entry };
    if (changed) slot.generation += 1;
  };

  const withdraw = (): void => {
    if (owned !== undefined && slot.owners.get(owned.sessionId) === owned.entry) {
      slot.owners.delete(owned.sessionId);
    }
    owned = undefined;
  };

  const enforce: StreamGate = (provider, model, options) => {
    const sessionId = options?.sessionId;
    if (sessionId === undefined) {
      enforceUnattributed(slot, provider, model);
      return;
    }
    const block = pendingOpaqueBlock(sessionId);
    if (block === undefined) return;
    const owner = slot.owners.get(sessionId);
    if (owner?.allowLoss() === true) return;
    refuse(model, block, owner, undefined);
  };

  const restore = (overlay: ProviderOverlay): void => {
    if (overlay.kind === "native") {
      if (overlay.registry.getRegisteredNativeProvider(overlay.provider) !== overlay.wrapper)
        return;
      pi.registerProvider(overlay.previous);
      return;
    }
    const config = overlay.registry.getRegisteredProviderConfig(overlay.provider);
    if (config === undefined || config.streamSimple !== overlay.stream) return;
    const previous = overlay.previous;
    if (previous?.streamSimple !== undefined && previous.api !== undefined) {
      pi.registerProvider(overlay.provider, {
        api: previous.api,
        streamSimple: previous.streamSimple,
      });
      return;
    }
    const restored: ProviderRegistration = { ...config };
    delete restored.streamSimple;
    if (previous?.api === undefined) delete restored.api;
    else restored.api = previous.api;
    pi.unregisterProvider(overlay.provider);
    if (Object.keys(restored).length > 0) pi.registerProvider(overlay.provider, restored);
  };

  const installed = (overlay: ProviderOverlay): boolean =>
    overlay.kind === "native"
      ? overlay.registry.getRegisteredNativeProvider(overlay.provider) === overlay.wrapper
      : overlay.registry.getRegisteredProviderConfig(overlay.provider)?.streamSimple ===
        overlay.stream;

  const sync = (ctx: C): void => {
    ownSession(ctx);
    const model = ctx.model;
    if (model === undefined) return;
    serve(model.provider);
    const registry = ctx.modelRegistry;
    if (
      current !== undefined &&
      (current.provider !== model.provider ||
        (current.kind === "config" && current.api !== model.api))
    ) {
      restore(current);
      current = undefined;
    }
    if (current !== undefined && installed(current)) return;
    current = undefined;
    const native = registry.getRegisteredNativeProvider(model.provider);
    if (native !== undefined) {
      if (slot.overlays.has(native)) return;
      const wrapper = enforcingProvider(native, model.provider, enforce);
      slot.overlays.add(wrapper);
      pi.registerProvider(wrapper);
      current = { kind: "native", provider: model.provider, previous: native, wrapper, registry };
      return;
    }
    const config = registry.getRegisteredProviderConfig(model.provider);
    if (config?.streamSimple !== undefined && slot.overlays.has(config.streamSimple)) return;
    if (config?.streamSimple !== undefined && config.api !== model.api) return;
    const fallback = registry.getProvider(model.provider);
    if (fallback === undefined) return;
    const provider = model.provider;
    const stream: ProviderStream = (streamModel, context, options) => {
      enforce(provider, streamModel, options);
      return fallback.streamSimple(streamModel, context, options);
    };
    slot.overlays.add(stream);
    pi.registerProvider(model.provider, { api: model.api, streamSimple: stream });
    current = {
      kind: "config",
      provider: model.provider,
      api: model.api,
      previous: config,
      registry,
      stream,
    };
  };

  const release = (): void => {
    if (current !== undefined) restore(current);
    current = undefined;
    serve(undefined);
    withdraw();
    announced.clear();
  };

  return { sync, release };
}

function enforceUnattributed(
  slot: OverlaySlot,
  provider: string,
  model: Pick<Model<Api>, "provider">,
): void {
  const generation = slot.generation;
  const pending = pendingOpaqueBlocks();
  const first = pending[0];
  if (first === undefined) return;
  const shared = ISOLATED_SLOTS.has(slot) || (slot.users.get(provider)?.size ?? 0) > 1;
  const lost: { readonly owner: SessionOwnerEntry; readonly block: OpaqueBlock }[] = [];
  for (const { sessionId, block } of pending) {
    const owner = slot.owners.get(sessionId);
    if (owner === undefined || !owner.allowLoss()) {
      refuse(model, block, owner, UNATTRIBUTED_DETAIL);
    }
    lost.push({ owner, block });
  }
  if (shared) refuse(model, first.block, slot.owners.get(first.sessionId), UNATTRIBUTED_DETAIL);
  for (const { owner, block } of lost) {
    const provider = opaqueProviderOf(block.owner);
    owner.announce(
      "loss",
      block,
      `Compaction: request to ${model.provider} sent without the opaque ${provider} server-side record ${block.entryId} (loss authorized); its compacted history is not part of the request.`,
      UNATTRIBUTED_DETAIL,
    );
  }
  if (slot.generation !== generation) {
    refuse(model, first.block, slot.owners.get(first.sessionId), UNATTRIBUTED_DETAIL);
  }
}

function refuse(
  model: Pick<Model<Api>, "provider">,
  block: OpaqueBlock,
  owner: SessionOwnerEntry | undefined,
  detail: string | undefined,
): never {
  const exits = OPAQUE_GUARD_NOTICE(opaqueProviderOf(block.owner), block.entryId);
  owner?.announce(
    "refuse",
    block,
    `Compaction: request to ${model.provider} not sent. ${exits}`,
    detail,
  );
  throw new Error(`${OPAQUE_BLOCK_REFUSAL_PREFIX} (${REFUSE_REASON}): ${exits}`);
}

function enforcingProvider(native: Provider, provider: string, gate: StreamGate): Provider {
  const wrapper: Provider = {
    get id() {
      return native.id;
    },
    get name() {
      return native.name;
    },
    get auth() {
      return native.auth;
    },
    getModels: () => native.getModels(),
    stream: (model, context, options) => {
      gate(provider, model, options);
      return native.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      gate(provider, model, options);
      return native.streamSimple(model, context, options);
    },
  };
  if ("baseUrl" in native) {
    Object.defineProperty(wrapper, "baseUrl", {
      get: () => native.baseUrl,
      enumerable: true,
      configurable: true,
    });
  }
  if ("headers" in native) {
    Object.defineProperty(wrapper, "headers", {
      get: () => native.headers,
      enumerable: true,
      configurable: true,
    });
  }
  if (native.getAllModels !== undefined) wrapper.getAllModels = native.getAllModels.bind(native);
  if (native.refreshModels !== undefined) wrapper.refreshModels = native.refreshModels.bind(native);
  if (native.filterModels !== undefined) wrapper.filterModels = native.filterModels.bind(native);
  if (native.filterAllModels !== undefined) {
    wrapper.filterAllModels = native.filterAllModels.bind(native);
  }
  if (native.fetchDeferred !== undefined) wrapper.fetchDeferred = native.fetchDeferred.bind(native);
  if (native.cancelDeferred !== undefined) {
    wrapper.cancelDeferred = native.cancelDeferred.bind(native);
  }
  if (native.generateImages !== undefined) {
    wrapper.generateImages = native.generateImages.bind(native);
  }
  if (native.classify !== undefined) wrapper.classify = native.classify.bind(native);
  Object.setPrototypeOf(wrapper, native);
  return wrapper;
}
