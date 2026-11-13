/**
 * Cross-package usage-limit slots:
 * - `choco-pi.usage-limit-policy`: root usage-limit extensions write owner policies; root and
 *   subagent consumers read them.
 * - `choco-pi-goal:recovery`: choco-pi-goal writes recovery ownership; the root policy reads it.
 * - `pi-subagents:manager`: choco-pi-subagents writes child-session probes; the root policy reads
 *   them. Every reader validates the host-owned value before using it.
 */
import { bool, compile, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { finiteNum } from "./finite-number.ts";
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
export const OnUsageLimitSchema = oneOf(ON_USAGE_LIMIT_VALUES);
const isOnUsageLimit = compile(OnUsageLimitSchema).check;

export function parseOnUsageLimit(value: RuntimeValue): OnUsageLimit | undefined {
  if (!isOnUsageLimit(value)) return undefined;
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

export const UsageLimitClassificationSchema = obj(
  {
    kind: oneOf(["quota", "billing", "transient"]),
    provider: str(),
    modelId: str(),
    accountId: opt(str()),
    resetAt: opt(finiteNum()),
    confidence: oneOf(["structured", "parsed", "inferred"]),
    sessionId: opt(str()),
  },
  { open: true },
);

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

/**
 * Answer of `UsageLimitPolicy.recheck`. `open` means current evidence no longer
 * shows the limit in force: a request succeeded after the closure, a reading
 * taken after it shows capacity, or no live reading exists. A closed answer
 * carries the updated end of the closure when the reading names one.
 */
export type UsageLimitRecheck = {
  open: boolean;
  until?: number;
  /** Short reason for refusal text, such as the exhausted window names. */
  detail?: string;
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
   * Re-checks a closure against live evidence and reopens the owner's own
   * closure when the limit is gone. `since` is when the caller's closure was
   * written; evidence older than it proves nothing. Absent from policies that
   * predate it; readers then keep the stored closure.
   */
  recheck?(providerKey: string, accountId: string, since?: number): Promise<UsageLimitRecheck>;
  /**
   * Reopens the closure after a request that started at `at` succeeded; a
   * success that started before the closure was written changes nothing.
   */
  reopen?(providerKey: string, accountId: string, at?: number): void;
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
    (record.accountId === undefined || isFunction(record.accountId)) &&
    (record.recheck === undefined || isFunction(record.recheck)) &&
    (record.reopen === undefined || isFunction(record.reopen))
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
export const UsageLimitPendingEntrySchema = obj(
  {
    recoveryId: str(),
    resetAt: opt(finiteNum()),
    modelId: str(),
    provider: str(),
    accountId: str(),
    attempts: finiteNum(),
    branchEntryId: opt(str()),
    sessionId: opt(str()),
  },
  { open: true },
);
const isUsageLimitPendingEntry = compile(UsageLimitPendingEntrySchema).check;

export const USAGE_LIMIT_RESOLVED_ENTRY = "choco-pi-usage-limit-resolved";
export type UsageLimitResolvedEntry = {
  recoveryId: string;
  outcome: "continued" | "cancelled" | "exhausted";
};
export const UsageLimitResolvedEntrySchema = obj(
  {
    recoveryId: str(),
    outcome: oneOf(["continued", "cancelled", "exhausted"]),
  },
  { open: true },
);
const isUsageLimitResolvedEntry = compile(UsageLimitResolvedEntrySchema).check;

export const CODEX_USAGE_LIMIT_ENTRY = "choco-pi-codex-usage-limit";
export type CodexUsageLimitEntry = {
  resetAt?: number;
  planType?: string;
  accountId?: string;
  observedAt: number;
};
export const CodexUsageLimitEntrySchema = obj(
  {
    resetAt: opt(finiteNum()),
    planType: opt(str()),
    accountId: opt(str()),
    observedAt: finiteNum(),
  },
  { open: true },
);
const isCodexUsageLimitEntry = compile(CodexUsageLimitEntrySchema).check;

export function parseUsageLimitPendingEntry(
  value: RuntimeValue,
): UsageLimitPendingEntry | undefined {
  return isUsageLimitPendingEntry(value)
    ? reinterpretHostValue<UsageLimitPendingEntry>(value)
    : undefined;
}

export function parseUsageLimitResolvedEntry(
  value: RuntimeValue,
): UsageLimitResolvedEntry | undefined {
  return isUsageLimitResolvedEntry(value)
    ? reinterpretHostValue<UsageLimitResolvedEntry>(value)
    : undefined;
}

export function parseCodexUsageLimitEntry(value: RuntimeValue): CodexUsageLimitEntry | undefined {
  return isCodexUsageLimitEntry(value)
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
export const SubagentUsageLimitSchema = obj(
  {
    provider: str(),
    accountId: str(),
    kind: oneOf(["quota", "billing", "transient"]),
    resetAt: opt(finiteNum()),
    suggestedModel: opt(str()),
    status: oneOf(["reported", "waiting_for_reset", "resumed", "exhausted"]),
  },
  { open: true },
);
const isSubagentUsageLimit = compile(SubagentUsageLimitSchema).check;

export function parseSubagentUsageLimit(value: RuntimeValue): SubagentUsageLimit | undefined {
  return isSubagentUsageLimit(value) ? reinterpretHostValue<SubagentUsageLimit>(value) : undefined;
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

const GoalRecoveryOwnershipSchema = obj(
  {
    goalId: str(),
    status: oneOf(["active", "paused"]),
    providerLimitResumeScheduled: bool(),
    owner: opt(str()),
  },
  { open: true },
);
const isGoalRecoveryOwnership = compile(GoalRecoveryOwnershipSchema).check;

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
    if (!isGoalRecoveryOwnership(ownership)) return undefined;
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
