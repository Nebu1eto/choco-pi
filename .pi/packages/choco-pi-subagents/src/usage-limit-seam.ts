/**
 * usage-limit-seam.ts — structural reader for the root usage-limit policy.
 *
 * The root choco-pi extension publishes owner-indexed policies at
 * `globalThis[Symbol.for("choco-pi.usage-limit-policy")]` as a
 * `Map<ownerSessionId, UsageLimitPolicy>`. This package may not import
 * repository-root modules, so the contract shapes are copied here with
 * identical names and every value crossing the seam is validated before use.
 * The manager only reads the slot; it never creates or mutates the map.
 */

import { Type } from "typebox";
import { Value } from "typebox/value";

export const USAGE_LIMIT_POLICY_SYMBOL = Symbol.for("choco-pi.usage-limit-policy");
export const SUBAGENTS_USAGE_LIMIT_EVENT = "subagents:usage_limit";

export type OnUsageLimit = "auto-resume" | "fallback" | "none";
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
   * Session the failure happened in. A child classification always carries
   * its own, so the owner's policy never enriches it from the root branch.
   */
  sessionId?: string;
};

export type UsageLimitClassifyInput = {
  provider: string;
  modelId: string;
  errorMessage: string;
};

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
  corroborate(
    classification: UsageLimitClassification,
  ): Promise<{ ready: boolean; classification: UsageLimitClassification }>;
  pickFallback(
    current: { provider: string; id: string },
    context: FallbackCandidateContext,
  ): { provider: string; id: string } | undefined;
  closeProvider(providerKey: string, accountId: string, untilMs: number): void;
  isClosed(providerKey: string, accountId: string, now?: number): boolean;
  /**
   * Optional: the account the owner currently uses for `provider`, the key
   * its own closures are written under. Absent means `"default"`.
   */
  accountId?(provider: string): string;
};

export type SubagentUsageLimit = {
  provider: string;
  accountId: string;
  kind: UsageLimitKind;
  resetAt?: number;
  suggestedModel?: string;
  status: "reported" | "waiting_for_reset" | "resumed" | "exhausted";
};

export type SubagentsUsageLimitEvent = {
  agentId: string;
  provider: string;
  resetAt?: number;
  status: SubagentUsageLimit["status"];
};

const OnUsageLimitSchema = Type.Union([
  Type.Literal("auto-resume"),
  Type.Literal("fallback"),
  Type.Literal("none"),
]);

const UsageLimitClassificationSchema = Type.Object({
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

const CorroborationSchema = Type.Object({
  ready: Type.Boolean(),
  classification: UsageLimitClassificationSchema,
  evidence: Type.Optional(
    Type.Union([Type.Literal("confirmed"), Type.Literal("capacity"), Type.Literal("unavailable")]),
  ),
});

const FallbackModelSchema = Type.Object({ provider: Type.String(), id: Type.String() });

/** Any value read from a process-global slot before validation. */
export type HostSlotValue = {} | null | undefined;

const StringSchema = Type.String();
const NumberSchema = Type.Number();
/** Every contract member, typed as unvalidated host data until checked. */
interface UsageLimitPolicyCandidate {
  owner?: HostSlotValue;
  generation?: HostSlotValue;
  preference?: HostSlotValue;
  classify?: HostSlotValue;
  corroborate?: HostSlotValue;
  pickFallback?: HostSlotValue;
  closeProvider?: HostSlotValue;
  isClosed?: HostSlotValue;
  accountId?: HostSlotValue;
}

interface UsageLimitPolicyRegistry {
  [USAGE_LIMIT_POLICY_SYMBOL]?: HostSlotValue;
}

/** Structural check matching the root contract's `isUsageLimitPolicy`. */
export function isUsageLimitPolicy(value: HostSlotValue): value is UsageLimitPolicy {
  if (!(value instanceof Object)) return false;
  // SAFETY: Every member of the candidate view is unvalidated host data; each is checked below.
  const candidate = value as UsageLimitPolicyCandidate;
  return (
    Value.Check(StringSchema, candidate.owner) &&
    Value.Check(NumberSchema, candidate.generation) &&
    candidate.preference instanceof Function &&
    candidate.classify instanceof Function &&
    candidate.corroborate instanceof Function &&
    candidate.pickFallback instanceof Function &&
    candidate.closeProvider instanceof Function &&
    candidate.isClosed instanceof Function &&
    (candidate.accountId === undefined || candidate.accountId instanceof Function)
  );
}

/**
 * Policy published by the root session `owner`, or undefined when the slot is
 * absent, malformed, or holds no valid entry for that owner. Never throws.
 */
export function readUsageLimitPolicy(owner: string | undefined): UsageLimitPolicy | undefined {
  if (owner === undefined) return undefined;
  try {
    // SAFETY: The symbol slot is read as unvalidated host data and checked before use.
    const registry = globalThis as typeof globalThis & UsageLimitPolicyRegistry;
    const slot = registry[USAGE_LIMIT_POLICY_SYMBOL];
    if (!(slot instanceof Map)) return undefined;
    const candidate: HostSlotValue = slot.get(owner);
    if (!isUsageLimitPolicy(candidate) || candidate.owner !== owner) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

/** Classify through the policy; malformed or throwing policies read as "not a limit". */
export function classifyWithPolicy(
  policy: UsageLimitPolicy,
  input: UsageLimitClassifyInput,
): UsageLimitClassification | undefined {
  try {
    const result: HostSlotValue = policy.classify(input);
    return Value.Check(UsageLimitClassificationSchema, result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bound on one asynchronous policy call. The manager awaits these while a
 * failed run still holds its pool slot, so a hung corroboration must not stall
 * settlement; a timeout reads as "no answer".
 */
export const POLICY_CALL_TIMEOUT_MS = 20_000;

class PolicyTimeoutError extends Error {
  constructor() {
    super(`Usage-limit policy did not answer within ${POLICY_CALL_TIMEOUT_MS} ms.`);
    this.name = "PolicyTimeoutError";
  }
}

function withinPolicyTimeout<Result>(call: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PolicyTimeoutError()), POLICY_CALL_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/** Preference with the contract default (`none`) for malformed or failing policies. */
export async function preferenceFromPolicy(policy: UsageLimitPolicy): Promise<OnUsageLimit> {
  try {
    const result: HostSlotValue = await withinPolicyTimeout(policy.preference());
    return Value.Check(OnUsageLimitSchema, result) ? result : "none";
  } catch {
    return "none";
  }
}

/**
 * Corroboration verdict: `confirmed` exhaustion, provider `capacity`, or
 * `unavailable` (no usable account data). Optional: policies predating the
 * field omit it, and the manager then derives a conservative verdict.
 */
export type CorroborationEvidence = "confirmed" | "capacity" | "unavailable";

export type Corroboration = {
  ready: boolean;
  classification: UsageLimitClassification;
  evidence?: CorroborationEvidence;
};

/** Corroboration result, or undefined when the policy fails or answers malformed data. */
export async function corroborateWithPolicy(
  policy: UsageLimitPolicy,
  classification: UsageLimitClassification,
): Promise<Corroboration | undefined> {
  try {
    const result: HostSlotValue = await withinPolicyTimeout(policy.corroborate(classification));
    return Value.Check(CorroborationSchema, result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback suggestion from the policy's tier table, validated structurally. */
export function pickFallbackWithPolicy(
  policy: UsageLimitPolicy,
  current: { provider: string; id: string },
  context: FallbackCandidateContext,
): { provider: string; id: string } | undefined {
  try {
    const result: HostSlotValue = policy.pickFallback(current, context);
    return Value.Check(FallbackModelSchema, result)
      ? { provider: result.provider, id: result.id }
      : undefined;
  } catch {
    return undefined;
  }
}

export function closeProviderWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
  accountId: string,
  untilMs: number,
): void {
  try {
    policy.closeProvider(providerKey, accountId, untilMs);
  } catch {
    /* The local provider-health closure still applies. */
  }
}

export function isClosedWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
  accountId: string,
): boolean {
  try {
    return policy.isClosed(providerKey, accountId) === true;
  } catch {
    return false;
  }
}

/**
 * The owner's current account for `providerKey`, or undefined when the policy
 * has no `accountId` method, throws, or answers anything but a non-empty string.
 * Callers then fall back to the last classified account, then `"default"`.
 */
export function accountIdWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
): string | undefined {
  if (policy.accountId === undefined) return undefined;
  try {
    const result: HostSlotValue = policy.accountId(providerKey);
    return Value.Check(StringSchema, result) && result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Structural copy of the root contract's `CodexUsageLimitEntry`: the Codex
 * provider appends it to the failing session's branch on its errored
 * `message_end`. `resetAt` and `observedAt` are epoch milliseconds.
 */
export const CODEX_USAGE_LIMIT_ENTRY = "choco-pi-codex-usage-limit";
export type CodexUsageLimitEntry = {
  resetAt?: number;
  planType?: string;
  accountId?: string;
  observedAt: number;
};
const CodexUsageLimitEntrySchema = Type.Object({
  resetAt: Type.Optional(Type.Number()),
  planType: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  observedAt: Type.Number(),
});
/** An entry further than this from the failure describes another failure. */
export const CODEX_ENTRY_WINDOW_MS = 60_000;

/** The branch-entry fields read here; every `SessionEntry` member satisfies it. */
export interface BranchEntryView {
  type: string;
  customType?: string;
  data?: HostSlotValue;
}

/**
 * Latest valid Codex usage-limit entry on `branch` observed within
 * `CODEX_ENTRY_WINDOW_MS` of `failedAt`, or undefined. Entries with a
 * non-finite timestamp or a reset earlier than their observation are rejected.
 */
export function latestCodexUsageLimitEntry(
  branch: readonly BranchEntryView[],
  failedAt: number,
): CodexUsageLimitEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "custom") continue;
    if (entry.customType !== CODEX_USAGE_LIMIT_ENTRY) continue;
    const data = entry.data;
    if (!Value.Check(CodexUsageLimitEntrySchema, data)) continue;
    if (!Number.isFinite(data.observedAt)) continue;
    if (Math.abs(failedAt - data.observedAt) > CODEX_ENTRY_WINDOW_MS) continue;
    if (
      data.resetAt !== undefined &&
      (!Number.isFinite(data.resetAt) || data.resetAt < data.observedAt)
    ) {
      continue;
    }
    const parsed: CodexUsageLimitEntry = { observedAt: data.observedAt };
    if (data.resetAt !== undefined) parsed.resetAt = data.resetAt;
    if (data.planType !== undefined) parsed.planType = data.planType;
    if (data.accountId !== undefined && data.accountId.length > 0) {
      parsed.accountId = data.accountId;
    }
    return parsed;
  }
  return undefined;
}

/** ISO-8601 rendering used by every user- and model-facing reset estimate. */
export function formatResetAt(resetAt: number | undefined): string {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return "unknown";
  return new Date(resetAt).toISOString();
}

/** One-line description of a usage-limit block for error text and notifications. */
export function describeUsageLimit(limit: SubagentUsageLimit): string {
  return (
    `${limit.provider} usage limit (${limit.kind}); resets ~${formatResetAt(limit.resetAt)}; ` +
    `suggested model: ${limit.suggestedModel ?? "none available"}; status: ${limit.status}`
  );
}
