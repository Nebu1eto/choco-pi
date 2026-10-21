/**
 * Process-global pending-block registry: sessions whose next request would
 * carry placeholder-only context to a provider other than the opaque
 * checkpoint's owner. Owners (the xAI replay, the Codex package) publish and
 * clear blocks; the provider-boundary overlay in `opaque-guard.ts` enforces
 * them.
 *
 * Dependency-light by design (runtime imports: `typebox` and
 * `opaque-checkpoint.ts` only) so other packages can import it without
 * pulling this package's host types into their programs.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";

import { lossAuthorizedFor, type OpaqueOwner } from "./opaque-checkpoint.ts";

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

/** Clear `sessionId`'s block only when `owner` set it (another owner's block is kept). */
export function clearOpaqueBlockOf(sessionId: string, owner: OpaqueOwner): void {
  const blocks = blockSlot(false)?.blocks;
  if (blocks === undefined) return;
  const found: unknown = blocks.get(sessionId);
  if (Value.Check(BlockSchema, found) && found.owner === owner) blocks.delete(sessionId);
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

/** One session's enforceable block. */
export interface PendingOpaqueBlock {
  readonly sessionId: string;
  readonly block: OpaqueBlock;
}

/**
 * Every block a transport must enforce, oldest first, with the same filtering
 * as {@link pendingOpaqueBlock}. Pure read.
 */
export function pendingOpaqueBlocks(): readonly PendingOpaqueBlock[] {
  const blocks = blockSlot(false)?.blocks;
  if (blocks === undefined) return [];
  const pending: PendingOpaqueBlock[] = [];
  for (const sessionId of blocks.keys()) {
    const block = pendingOpaqueBlock(sessionId);
    if (block !== undefined) pending.push({ sessionId, block });
  }
  return pending;
}
