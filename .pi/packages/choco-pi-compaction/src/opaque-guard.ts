/**
 * Route composition of the opaque-history guard (D2) over the predicates in
 * `opaque-checkpoint.ts`.
 *
 * - {@link guardBeforeLocalSummary}: the last step before the local
 *   summarizer answers `session_before_compact`. Over an opaque checkpoint
 *   the summarizer would only see the placeholder; without the user's
 *   authorization the compaction is cancelled with the exits notice.
 * - The pending-block registry (`opaque-block.ts`, re-exported here): a
 *   process-global record of sessions whose next request would carry
 *   placeholder-only context to a provider other than the checkpoint's
 *   owner. Owners publish it before the request is built (the xAI replay at
 *   `context` time, the Codex package for its own checkpoints); a
 *   `before_provider_request` handler cannot stop a request (the host's
 *   runner catches throws and sends the payload anyway).
 * - {@link installOpaqueBlockProvider}: enforces a pending block at the
 *   provider boundary. It overlays the current model's provider (a config
 *   registration's `streamSimple`, or a native `Provider`'s stream entry
 *   points; any provider id) and refuses a blocked request locally, before
 *   anything is serialized or transmitted.
 *
 * Runtime imports are limited to `opaque-checkpoint.ts`, `opaque-block.ts`,
 * `lifecycle.ts` and `typebox`, so the transport modules can import this file without
 * a cycle.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { LaneId, LaneRecordInput, LaneRoute } from "./background/lane-journal.ts";
import type { CompactionModes } from "./background-host/runtime.ts";
import { isStaleContextError } from "./lifecycle.ts";
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

/** Own reason codes the guard journals (members of `REASONS` in `background/lane-journal.ts`). */
const OPAQUE_CHECKPOINT_REASON = "opaque-checkpoint";
const LOSS_REASON = "loss";

/** One guard record as the caller journals it; `noticeAttempted` is always true (policy `always`). */
export type OpaqueGuardRecord = Omit<LaneRecordInput, "noticeAttempted">;

/** The context fields the guard reads; the announcer receives the caller's full context. */
export type OpaqueGuardContext = Pick<ExtensionContext, "sessionManager">;

/** Journal one guard record and show `text` verbatim (policy `always`). */
export type OpaqueGuardAnnounce<C extends OpaqueGuardContext = ExtensionContext> = (
  ctx: C,
  record: OpaqueGuardRecord,
  text: string,
) => void;

export interface OpaqueGuardInput<C extends OpaqueGuardContext = ExtensionContext> {
  /** The registration's vendor modes and opaque-history setting. */
  readonly modes: CompactionModes;
  /** Who owns this compaction (`resolveOwner`). */
  readonly owner: CompactionOwner;
  /** Session-scoped consent; defaults to the process-global consent slot. */
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
  readonly announce: OpaqueGuardAnnounce<C>;
  readonly now?: () => number;
}

const CANCEL: SessionBeforeCompactResult = { cancel: true };

/**
 * The lane that answers when this handler chain reaches the summarizer step:
 * Codex answers its own compactions in its extension; every other owner
 * (including a native lane that fell through) ends at the local summarizer.
 */
export function answeringLaneOf(owner: CompactionOwner): LaneId {
  return owner === "codex-native" ? "codex-foreground" : "local";
}

/** Loss is authorized by the setting or by a consent for exactly this checkpoint. */
export function opaqueLossAuthorized(
  modes: Pick<CompactionModes, "opaqueHistory">,
  sessionId: string,
  entryId: string,
  consent: (sessionId: string, entryId: string) => boolean = lossAuthorizedFor,
): boolean {
  return modes.opaqueHistory === "allow-loss" || consent(sessionId, entryId);
}

/**
 * The guard before the local summarizer. Undefined lets the chain continue
 * (no opaque checkpoint, a lane that can replay it, or authorized loss, which
 * is journaled and notified); `{ cancel: true }` stops the compaction with the
 * exits notice. A stale context (the session is gone) cancels quietly.
 */
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

// ---------------------------------------------------------------------------
// Provider-boundary enforcement of pending blocks
// ---------------------------------------------------------------------------

/** Prefix of the local error a blocked request ends with (never a provider body). */
export const OPAQUE_BLOCK_REFUSAL_PREFIX = "choco-pi compaction: request not sent";

/** The registration seams the provider block reads. */
export interface OpaqueBlockProviderHost<C extends OverlayContext = ExtensionContext> {
  /** The registration's opaque-history setting; `allow-loss` lifts every block. */
  modes(): Pick<CompactionModes, "opaqueHistory">;
  /** Journal one guard record and show its notice (policy `always`; deduped here). */
  readonly announce: (ctx: C, record: OpaqueGuardRecord, text: string) => void;
  readonly now?: () => number;
}

export interface OpaqueBlockProvider<C extends OverlayContext = ExtensionContext> {
  /**
   * Overlay the context's current model provider (idempotent; re-wraps a
   * replaced overlay) and record the context's session as this registration's.
   */
  sync(ctx: C): void;
  /** Restore the overlaid provider and withdraw this registration's session. */
  release(): void;
}

type ProviderRegistration = Parameters<ExtensionAPI["registerProvider"]>[1];
type ProviderStream = NonNullable<ProviderRegistration["streamSimple"]>;

/** The registry reads the overlay needs (a `ModelRegistry` fits). */
export interface OverlayRegistry {
  getRegisteredProviderConfig(provider: string): ProviderRegistration | undefined;
  getRegisteredNativeProvider(provider: string): Provider | undefined;
  getProvider(provider: string): { readonly streamSimple: ProviderStream } | undefined;
}

/** The context reads the overlay needs (an `ExtensionContext` fits). */
export interface OverlayContext {
  readonly model: Pick<Model<Api>, "provider" | "api"> | undefined;
  readonly modelRegistry: OverlayRegistry;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}

/** The provider registration calls the overlay makes (an `ExtensionAPI` fits). */
export interface OverlayHostApi {
  /** A native registration (replaces the provider's native and config registrations). */
  registerProvider(provider: Provider): void;
  /** A config registration (merged over the previous config; replaces a native one). */
  registerProvider(name: string, config: ProviderRegistration): void;
  unregisterProvider(name: string): void;
}

/** A config overlay: an extension registration whose `streamSimple` enforces. */
interface ConfigOverlay {
  readonly kind: "config";
  readonly provider: string;
  readonly api: Api;
  /** The provider's extension registration before the overlay (undefined: none). */
  readonly previous: ProviderRegistration | undefined;
  readonly stream: ProviderStream;
  readonly registry: OverlayRegistry;
}

/** A native overlay: a delegating `Provider` registered in place of the native one. */
interface NativeOverlay {
  readonly kind: "native";
  readonly provider: string;
  /** The native registration the overlay replaced and restores. */
  readonly previous: Provider;
  readonly wrapper: Provider;
  readonly registry: OverlayRegistry;
}

/** One overlay this registration installed. */
type ProviderOverlay = ConfigOverlay | NativeOverlay;

/** One registration among a provider's users. */
interface RegistrationToken {
  readonly registration: true;
}

/** The guard events a session's owning registration journals from the overlay. */
type OverlayEvent = "refuse" | "loss";

/** The registration that owns a session: its loss setting and its announcer. */
interface SessionOwnerEntry {
  readonly allowLoss: () => boolean;
  /**
   * Journal and notify one guard event for this session, once per checkpoint,
   * event and detail (`detail`: why it was attributed to this session, when
   * not by the request's id).
   */
  readonly announce: (
    event: OverlayEvent,
    block: OpaqueBlock,
    text: string,
    detail: string | undefined,
  ) => void;
}

/**
 * Process-wide overlay state shared by every compaction registration on the
 * same model runtime (a main session and its in-process children): which
 * streams are block overlays (one is never wrapped by another, so two
 * registrations never re-wrap each other on every request), which
 * registration owns each session (any overlay refuses; the owner journals),
 * which registrations' current models use each provider id, and a generation
 * bumped on every change of the last two.
 *
 * Membership is keyed by provider id, never by an overlay object: a provider
 * re-registered and re-wrapped by one registration still counts every other
 * registration that has not synced since, and so does an obsolete overlay a
 * request captured before the replacement. Provider ids are not scoped to a
 * model runtime, so registrations on different runtimes that share an id
 * count as sharing (fail closed).
 */
interface OverlaySlot {
  readonly version: 3;
  readonly overlays: WeakSet<object>;
  readonly owners: Map<string, SessionOwnerEntry>;
  /** Per provider id: the registrations whose current model uses it. */
  readonly users: Map<string, Set<RegistrationToken>>;
  generation: number;
}

const OVERLAY_SLOT_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-opaque-block-overlay");
const OverlaySlotSchema = Type.Object({
  version: Type.Literal(3),
  overlays: Type.Unknown(),
  owners: Type.Unknown(),
  users: Type.Unknown(),
  generation: Type.Integer({ minimum: 0 }),
});

/**
 * Private slots, made when a foreign value (or another version's slot)
 * occupies the shared one: other registrations' memberships are invisible
 * there, so every overlay on one counts as shared.
 */
const ISOLATED_SLOTS = new WeakSet<OverlaySlot>();

function isOverlaySlot<T>(value: T): value is T & OverlaySlot {
  return (
    Value.Check(OverlaySlotSchema, value) &&
    value.overlays instanceof WeakSet &&
    value.owners instanceof Map &&
    value.users instanceof Map
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

/** The shared slot (created on first use); an isolated private one when a foreign value occupies it. */
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
/** Detail of a guard event for a request that carried no session id. */
const UNATTRIBUTED_DETAIL = "unattributed-request";

/** The request fields a gate reads (every stream entry point's options fit). */
interface GatedRequest {
  readonly sessionId?: string;
}

/**
 * Throws the local refusal when the request must not be sent. `provider` is
 * the provider id the overlay the request reached was installed for.
 */
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

/**
 * Enforce pending opaque blocks at the provider boundary (D2). The current
 * model's provider (any provider id) is overlaid and follows the model
 * (`session_start`, `model_select`, and every `context` event, which
 * precedes each agent-loop request, so a later registration of the same
 * provider, e.g. a capture transport registered at session start, is wrapped
 * again). A config registration (or a built-in provider) gets an enforcing
 * `streamSimple`; a native `Provider` registration is replaced by a
 * delegating `Provider` whose `stream` and `streamSimple` enforce and whose
 * every other member forwards to the original. Another registration's overlay
 * already enforces and is never wrapped. Before delegating, a request whose
 * session has a pending block and no authorized loss is refused locally: the
 * overlay throws, so nothing is serialized or transmitted. The session's
 * owning registration journals (`refuse`) and notifies once per session,
 * checkpoint, reason and detail; the error text carries the exits on every
 * refusal.
 *
 * A request without a `sessionId` is never attributed to a registration's
 * session: that owner is mutable (another registration syncs a shared
 * overlay, or the installer moves on while the host awaits `transformHeaders`
 * before the overlay runs). It is decided when it reaches the overlay, from
 * the registry alone: any pending block whose owner has not authorized loss
 * refuses it, and so does any pending block at all when more than one
 * registration's current model uses the overlay's provider id, whichever
 * overlay object each last synced (detail `unattributed-request`, journaled
 * by the blocking session's owner). Otherwise it is sent, and each block whose
 * owner allows loss is journaled as a `loss` by that owner. With no pending
 * block it is sent. A missing identity never authorizes a send.
 *
 * Not overlaid (no enforcement there): a config registration whose
 * `streamSimple` serves another api, and virtual models routed to another
 * provider. A native provider's `fetchDeferred` (a handle, no context),
 * `generateImages` and `classify` are forwarded unchanged.
 */
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

/** The overlay of {@link installOpaqueBlockProvider} without its event wiring. */
export function createOpaqueBlockOverlay<C extends OverlayContext>(
  pi: OverlayHostApi,
  host: OpaqueBlockProviderHost<C>,
): OpaqueBlockProvider<C> {
  const slot = overlaySlot();
  let current: ProviderOverlay | undefined;
  /** This registration's session and its entry in the shared slot. */
  let owned: { readonly sessionId: string; readonly entry: SessionOwnerEntry } | undefined;
  /** Guard events already announced, per session (checkpoint, event and detail). */
  const announced = new Map<string, Set<string>>();
  /** This registration's identity among an overlay's users. */
  const token: RegistrationToken = { registration: true };
  /** The provider id this registration's current model uses. */
  let serving: string | undefined;

  /** Record that this registration's model uses `provider` (undefined: none). */
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
    // The entry is refreshed (latest context); a new owner of the session bumps the generation.
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

  /**
   * Refuse a request by its own session id; without one, by the registry
   * alone (never by this registration's mutable session).
   */
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

  /** Put back the registration the overlay replaced, unless another registration replaced the overlay. */
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
      // Merge semantics put the earlier stream and api back; nothing else changed.
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

  /** Whether the overlay is still the provider's registration. */
  const installed = (overlay: ProviderOverlay): boolean =>
    overlay.kind === "native"
      ? overlay.registry.getRegisteredNativeProvider(overlay.provider) === overlay.wrapper
      : overlay.registry.getRegisteredProviderConfig(overlay.provider)?.streamSimple ===
        overlay.stream;

  const sync = (ctx: C): void => {
    ownSession(ctx);
    const model = ctx.model;
    if (model === undefined) return;
    // Membership follows the model's provider, whether or not an overlay applies to it.
    serve(model.provider);
    const registry = ctx.modelRegistry;
    // A native overlay serves every api of its provider; a config overlay serves one.
    if (
      current !== undefined &&
      (current.provider !== model.provider ||
        (current.kind === "config" && current.api !== model.api))
    ) {
      restore(current);
      current = undefined;
    }
    if (current !== undefined && installed(current)) return;
    // Replaced by a later registration (or never installed).
    current = undefined;
    const native = registry.getRegisteredNativeProvider(model.provider);
    if (native !== undefined) {
      // Another registration's overlay is on top: it enforces every session.
      if (slot.overlays.has(native)) return;
      const wrapper = enforcingProvider(native, model.provider, enforce);
      slot.overlays.add(wrapper);
      pi.registerProvider(wrapper);
      current = { kind: "native", provider: model.provider, previous: native, wrapper, registry };
      return;
    }
    const config = registry.getRegisteredProviderConfig(model.provider);
    // Another registration's overlay is on top: it enforces every session.
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

/**
 * The decision for a request without a session id, taken synchronously when
 * it reaches an overlay for `provider` and from the registry alone. Its
 * inputs (the pending blocks, their owners and loss settings, the provider's
 * users) are read once under one slot generation; the request is refused when
 * any pending block's owner has not authorized loss, when any block is
 * pending and more than one registration uses the provider or the slot is
 * isolated (the request could be any of theirs), or when ownership changed
 * before the request is handed on. Otherwise each block whose owner allows
 * loss is journaled as a `loss` by that owner.
 */
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
  // An announcement that re-entered and changed ownership voids the decision.
  if (slot.generation !== generation) {
    refuse(model, first.block, slot.owners.get(first.sessionId), UNATTRIBUTED_DETAIL);
  }
}

/**
 * The local refusal of a blocked request: the owning registration (when
 * known) announces, and the request ends with the exits before anything is
 * serialized or transmitted.
 */
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

/**
 * A native provider whose `stream` and `streamSimple` pass `gate` first
 * (under `provider`, the id it is registered for).
 * Every other member of the `Provider` contract the original has is
 * forwarded with the original as `this` (its state and private fields stay
 * its own; optional members exist exactly when the original's do), and the
 * original is the prototype, so fields outside the contract still resolve.
 */
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
