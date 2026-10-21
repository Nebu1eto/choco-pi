/**
 * Route composition of the opaque-history guard (D2) over the predicates in
 * `opaque-checkpoint.ts`.
 *
 * - {@link guardBeforeLocalSummary}: the last step before the local
 *   summarizer answers `session_before_compact`. Over an opaque checkpoint
 *   the summarizer would only see the placeholder; without the user's
 *   authorization the compaction is cancelled with the exits notice.
 * - The pending-block registry: a process-global record of sessions whose
 *   next request would carry placeholder-only context to a provider other
 *   than the checkpoint's owner. The xAI replay handler publishes it at
 *   `before_provider_request` time (a handler cannot stop a request: the
 *   host's runner catches throws and sends the payload anyway); a capturing
 *   transport of another provider consults it and refuses the request before
 *   it leaves the process.
 *
 * Runtime imports are limited to `opaque-checkpoint.ts`, `lifecycle.ts` and
 * `typebox`, so the transport modules can import this file without a cycle.
 */
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { LaneId, LaneRecordInput, LaneRoute } from "./background/lane-journal.ts";
import type { CompactionModes } from "./background-host/runtime.ts";
import { isStaleContextError } from "./lifecycle.ts";
import {
  laneMayAnswerOverOpaque,
  lossAuthorizedFor,
  OPAQUE_GUARD_NOTICE,
  type OpaqueOwner,
  opaqueCheckpointOf,
  opaqueLaneOf,
  opaqueProviderOf,
} from "./opaque-checkpoint.ts";
import type { CompactionOwner } from "./ownership.ts";

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
// Process-global pending-block registry (consumed by capturing transports)
// ---------------------------------------------------------------------------

/** A session whose next non-owner request must not carry placeholder-only context. */
export interface OpaqueBlock {
  readonly entryId: string;
  readonly owner: OpaqueOwner;
}

interface OpaqueBlockSlot {
  readonly version: 1;
  readonly blocks: Map<string, OpaqueBlock>;
}

export const OPAQUE_BLOCK_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-opaque-block");
const BlockSlotSchema = Type.Object({ version: Type.Literal(1), blocks: Type.Unknown() });
const BlockSchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  owner: Type.Union([Type.Literal("xai-native"), Type.Literal("codex-native")]),
});
/** Bound on tracked sessions; the oldest block is dropped first. */
const MAX_BLOCKS = 64;

function isBlockSlot<T>(value: T): value is T & OpaqueBlockSlot {
  return Value.Check(BlockSlotSchema, value) && value.blocks instanceof Map;
}

/** The slot, created on first write; undefined when a foreign value occupies it. */
function blockSlot(create: boolean): OpaqueBlockSlot | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, OPAQUE_BLOCK_SYMBOL);
  if (descriptor === undefined) {
    if (!create) return undefined;
    const created: OpaqueBlockSlot = { version: 1, blocks: new Map() };
    Object.defineProperty(globalThis, OPAQUE_BLOCK_SYMBOL, { value: created, configurable: true });
    return created;
  }
  const found: unknown = descriptor.value;
  return isBlockSlot(found) ? found : undefined;
}

/** Record that `sessionId`'s non-owner requests must be refused until cleared. */
export function setOpaqueBlock(sessionId: string, block: OpaqueBlock): void {
  const blocks = blockSlot(true)?.blocks;
  if (blocks === undefined) return;
  blocks.delete(sessionId);
  blocks.set(sessionId, { entryId: block.entryId, owner: block.owner });
  while (blocks.size > MAX_BLOCKS) {
    const oldest = blocks.keys().next();
    if (oldest.done === true) break;
    blocks.delete(oldest.value);
  }
}

/** Clear `sessionId`'s block (only the one for `entryId` when given). */
export function clearOpaqueBlock(sessionId: string, entryId?: string): void {
  const blocks = blockSlot(false)?.blocks;
  if (blocks === undefined) return;
  if (entryId !== undefined && blocks.get(sessionId)?.entryId !== entryId) return;
  blocks.delete(sessionId);
}

/**
 * The block a transport must enforce for `sessionId`, or undefined (none, a
 * malformed entry, or loss authorized since it was set). Pure read.
 */
export function pendingOpaqueBlock(sessionId: string): OpaqueBlock | undefined {
  const found: unknown = blockSlot(false)?.blocks.get(sessionId);
  if (!Value.Check(BlockSchema, found)) return undefined;
  if (lossAuthorizedFor(sessionId, found.entryId)) return undefined;
  return { entryId: found.entryId, owner: found.owner };
}
