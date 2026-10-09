/**
 * Cross-package usage-limit slots:
 * - `choco-pi.usage-limit-policy`: root usage-limit extensions write owner policies; root and
 *   subagent consumers read them.
 * - `choco-pi-goal:recovery`: choco-pi-goal writes recovery ownership; the root policy reads it.
 * - `pi-subagents:manager`: choco-pi-subagents writes child-session probes; the root policy reads
 *   them. Every reader validates the host-owned value before using it.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  isFunction,
  isJsonRecord,
  isNumber,
  isString,
  reinterpretHostValue,
} from "./runtime-values.ts";
import type { RuntimeValue } from "./runtime-values.ts";

export const USAGE_LIMIT_POLICY_SYMBOL = Symbol.for("choco-pi.usage-limit-policy");
export const GOAL_RECOVERY_SYMBOL = Symbol.for("choco-pi-goal:recovery");
const SUBAGENT_MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

export type OnUsageLimit = "auto-resume" | "fallback" | "none";

export const ON_USAGE_LIMIT_VALUES: readonly OnUsageLimit[] = ["auto-resume", "fallback", "none"];
export const DEFAULT_ON_USAGE_LIMIT: OnUsageLimit = "none";
export const OnUsageLimitSchema = Type.Union(
  ON_USAGE_LIMIT_VALUES.map((value) => Type.Literal(value)),
);

export function parseOnUsageLimit(value: RuntimeValue): OnUsageLimit | undefined {
  if (!Value.Check(OnUsageLimitSchema, value)) return undefined;
  switch (value) {
    case "auto-resume":
    case "fallback":
    case "none":
      return value;
    default:
      return undefined;
  }
}

export type UsageLimitKind = "quota" | "billing" | "transient";
export type UsageLimitConfidence = "structured" | "parsed" | "inferred";

export type UsageLimitClassification = {
  kind: UsageLimitKind;
  provider: string;
  modelId: string;
  accountId?: string;
  resetAt?: number;
  confidence: UsageLimitConfidence;
  /**
   * Session whose run hit the limit. A policy consults its own branch's
   * provider entries only when this is absent or names the policy owner.
   */
  sessionId?: string;
};

export const UsageLimitClassificationSchema = Type.Object({
  kind: Type.Union([Type.Literal("quota"), Type.Literal("billing"), Type.Literal("transient")]),
  provider: Type.String(),
  modelId: Type.String(),
  accountId: Type.Optional(Type.String()),
  resetAt: Type.Optional(Type.Number()),
  confidence: Type.Union([
    Type.Literal("structured"),
    Type.Literal("parsed"),
    Type.Literal("inferred"),
  ]),
  sessionId: Type.Optional(Type.String()),
});

export type UsageLimitClassifyInput = {
  provider: string;
  modelId: string;
  errorMessage: string;
};

/**
 * What live account data proved about a limit:
 * - `confirmed`: a quota reading, or the provider's structured limit entry, shows the limit in force.
 * - `capacity`: a reading taken at or after the failure shows capacity, so the limit is not in force.
 * - `unavailable`: no reading could prove either (missing, stale, or unreadable data).
 */
export type UsageLimitEvidence = "confirmed" | "capacity" | "unavailable";

export type FallbackCandidateContext = {
  available: readonly { provider: string; id: string }[];
  scoped: readonly string[];
  isClosed(providerKey: string, accountId: string): boolean;
};

export type UsageLimitPolicy = {
  owner: string;
  generation: number;
  preference(): Promise<OnUsageLimit>;
  classify(input: UsageLimitClassifyInput): UsageLimitClassification | undefined;
  corroborate(classification: UsageLimitClassification): Promise<{
    ready: boolean;
    classification: UsageLimitClassification;
    /** Absent from policies that predate it; readers treat absence as `unavailable`. */
    evidence?: UsageLimitEvidence;
  }>;
  pickFallback(
    current: { provider: string; id: string },
    context: FallbackCandidateContext,
  ): { provider: string; id: string } | undefined;
  closeProvider(providerKey: string, accountId: string, untilMs: number): void;
  isClosed(providerKey: string, accountId: string, now?: number): boolean;
  /**
   * Account id the owner keys `provider`'s closures under (`"default"` when unknown).
   * Absent from policies that predate it; readers then use `"default"`.
   */
  accountId?(provider: string): string;
};

export function isUsageLimitPolicy(value: RuntimeValue): value is UsageLimitPolicy {
  if (!isJsonRecord(value)) return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(value);
  return (
    isString(record.owner) &&
    isNumber(record.generation) &&
    isFunction(record.preference) &&
    isFunction(record.classify) &&
    isFunction(record.corroborate) &&
    isFunction(record.pickFallback) &&
    isFunction(record.closeProvider) &&
    isFunction(record.isClosed) &&
    (record.accountId === undefined || isFunction(record.accountId))
  );
}

function isUsageLimitPolicyMap(value: RuntimeValue): value is Map<string, UsageLimitPolicy> {
  if (!(value instanceof Map)) return false;
  const entries = reinterpretHostValue<Map<RuntimeValue, RuntimeValue>>(value);
  for (const [owner, policy] of entries) {
    if (!isString(owner) || !isUsageLimitPolicy(policy)) return false;
  }
  return true;
}

export function getUsageLimitPolicyMap(): Map<string, UsageLimitPolicy> {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const existing = slots[USAGE_LIMIT_POLICY_SYMBOL];
  if (existing === undefined) {
    const policies = new Map<string, UsageLimitPolicy>();
    slots[USAGE_LIMIT_POLICY_SYMBOL] = policies;
    return policies;
  }
  if (!isUsageLimitPolicyMap(existing)) {
    throw new TypeError("Usage-limit policy slot must be a Map<string, UsageLimitPolicy>.");
  }
  return reinterpretHostValue<Map<string, UsageLimitPolicy>>(existing);
}

export function getUsageLimitPolicy(owner: string): UsageLimitPolicy | undefined {
  const policy = getUsageLimitPolicyMap().get(owner);
  return isUsageLimitPolicy(policy) ? policy : undefined;
}

export function registerUsageLimitPolicy(policy: UsageLimitPolicy): () => void {
  const policies = getUsageLimitPolicyMap();
  policies.set(policy.owner, policy);
  return () => {
    if (policies.get(policy.owner) === policy) policies.delete(policy.owner);
  };
}

export const USAGE_LIMIT_PENDING_ENTRY = "choco-pi-usage-limit-pending";
export type UsageLimitPendingEntry = {
  recoveryId: string;
  resetAt?: number;
  modelId: string;
  provider: string;
  accountId: string;
  attempts: number;
  branchEntryId?: string;
  /** Root session that wrote the entry; a fork or clone carrying a copy does not replay it. */
  sessionId?: string;
};
export const UsageLimitPendingEntrySchema = Type.Object({
  recoveryId: Type.String(),
  resetAt: Type.Optional(Type.Number()),
  modelId: Type.String(),
  provider: Type.String(),
  accountId: Type.String(),
  attempts: Type.Number(),
  branchEntryId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
});

export const USAGE_LIMIT_RESOLVED_ENTRY = "choco-pi-usage-limit-resolved";
export type UsageLimitResolvedEntry = {
  recoveryId: string;
  outcome: "continued" | "cancelled" | "exhausted";
};
export const UsageLimitResolvedEntrySchema = Type.Object({
  recoveryId: Type.String(),
  outcome: Type.Union([
    Type.Literal("continued"),
    Type.Literal("cancelled"),
    Type.Literal("exhausted"),
  ]),
});

export const CODEX_USAGE_LIMIT_ENTRY = "choco-pi-codex-usage-limit";
export type CodexUsageLimitEntry = {
  resetAt?: number;
  planType?: string;
  accountId?: string;
  observedAt: number;
};
export const CodexUsageLimitEntrySchema = Type.Object({
  resetAt: Type.Optional(Type.Number()),
  planType: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  observedAt: Type.Number(),
});

export function parseUsageLimitPendingEntry(
  value: RuntimeValue,
): UsageLimitPendingEntry | undefined {
  return Value.Check(UsageLimitPendingEntrySchema, value)
    ? reinterpretHostValue<UsageLimitPendingEntry>(value)
    : undefined;
}

export function parseUsageLimitResolvedEntry(
  value: RuntimeValue,
): UsageLimitResolvedEntry | undefined {
  return Value.Check(UsageLimitResolvedEntrySchema, value)
    ? reinterpretHostValue<UsageLimitResolvedEntry>(value)
    : undefined;
}

export function parseCodexUsageLimitEntry(value: RuntimeValue): CodexUsageLimitEntry | undefined {
  return Value.Check(CodexUsageLimitEntrySchema, value)
    ? reinterpretHostValue<CodexUsageLimitEntry>(value)
    : undefined;
}

export type SubagentUsageLimit = {
  provider: string;
  accountId: string;
  kind: UsageLimitKind;
  resetAt?: number;
  suggestedModel?: string;
  status: "reported" | "waiting_for_reset" | "resumed" | "exhausted";
};
export const SubagentUsageLimitSchema = Type.Object({
  provider: Type.String(),
  accountId: Type.String(),
  kind: Type.Union([Type.Literal("quota"), Type.Literal("billing"), Type.Literal("transient")]),
  resetAt: Type.Optional(Type.Number()),
  suggestedModel: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal("reported"),
    Type.Literal("waiting_for_reset"),
    Type.Literal("resumed"),
    Type.Literal("exhausted"),
  ]),
});

export function parseSubagentUsageLimit(value: RuntimeValue): SubagentUsageLimit | undefined {
  return Value.Check(SubagentUsageLimitSchema, value)
    ? reinterpretHostValue<SubagentUsageLimit>(value)
    : undefined;
}

export const SUBAGENTS_USAGE_LIMIT_EVENT = "subagents:usage_limit";
export type SubagentsUsageLimitEvent = {
  agentId: string;
  provider: string;
  resetAt?: number;
  status: SubagentUsageLimit["status"];
};

export type GoalRecoveryOwnership = {
  goalId: string;
  status: "active" | "paused";
  providerLimitResumeScheduled: boolean;
  /** Session id of the goal runtime that owns recovery; absent from entries that predate it. */
  owner?: string;
};

const GoalRecoveryOwnershipSchema = Type.Object({
  goalId: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
  providerLimitResumeScheduled: Type.Boolean(),
  owner: Type.Optional(Type.String()),
});

/**
 * Reads goal recovery ownership. With `owner` (a root session id) the slot's
 * `recoveryOwnership(owner)` is asked for that session only, and a result that
 * names another owner is rejected. A result without an `owner` field comes from
 * a goal package that predates the argument and is accepted as-is.
 */
export function readGoalRecoveryOwnership(owner?: string): GoalRecoveryOwnership | undefined {
  try {
    const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
    const entry = slots[GOAL_RECOVERY_SYMBOL];
    if (!isJsonRecord(entry)) return undefined;
    const record = reinterpretHostValue<Record<string, RuntimeValue>>(entry);
    if (!isFunction(record.recoveryOwnership)) return undefined;
    const recoveryOwnership = reinterpretHostValue<(owner?: string) => RuntimeValue>(
      record.recoveryOwnership,
    );
    const ownership =
      owner === undefined ? recoveryOwnership.call(entry) : recoveryOwnership.call(entry, owner);
    if (!Value.Check(GoalRecoveryOwnershipSchema, ownership)) return undefined;
    const parsed = reinterpretHostValue<GoalRecoveryOwnership>(ownership);
    if (owner !== undefined && parsed.owner !== undefined && parsed.owner !== owner) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export type ChildSessionProbe = {
  isChildSessionContext(): boolean;
  isChildSessionId(id: string): boolean;
};

export function readChildSessionProbe(): ChildSessionProbe | undefined {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const entry = slots[SUBAGENT_MANAGER_SYMBOL];
  if (!isJsonRecord(entry)) return undefined;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(entry);
  const { isChildSessionContext, isChildSessionId } = record;
  if (!isFunction(isChildSessionContext) || !isFunction(isChildSessionId)) return undefined;
  const contextProbe = reinterpretHostValue<() => RuntimeValue>(isChildSessionContext);
  const idProbe = reinterpretHostValue<(id: string) => RuntimeValue>(isChildSessionId);
  return {
    isChildSessionContext: () => contextProbe.call(entry) === true,
    isChildSessionId: (id) => idProbe.call(entry, id) === true,
  };
}
