import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  hasMethods,
  isBoolean,
  isNonNegativeInteger,
  isOptional,
  isRecord,
  readProperty,
} from "./guards.ts";
import { isCodexTransportContext, isResponsesContext } from "@choco-pi/shared/codex-model";

export type CompactionOwner = "none" | "codex-native" | "anthropic-native" | "xai-native" | "local";

export interface CodexCompactionSnapshot {
  readonly responsesCompaction: boolean;
  readonly additionalProviders: readonly string[];
}

const MAIN_OWNER_KEY_PREFIX = "main-session:";

export function mainOwnerKey(sessionId: string): string {
  return `${MAIN_OWNER_KEY_PREFIX}${sessionId}`;
}

export const CHILD_OWNER_KEY_PREFIX = "subagent-child:";

export function ownerKeyFor(sessionId: string): string {
  return isChildSession(sessionId)
    ? `${CHILD_OWNER_KEY_PREFIX}${sessionId}`
    : mainOwnerKey(sessionId);
}

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
interface ChildSessionRegistry {
  isChildSessionId(sessionId: string): boolean;
}

function isChildSessionRegistry<Value>(value: Value): value is Value & ChildSessionRegistry {
  return hasMethods(value, ["isChildSessionId"]);
}

export function isChildSession(sessionId: string): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  if (!isChildSessionRegistry(entry)) return false;
  return entry.isChildSessionId(sessionId) === true;
}

export const CODEX_ELIGIBILITY_SLOT: unique symbol = Symbol.for(
  "choco-pi.codex-compaction-eligibility",
);

export interface CodexEligibilityModel {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly baseUrl: string;
}

export interface CodexEligibility {
  readonly version: 1;
  readonly revision: number;
  readonly published?: boolean;
  readonly responsesCompaction?: boolean;
  isNativeCompactionOwner(model: CodexEligibilityModel): boolean;
  subscribe(listener: (revision: number) => void): () => void;
}

function isCodexEligibility<T>(value: T): value is T & CodexEligibility {
  return (
    isRecord(value) &&
    readProperty(value, "version") === 1 &&
    isNonNegativeInteger(readProperty(value, "revision")) &&
    isOptional(readProperty(value, "published"), isBoolean) &&
    isOptional(readProperty(value, "responsesCompaction"), isBoolean) &&
    hasMethods(value, ["isNativeCompactionOwner", "subscribe"])
  );
}

export function readCodexEligibility(): CodexEligibility | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, CODEX_ELIGIBILITY_SLOT)?.value;
  return isCodexEligibility(found) ? found : undefined;
}

export function publishedCodexResponsesCompaction(): boolean | undefined {
  const slot = readCodexEligibility();
  if (slot === undefined || slot.published === false) return undefined;
  return slot.responsesCompaction;
}

export interface OwnerOptions {
  readonly anthropicServerSide?: boolean;
  readonly xaiServerSide?: boolean;
}

function codexOwns(
  ctx: Pick<ExtensionContext, "model">,
  model: CodexEligibilityModel,
  snapshot: CodexCompactionSnapshot | undefined,
): boolean {
  const eligibility = readCodexEligibility();
  if (eligibility !== undefined && eligibility.published !== false) {
    const native: unknown = eligibility.isNativeCompactionOwner({
      provider: model.provider,
      id: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
    });
    return native === true;
  }
  if (isCodexTransportContext(ctx) && (snapshot === undefined || snapshot.responsesCompaction)) {
    return true;
  }
  if (!snapshot?.responsesCompaction || !isResponsesContext(ctx)) return false;
  const provider = model.provider.trim().toLowerCase();
  return provider.length > 0 && snapshot.additionalProviders.includes(provider);
}

export function resolveOwner(
  ctx: Pick<ExtensionContext, "model">,
  snapshot?: CodexCompactionSnapshot | undefined,
  options: OwnerOptions = {},
): CompactionOwner {
  const model = ctx.model;
  if (!model) {
    return "none";
  }
  if (codexOwns(ctx, model, snapshot)) {
    return "codex-native";
  }
  if (options.anthropicServerSide === true && model.api === "anthropic-messages") {
    return "anthropic-native";
  }
  if (
    options.xaiServerSide === true &&
    model.api === "openai-responses" &&
    model.provider === "xai"
  ) {
    return "xai-native";
  }
  return "local";
}
