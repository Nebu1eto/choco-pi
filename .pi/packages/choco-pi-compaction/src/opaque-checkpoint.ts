/**
 * Opaque-history guard predicates (D2/D3). An opaque checkpoint is the
 * branch's newest compaction entry whose strategy is a provider-held record:
 * its summary is a placeholder, and only the lane that made it can replay the
 * real history. While that lane is not the one answering, no summarizer may
 * run over the placeholder and no request may carry placeholder-only context,
 * unless the user authorized the loss: the `compactionOpaqueHistory` setting
 * or a session-scoped `/compaction-allow-loss` consent for that checkpoint id.
 *
 * Consent is also published on a process-global slot so the Codex package can
 * consult it without importing the host runtime.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import type { OpaqueHistoryMode } from "./anthropic/mode.ts";
import type { LaneId } from "./background/lane-journal.ts";

/** Opaque members of `CheckpointStrategy` (`background/contract.ts`, a type-only union). */
const OpaqueStrategySchema = Type.Union([
  Type.Literal("xai-responses-compaction-v1"),
  Type.Literal("openai-responses-compaction-v2"),
  Type.Literal("openai-native-compact-v1"),
]);
type OpaqueStrategy = Static<typeof OpaqueStrategySchema>;

/** Checkpoint strategies whose summary text is a placeholder for provider-held history. */
export const OPAQUE_STRATEGIES: ReadonlySet<string> = new Set<OpaqueStrategy>([
  "xai-responses-compaction-v1",
  "openai-responses-compaction-v2",
  "openai-native-compact-v1",
]);

const OpaqueDetailsSchema = Type.Object(
  { strategy: OpaqueStrategySchema },
  { additionalProperties: true },
);

export type OpaqueOwner = "xai-native" | "codex-native";

export interface OpaqueCheckpoint {
  readonly entryId: string;
  readonly strategy: string;
  readonly owner: OpaqueOwner;
}

/** The journal provider of an opaque owner. */
export function opaqueProviderOf(owner: OpaqueOwner): "xai" | "codex" {
  return owner === "xai-native" ? "xai" : "codex";
}

/** The journal lane that made an opaque owner's checkpoints. */
export function opaqueLaneOf(owner: OpaqueOwner): LaneId {
  return owner === "xai-native" ? "xai-native" : "codex-native-v2";
}

/**
 * The branch's opaque checkpoint, decided by its newest compaction entry
 * only: an older opaque checkpoint behind a newer local one is replaced
 * history, not a guard condition.
 */
export function opaqueCheckpointOf(entries: readonly SessionEntry[]): OpaqueCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    const details = entry.details;
    if (!Value.Check(OpaqueDetailsSchema, details)) return undefined;
    const owner: OpaqueOwner =
      details.strategy === "xai-responses-compaction-v1" ? "xai-native" : "codex-native";
    return { entryId: entry.id, strategy: details.strategy, owner };
  }
  return undefined;
}

/**
 * Whether `lane` may answer a compaction (or send a request) over the opaque
 * checkpoint: only the owning native lane can replay the provider-held
 * history. Codex owns both its background and its foreground lane.
 */
export function laneMayAnswerOverOpaque(
  lane: LaneId,
  opaque: { readonly owner: OpaqueOwner },
): boolean {
  if (opaque.owner === "xai-native") return lane === "xai-native";
  return lane === "codex-native-v2" || lane === "codex-foreground";
}

/** Whether losing `entryId`'s history is authorized: the setting, or a consent for exactly that checkpoint. */
export function lossAuthorized(
  state: {
    readonly opaqueHistory: OpaqueHistoryMode;
    readonly opaqueConsent: ReadonlyMap<string, string>;
  },
  sessionId: string,
  entryId: string,
): boolean {
  if (state.opaqueHistory === "allow-loss") return true;
  return state.opaqueConsent.get(sessionId) === entryId;
}

/** The cancel/refusal text naming every exit; identical on every route. */
export const OPAQUE_GUARD_NOTICE = (provider: "xai" | "codex", entryId: string): string =>
  `compaction cancelled: the latest checkpoint ${entryId} is an opaque ${provider} server-side record and the ${provider} lane cannot replay it now. Run one turn on the ${provider} model that made it and retry, switch back to that model, or run /compaction-allow-loss (or set compactionOpaqueHistory=allow-loss) to summarize without it.`;

// ---------------------------------------------------------------------------
// Process-global consent slot (consumed by the Codex package)
// ---------------------------------------------------------------------------

/** One registration's consent decision. */
export type OpaqueConsentResolver = (sessionId: string, entryId: string) => boolean;

interface OpaqueConsentSlot {
  readonly version: 1;
  /** True when any published registration authorizes the loss. */
  lossAuthorizedFor(sessionId: string, entryId: string): boolean;
  /** Add one registration's resolver; returns its removal. */
  publish(resolver: OpaqueConsentResolver): () => void;
}

export const OPAQUE_CONSENT_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-opaque-consent",
);
const SlotCallable = Type.Function([], Type.Unknown());
const ConsentSlotSchema = Type.Object({
  version: Type.Literal(1),
  lossAuthorizedFor: SlotCallable,
  publish: SlotCallable,
});

function isConsentSlot<T>(value: T): value is T & OpaqueConsentSlot {
  return Value.Check(ConsentSlotSchema, value);
}

function createConsentSlot(): OpaqueConsentSlot {
  const resolvers = new Set<OpaqueConsentResolver>();
  return {
    version: 1,
    lossAuthorizedFor: (sessionId, entryId) => {
      for (const resolver of resolvers) {
        if (resolver(sessionId, entryId)) return true;
      }
      return false;
    },
    publish: (resolver) => {
      resolvers.add(resolver);
      return () => {
        resolvers.delete(resolver);
      };
    },
  };
}

/** The process-wide slot, or undefined when a foreign or corrupt value occupies it (refused, not replaced). */
function existingSlot(): OpaqueConsentSlot | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, OPAQUE_CONSENT_SYMBOL)?.value;
  return isConsentSlot(found) ? found : undefined;
}

/**
 * Publish one registration's consent decision on the process-global slot
 * (created on first publish). Returns the removal. A foreign slot is left
 * alone and nothing is published: consent then fails closed (preserve).
 */
export function publishOpaqueConsent(resolver: OpaqueConsentResolver): () => void {
  if (Object.getOwnPropertyDescriptor(globalThis, OPAQUE_CONSENT_SYMBOL) === undefined) {
    Object.defineProperty(globalThis, OPAQUE_CONSENT_SYMBOL, {
      value: createConsentSlot(),
      configurable: true,
    });
  }
  return existingSlot()?.publish(resolver) ?? (() => {});
}

/**
 * Whether any compaction registration in this process authorizes losing the
 * history behind `entryId` for `sessionId`. False when no slot exists or the
 * slot is foreign (fails closed: preserve).
 */
export function lossAuthorizedFor(sessionId: string, entryId: string): boolean {
  return existingSlot()?.lossAuthorizedFor(sessionId, entryId) === true;
}
