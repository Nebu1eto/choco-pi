import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compile, obj, oneOf } from "@earendil-works/pi-schema";

import type { OpaqueHistoryMode } from "./anthropic/mode.ts";
import type { LaneId } from "./background/lane-journal.ts";
import { hasMethods, readProperty } from "./guards.ts";

const OpaqueStrategySchema = oneOf([
  "xai-responses-compaction-v1",
  "openai-responses-compaction-v2",
  "openai-native-compact-v1",
]);
type OpaqueStrategy =
  | "xai-responses-compaction-v1"
  | "openai-responses-compaction-v2"
  | "openai-native-compact-v1";

export const OPAQUE_STRATEGIES: ReadonlySet<string> = new Set<OpaqueStrategy>([
  "xai-responses-compaction-v1",
  "openai-responses-compaction-v2",
  "openai-native-compact-v1",
]);

const isOpaqueDetails = compile(obj({ strategy: OpaqueStrategySchema }, { open: true })).check;

export type OpaqueOwner = "xai-native" | "codex-native";

export interface OpaqueCheckpoint {
  readonly entryId: string;
  readonly strategy: string;
  readonly owner: OpaqueOwner;
}

export function opaqueProviderOf(owner: OpaqueOwner): "xai" | "codex" {
  return owner === "xai-native" ? "xai" : "codex";
}

export function opaqueLaneOf(owner: OpaqueOwner): LaneId {
  return owner === "xai-native" ? "xai-native" : "codex-native-v2";
}

export function opaqueCheckpointOf(entries: readonly SessionEntry[]): OpaqueCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    const details = entry.details;
    if (!isOpaqueDetails(details)) return undefined;
    const owner: OpaqueOwner =
      details.strategy === "xai-responses-compaction-v1" ? "xai-native" : "codex-native";
    return { entryId: entry.id, strategy: details.strategy, owner };
  }
  return undefined;
}

export function laneMayAnswerOverOpaque(
  lane: LaneId,
  opaque: { readonly owner: OpaqueOwner },
): boolean {
  if (opaque.owner === "xai-native") return lane === "xai-native";
  return lane === "codex-native-v2" || lane === "codex-foreground";
}

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

export const OPAQUE_GUARD_NOTICE = (provider: "xai" | "codex", entryId: string): string =>
  `compaction cancelled: the latest checkpoint ${entryId} is an opaque ${provider} server-side record and the ${provider} lane cannot replay it now. Run one turn on the ${provider} model that made it and retry, switch back to that model, or run /compaction-allow-loss (or set compactionOpaqueHistory=allow-loss) to summarize without it.`;

export type OpaqueConsentResolver = (sessionId: string, entryId: string) => boolean;

interface OpaqueConsentSlot {
  readonly version: 1;
  lossAuthorizedFor(sessionId: string, entryId: string): boolean;
  publish(resolver: OpaqueConsentResolver): () => void;
}

export const OPAQUE_CONSENT_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-opaque-consent",
);
function isConsentSlot<T>(value: T): value is T & OpaqueConsentSlot {
  return (
    hasMethods(value, ["lossAuthorizedFor", "publish"]) && readProperty(value, "version") === 1
  );
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

function existingSlot(): OpaqueConsentSlot | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, OPAQUE_CONSENT_SYMBOL)?.value;
  return isConsentSlot(found) ? found : undefined;
}

export function publishOpaqueConsent(resolver: OpaqueConsentResolver): () => void {
  if (Object.getOwnPropertyDescriptor(globalThis, OPAQUE_CONSENT_SYMBOL) === undefined) {
    Object.defineProperty(globalThis, OPAQUE_CONSENT_SYMBOL, {
      value: createConsentSlot(),
      configurable: true,
    });
  }
  return existingSlot()?.publish(resolver) ?? (() => {});
}

export function lossAuthorizedFor(sessionId: string, entryId: string): boolean {
  return existingSlot()?.lossAuthorizedFor(sessionId, entryId) === true;
}
