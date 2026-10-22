import {
  AgentSession,
  type CompactionResult,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
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
//
// The same bridge wraps the public `AgentSession.prototype.prompt` so a prompt
// that arrives while a manual compaction runs waits for it instead of being
// rejected (see `promptAfterCompaction`). Only public members are read.

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-session-compact-bridge:v1");

/** The session scalars a defer decides on, read before the first await. */
export interface SessionCompactHost {
  readonly sessionId: string;
  readonly isIdle: boolean;
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

/** The host's public `prompt`, called with the session as `this`. */
type PromptMethod = (this: AgentSession, text: string, options?: PromptOptions) => Promise<void>;

/** The prototype property the prompt patch replaces. */
const PROMPT_METHOD = "prompt";

/** The host's `prompt` property as found, and the wrapper installed over it. */
interface PromptPatch {
  readonly original: PromptMethod;
  readonly patched: PromptMethod;
  readonly writable: boolean;
  readonly enumerable: boolean;
  readonly configurable: boolean;
}

interface SessionCompactBridge {
  /** The host's own `compact`, restored when the last registration leaves. */
  readonly original: CompactMethod;
  /** The installed patch; restoring is skipped when something else replaced it. */
  readonly patched: CompactMethod;
  /** One entry per live registration, offered a request in registration order. */
  readonly defers: Set<SessionCompactDefer>;
  /**
   * The prompt wrapper, installed and restored with `patched`; undefined when
   * the host has no configurable `prompt` method on the prototype.
   */
  readonly prompt: PromptPatch | undefined;
}

/** The host prototype as this module reaches it: one public method it swaps. */
interface SessionCompactPrototype {
  compact: CompactMethod;
}

const SessionScalarsSchema = Type.Object({ sessionId: Type.String(), isIdle: Type.Boolean() });
const PromptPatchSchema = Type.Object({
  original: Type.Function([], Type.Unknown()),
  patched: Type.Function([], Type.Unknown()),
  writable: Type.Boolean(),
  enumerable: Type.Boolean(),
  configurable: Type.Boolean(),
});
const BridgeSlotSchema = Type.Object({
  original: Type.Function([], Type.Unknown()),
  patched: Type.Function([], Type.Unknown()),
  defers: Type.Unknown(),
  prompt: Type.Union([PromptPatchSchema, Type.Undefined()]),
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
  return Value.Check(SessionScalarsSchema, scalars) ? scalars : undefined;
}

// ---------------------------------------------------------------------------
// Prompt patch: wait for a running manual compaction instead of rejecting
// ---------------------------------------------------------------------------
//
// Pi 1.4.0 `AgentSession.prompt` (`dist/core/agent-session.js`):
//   1636  const expandPromptTemplates = options?.expandPromptTemplates ?? true;
//   1640  if (expandPromptTemplates && text.startsWith("/")) { ...extension command... }
//   1648  if (this._compactionAbortController !== undefined)
//   1649      throw new Error("Cannot submit a prompt while compaction is in progress. ...")
// A prompt Pi deferred during `agent_settled` (1632-1634) is re-run after the
// emission and is rejected there, in a call chain no caller awaits, when a
// compaction started meanwhile. Waiting on the public idle promise removes that
// race without predicting when the run settles, so a host compaction can start
// whenever it is requested.
//
// The host rejects only during a manual compaction (`compact()`), which first
// awaits `abort()` and so runs with no active agent run (`isStreaming` false).
// Automatic compaction runs only inside an active run (`_startRun` sets the run
// active at 1424; its compactions are reached from 430, 481, 1485 and 1559),
// where Pi queues a prompt as steer/follow-up instead of rejecting it; waiting
// for idle there would hold that prompt until the whole run ended. So the
// wrapper waits only while `isCompacting` (1224) holds without an active run;
// that also covers a branch summary running while idle, which then precedes
// the prompt.

/**
 * Whether the host would run `text` as an extension command before its
 * compaction check (agent-session.js:1636 and 1640). Such text is delegated at
 * once, as the host runs extension commands even while compacting.
 */
function isCommandFirst(text: string, options: PromptOptions | undefined): boolean {
  return (options?.expandPromptTemplates ?? true) && text.startsWith("/");
}

/** Whether a prompt on `session` now would meet a running compaction while idle. */
function compactionBlocksPrompt(session: AgentSession): boolean {
  return session.isCompacting && !session.isStreaming;
}

/**
 * Wait until no compaction blocks the prompt, then delegate. `waitForIdle()`
 * (agent-session.js:1983) resolves once the session is idle, which Pi checks
 * when a compaction ends (2212-2213); a compaction started after that is
 * waited for again. A session disposed meanwhile aborts its compaction, which
 * ends the wait; the host then decides what the prompt does.
 */
async function promptWhenCompacted(
  session: AgentSession,
  original: PromptMethod,
  text: string,
  options: PromptOptions | undefined,
): Promise<void> {
  while (compactionBlocksPrompt(session)) await session.waitForIdle();
  return original.call(session, text, options);
}

const PromptDescriptorSchema = Type.Object({
  value: Type.Function([], Type.Unknown()),
  writable: Type.Boolean(),
  enumerable: Type.Boolean(),
  configurable: Type.Literal(true),
});

/**
 * Wrap the host's `prompt` so a prompt arriving during a manual compaction
 * waits for it; undefined (nothing installed) when the prototype holds no
 * configurable `prompt` data property. Without a compaction, and for text the
 * host runs as an extension command first, the wrapper calls the original
 * synchronously, so Pi's own ordering (including its `agent_settled` deferral)
 * is unchanged.
 */
function installPromptPatch(): PromptPatch | undefined {
  const prototype: object = AgentSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, PROMPT_METHOD);
  const found = {
    value: descriptor?.value,
    writable: descriptor?.writable,
    enumerable: descriptor?.enumerable,
    configurable: descriptor?.configurable,
  };
  if (!Value.Check(PromptDescriptorSchema, found)) return undefined;
  // The validated own data property is exactly what this typed read returns.
  const original: PromptMethod = AgentSession.prototype.prompt;
  const patched: PromptMethod = function promptAfterCompaction(
    this: AgentSession,
    text: string,
    options?: PromptOptions,
  ): Promise<void> {
    if (isCommandFirst(text, options) || !compactionBlocksPrompt(this)) {
      return original.call(this, text, options);
    }
    return promptWhenCompacted(this, original, text, options);
  };
  Object.defineProperty(prototype, PROMPT_METHOD, {
    value: patched,
    writable: found.writable,
    enumerable: found.enumerable,
    configurable: true,
  });
  return {
    original,
    patched,
    writable: found.writable,
    enumerable: found.enumerable,
    configurable: found.configurable,
  };
}

/** Whether the prototype's `prompt` is still this bridge's wrapper (or none was installed). */
function promptStillOurs(prompt: PromptPatch | undefined): boolean {
  if (prompt === undefined) return true;
  const prototype: object = AgentSession.prototype;
  return Object.getOwnPropertyDescriptor(prototype, PROMPT_METHOD)?.value === prompt.patched;
}

/** Put the host's `prompt` back; the caller checked that ours is still installed. */
function restorePromptPatch(prompt: PromptPatch | undefined): void {
  if (prompt === undefined) return;
  Object.defineProperty(AgentSession.prototype, PROMPT_METHOD, {
    value: prompt.original,
    writable: prompt.writable,
    enumerable: prompt.enumerable,
    configurable: prompt.configurable,
  });
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
 * Install the prototype patches once per process and add `defer` for this
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
  const bridge: SessionCompactBridge = {
    original,
    patched,
    defers,
    prompt: installPromptPatch(),
  };
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, {
    configurable: true,
    writable: true,
    value: bridge,
  });
  prototype.compact = patched;
}

/**
 * Remove this registration's `defer`. The last one out restores the host's
 * methods, unless another patch has since replaced our `compact` or our
 * `prompt` (then both stay and so does the slot, so a later install reuses it
 * instead of stacking; with no defer left the `compact` patch only delegates).
 */
export function releaseSessionCompactBridge(defer: SessionCompactDefer): void {
  const bridge = readBridge();
  if (bridge === undefined) return;
  bridge.defers.delete(defer);
  if (bridge.defers.size > 0) return;
  const prototype = hostPrototype();
  if (prototype.compact !== bridge.patched || !promptStillOurs(bridge.prompt)) return;
  restorePromptPatch(bridge.prompt);
  prototype.compact = bridge.original;
  Reflect.deleteProperty(globalThis, BRIDGE_SYMBOL);
}

/** Number of registrations currently offered a request (test seam). */
export function liveSessionCompactDefers(): number {
  return readBridge()?.defers.size ?? 0;
}
