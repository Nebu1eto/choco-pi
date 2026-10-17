import { AgentSession, type CompactionResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isStaleContextError } from "../lifecycle.ts";

// ---------------------------------------------------------------------------
// Programmatic compact bridge (RPC `compact`, SDK, extension `ctx.compact()`)
// ---------------------------------------------------------------------------
//
// RPC mode answers `compact` with `await session.compact(...)`, and the host's
// `compact()` aborts the running agent and starts a host compaction before any
// extension hook sees it; the only hook (`session_before_compact`) can end it
// only with `cancel`, which the client receives as `Compaction cancelled`.
// Taking over `AgentSession.prototype.compact` lets an idle session's request
// continue in the background and resolve at once. Every request the feature
// does not take goes to the host's own method unchanged.

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-session-compact-bridge:v1");

/** The session scalars a defer decides on, read before the first await. */
export interface SessionCompactHost {
  readonly sessionId: string;
  readonly isIdle: boolean;
  /**
   * Whether the request arrived while Pi emits `agent_settled` (for example
   * model-context-cap's `ctx.compact()`). Pi defers a prompt arriving then
   * and rejects it if a compaction is running when it re-runs.
   */
  readonly isSettling: boolean;
}

/**
 * What a defer did with a `compact()` request:
 * - `handled`: taken over; the request resolves `undefined` at once.
 * - `declined`: not this registration's request; the next one (or the host) gets it.
 * - `stale`: the request was this registration's, but its owner retired while
 *   deciding (shutdown, reload, session replaced). The request resolves
 *   `undefined` without a host compaction: the session it was made against is
 *   gone, and compacting whatever session the `AgentSession` now holds would
 *   act on a session nobody asked to compact.
 */
export type SessionCompactOutcome = "handled" | "declined" | "stale";

/** Decides what happens to a `compact()` on `host` (with optional instructions). */
export type SessionCompactDefer = (
  host: SessionCompactHost,
  customInstructions?: string,
) => Promise<SessionCompactOutcome>;

type CompactMethod = (
  this: AgentSession,
  customInstructions?: string,
) => Promise<CompactionResult | undefined>;

interface SessionCompactBridge {
  /** The host's own `compact`, restored when the last registration leaves. */
  readonly original: CompactMethod;
  /** The installed patch; restoring is skipped when something else replaced it. */
  readonly patched: CompactMethod;
  /** One entry per live registration, offered a request in registration order. */
  readonly defers: Set<SessionCompactDefer>;
}

/** The host prototype as this module reaches it: one public method it swaps. */
interface SessionCompactPrototype {
  compact: CompactMethod;
}

const SessionScalarsSchema = Type.Object({ sessionId: Type.String(), isIdle: Type.Boolean() });
const BridgeSlotSchema = Type.Object({
  original: Type.Function([], Type.Unknown()),
  patched: Type.Function([], Type.Unknown()),
  defers: Type.Unknown(),
});

function isBridge<T>(value: T): value is T & SessionCompactBridge {
  return Value.Check(BridgeSlotSchema, value) && value.defers instanceof Set;
}

function hostPrototype(): SessionCompactPrototype {
  const prototype: object = AgentSession.prototype;
  // SAFETY: `AgentSession.prototype.compact` is a method taking optional
  // instructions and returning a promise. The patch resolves `undefined` for a
  // request taken over; RPC `compact` sends that as a success without data,
  // the TUI handler ignores the result, and `ctx.compact()` forwards it to
  // `onComplete`.
  return prototype as SessionCompactPrototype;
}

function readBridge(): SessionCompactBridge | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_SYMBOL)?.value;
  return isBridge(found) ? found : undefined;
}

/** The session's id and idle state, or undefined when the host does not expose them. */
function readScalars(session: AgentSession): SessionCompactHost | undefined {
  const scalars = { sessionId: session.sessionId, isIdle: session.isIdle };
  if (!Value.Check(SessionScalarsSchema, scalars)) return undefined;
  return { ...scalars, isSettling: readSettling(session) };
}

/**
 * Pi's own "emitting agent_settled" flag (`AgentSession._isEmittingAgentSettled`,
 * the switch its `prompt()` defers on). Not public API: a host without a
 * boolean there reads as not settling, which keeps the host's own behavior.
 */
function readSettling(session: AgentSession): boolean {
  // A class field: an own data property of the instance, read without its private type.
  const flag: unknown = Object.getOwnPropertyDescriptor(session, "_isEmittingAgentSettled")?.value;
  return Value.Check(Type.Boolean(), flag) && flag;
}

/**
 * Offer the request to each live defer until one handles it or reports it
 * stale. After every await the session identity is read again: a session
 * replaced while a defer was deciding makes the request stale. A registration
 * whose owner retired while deciding reports `stale` itself. Only
 * stale-context errors are contained (as stale); any other failure reaches
 * the caller.
 */
async function offer(
  bridge: SessionCompactBridge,
  session: AgentSession,
  host: SessionCompactHost,
  customInstructions: string | undefined,
): Promise<SessionCompactOutcome> {
  // A registration released before its turn is skipped; Set iteration tolerates deletes.
  for (const current of bridge.defers) {
    let outcome: SessionCompactOutcome;
    try {
      outcome = await current(host, customInstructions);
    } catch (cause) {
      if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
      outcome = "stale";
    }
    if (outcome !== "declined") return outcome;
    if (readScalars(session)?.sessionId !== host.sessionId) return "stale";
  }
  return "declined";
}

/**
 * Install the prototype patch once per process and add `defer` for this
 * registration. Later installs (after `/reload`, or a child session) only add.
 */
export function installSessionCompactBridge(defer: SessionCompactDefer): void {
  const existing = readBridge();
  if (existing !== undefined) {
    existing.defers.add(defer);
    return;
  }
  const prototype = hostPrototype();
  const original = prototype.compact;
  const defers = new Set<SessionCompactDefer>([defer]);
  const patched: CompactMethod = async function patchedCompact(
    this: AgentSession,
    customInstructions?: string,
  ): Promise<CompactionResult | undefined> {
    const host = readScalars(this);
    if (host === undefined) return original.call(this, customInstructions);
    const outcome = await offer(bridge, this, host, customInstructions);
    // Handled requests continue in the background; stale ones settle without
    // compacting (see `SessionCompactOutcome`). Both resolve like a request taken over.
    if (outcome !== "declined") return undefined;
    return original.call(this, customInstructions);
  };
  const bridge: SessionCompactBridge = { original, patched, defers };
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, {
    configurable: true,
    writable: true,
    value: bridge,
  });
  prototype.compact = patched;
}

/**
 * Remove this registration's `defer`. The last one out restores the host's
 * method, unless another patch has since replaced ours (then the slot stays so
 * a later install reuses it instead of stacking).
 */
export function releaseSessionCompactBridge(defer: SessionCompactDefer): void {
  const bridge = readBridge();
  if (bridge === undefined) return;
  bridge.defers.delete(defer);
  if (bridge.defers.size > 0) return;
  const prototype = hostPrototype();
  if (prototype.compact !== bridge.patched) return;
  prototype.compact = bridge.original;
  Reflect.deleteProperty(globalThis, BRIDGE_SYMBOL);
}

/** Number of registrations currently offered a request (test seam). */
export function liveSessionCompactDefers(): number {
  return readBridge()?.defers.size ?? 0;
}
