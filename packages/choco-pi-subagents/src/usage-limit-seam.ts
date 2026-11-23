import { arr, bool, compile, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { formatProviderLabel } from "../../choco-pi-ui/extensions/zentui/model-display.ts";
import { finiteNum, isFiniteNumber, isString } from "./value-guards.ts";

export const USAGE_LIMIT_POLICY_SYMBOL = Symbol.for("choco-pi.usage-limit-policy");
export const SUBAGENTS_USAGE_LIMIT_EVENT = "subagents:usage_limit";

export type OnUsageLimit = "auto-resume" | "fallback" | "none";
export type UsageLimitKind = "quota" | "billing" | "transient";
export type UsageLimitConfidence = "structured" | "parsed" | "inferred";

export type UsageLimitScope = {
  name: string;
  models: string[];
  exact?: boolean;
};

const UsageLimitScopeSchema = obj(
  { name: str(), models: arr(str()), exact: opt(bool()) },
  { open: true },
);
const isUsageLimitScope = compile(UsageLimitScopeSchema).check;

export function scopeCoversModel(scope: UsageLimitScope | undefined, modelId: string): boolean {
  if (scope === undefined) return true;
  if (scope.exact === true) return scope.models.includes(modelId);
  return scope.models.some((stem) => modelId === stem || modelId.startsWith(`${stem}-`));
}

export function scopeKey(scope: UsageLimitScope | undefined): string {
  if (scope === undefined) return "";
  const kind = scope.exact === true ? "=" : "*";
  return `${scope.name}\u0001${kind}\u0001${[...scope.models].sort().join("\u0001")}`;
}

export function scopeNote(scope: UsageLimitScope | undefined): string {
  if (scope === undefined || scope.models.length === 0) return "";
  const suffix = scope.exact === true ? "" : "*";
  const models = scope.models.map((stem) => `${stem}${suffix}`).join(", ");
  return ` (${models} only; other models stay available)`;
}

export function usageLimitScopeOf(value: HostSlotValue): UsageLimitScope | undefined {
  if (!isUsageLimitScope(value)) return undefined;
  const scope: UsageLimitScope = { name: value.name, models: [...value.models] };
  if (value.exact === true) scope.exact = true;
  return scope;
}

export const UNCONFIRMED_SCOPE_NAME = "unconfirmed";

export function closureScopeFor(
  classification: UsageLimitClassification,
  confirmed: boolean,
): UsageLimitScope | undefined {
  if (classification.scope !== undefined) return classification.scope;
  if (confirmed || classification.kind !== "quota") return undefined;
  return { name: UNCONFIRMED_SCOPE_NAME, models: [classification.modelId], exact: true };
}

export type UsageLimitClassification = {
  kind: UsageLimitKind;
  provider: string;
  modelId: string;
  accountId?: string;
  resetAt?: number;
  confidence: UsageLimitConfidence;
  sessionId?: string;
  scope?: UsageLimitScope;
};

export type UsageLimitClassifyInput = {
  provider: string;
  modelId: string;
  errorMessage: string;
};

export type FallbackCandidateContext = {
  available: readonly { provider: string; id: string }[];
  scoped: readonly string[];
  isClosed(providerKey: string, accountId: string, modelId?: string): boolean;
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
  closeProvider(
    providerKey: string,
    accountId: string,
    untilMs: number,
    scope?: UsageLimitScope,
  ): void;
  isClosed(providerKey: string, accountId: string, now?: number, modelId?: string): boolean;
  recheck?(
    providerKey: string,
    accountId: string,
    since?: number,
    modelId?: string,
  ): Promise<UsageLimitRecheck>;
  reopen?(providerKey: string, accountId: string, at?: number, modelId?: string): void;
  accountId?(provider: string): string;
};

export type UsageLimitRecheck = {
  open: boolean;
  until?: number;
  detail?: string;
  scope?: UsageLimitScope;
  inForce?: UsageLimitClosureState[];
};

export type UsageLimitClosureState = {
  scope?: UsageLimitScope;
  until?: number;
};

export type SubagentUsageLimit = {
  provider: string;
  accountId: string;
  kind: UsageLimitKind;
  resetAt?: number;
  suggestedModel?: string;
  status: "reported" | "waiting_for_reset" | "resumed" | "exhausted";
  scope?: UsageLimitScope;
};

export type SubagentsUsageLimitEvent = {
  agentId: string;
  provider: string;
  resetAt?: number;
  status: SubagentUsageLimit["status"];
};

const isOnUsageLimit = compile(oneOf(["auto-resume", "fallback", "none"])).check;

const UsageLimitClassificationSchema = obj(
  {
    kind: oneOf(["quota", "billing", "transient"]),
    provider: str(),
    modelId: str(),
    accountId: opt(str()),
    resetAt: opt(finiteNum()),
    confidence: oneOf(["structured", "parsed", "inferred"]),
    sessionId: opt(str()),
    scope: opt(UsageLimitScopeSchema),
  },
  { open: true },
);
const isUsageLimitClassification = compile(UsageLimitClassificationSchema).check;

const isCorroboration = compile(
  obj(
    {
      ready: bool(),
      classification: UsageLimitClassificationSchema,
      evidence: opt(oneOf(["confirmed", "capacity", "unavailable"])),
    },
    { open: true },
  ),
).check;

const isFallbackModel = compile(obj({ provider: str(), id: str() }, { open: true })).check;

const isRecheck = compile(
  obj(
    {
      open: bool(),
      until: opt(finiteNum()),
      detail: opt(str()),
      scope: opt(UsageLimitScopeSchema),
      inForce: opt(
        arr(obj({ scope: opt(UsageLimitScopeSchema), until: opt(finiteNum()) }, { open: true })),
      ),
    },
    { open: true },
  ),
).check;

export type HostSlotValue = {} | null | undefined;

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
  recheck?: HostSlotValue;
  reopen?: HostSlotValue;
}

interface UsageLimitPolicyRegistry {
  [USAGE_LIMIT_POLICY_SYMBOL]?: HostSlotValue;
}

export function isUsageLimitPolicy(value: HostSlotValue): value is UsageLimitPolicy {
  if (!(value instanceof Object)) return false;
  // SAFETY: Every member of the candidate view is unvalidated host data; each is checked below.
  const candidate = value as UsageLimitPolicyCandidate;
  return (
    isString(candidate.owner) &&
    isFiniteNumber(candidate.generation) &&
    candidate.preference instanceof Function &&
    candidate.classify instanceof Function &&
    candidate.corroborate instanceof Function &&
    candidate.pickFallback instanceof Function &&
    candidate.closeProvider instanceof Function &&
    candidate.isClosed instanceof Function &&
    (candidate.accountId === undefined || candidate.accountId instanceof Function) &&
    (candidate.recheck === undefined || candidate.recheck instanceof Function) &&
    (candidate.reopen === undefined || candidate.reopen instanceof Function)
  );
}

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

export function classifyWithPolicy(
  policy: UsageLimitPolicy,
  input: UsageLimitClassifyInput,
): UsageLimitClassification | undefined {
  try {
    const result: HostSlotValue = policy.classify(input);
    return isUsageLimitClassification(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

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

export async function preferenceFromPolicy(policy: UsageLimitPolicy): Promise<OnUsageLimit> {
  try {
    const result: HostSlotValue = await withinPolicyTimeout(policy.preference());
    return isOnUsageLimit(result) ? result : "none";
  } catch {
    return "none";
  }
}

export type CorroborationEvidence = "confirmed" | "capacity" | "unavailable";

export type Corroboration = {
  ready: boolean;
  classification: UsageLimitClassification;
  evidence?: CorroborationEvidence;
};

export async function corroborateWithPolicy(
  policy: UsageLimitPolicy,
  classification: UsageLimitClassification,
): Promise<Corroboration | undefined> {
  try {
    const result: HostSlotValue = await withinPolicyTimeout(policy.corroborate(classification));
    return isCorroboration(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

export function pickFallbackWithPolicy(
  policy: UsageLimitPolicy,
  current: { provider: string; id: string },
  context: FallbackCandidateContext,
): { provider: string; id: string } | undefined {
  try {
    const result: HostSlotValue = policy.pickFallback(current, context);
    return isFallbackModel(result) ? { provider: result.provider, id: result.id } : undefined;
  } catch {
    return undefined;
  }
}

export function closeProviderWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
  accountId: string,
  untilMs: number,
  scope?: UsageLimitScope,
): void {
  try {
    if (scope === undefined) policy.closeProvider(providerKey, accountId, untilMs);
    else policy.closeProvider(providerKey, accountId, untilMs, scope);
  } catch {}
}

export function isClosedWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
  accountId: string,
  modelId?: string,
): boolean {
  try {
    const closed: HostSlotValue =
      modelId === undefined
        ? policy.isClosed(providerKey, accountId)
        : policy.isClosed(providerKey, accountId, undefined, modelId);
    return closed === true;
  } catch {
    return false;
  }
}

export async function recheckWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
  accountId: string,
  since: number | undefined,
  modelId?: string,
): Promise<UsageLimitRecheck | undefined> {
  if (policy.recheck === undefined) return undefined;
  try {
    const result: HostSlotValue = await withinPolicyTimeout(
      modelId === undefined
        ? policy.recheck(providerKey, accountId, since)
        : policy.recheck(providerKey, accountId, since, modelId),
    );
    if (!isRecheck(result)) return undefined;
    const answer: UsageLimitRecheck = { open: result.open };
    if (result.until !== undefined) answer.until = result.until;
    if (result.detail !== undefined) answer.detail = result.detail;
    const scope = usageLimitScopeOf(result.scope);
    if (scope !== undefined) answer.scope = scope;
    if (result.inForce !== undefined) {
      answer.inForce = result.inForce.map((entry) => {
        const state: UsageLimitClosureState = {};
        const entryScope = usageLimitScopeOf(entry.scope);
        if (entryScope !== undefined) state.scope = entryScope;
        if (entry.until !== undefined) state.until = entry.until;
        return state;
      });
    }
    return answer;
  } catch {
    return undefined;
  }
}

export function reopenWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
  accountId: string,
  at: number,
  modelId?: string,
): void {
  if (policy.reopen === undefined) return;
  try {
    if (modelId === undefined) policy.reopen(providerKey, accountId, at);
    else policy.reopen(providerKey, accountId, at, modelId);
  } catch {}
}

export function accountIdWithPolicy(
  policy: UsageLimitPolicy,
  providerKey: string,
): string | undefined {
  if (policy.accountId === undefined) return undefined;
  try {
    const result: HostSlotValue = policy.accountId(providerKey);
    return isString(result) && result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

export const CODEX_USAGE_LIMIT_ENTRY = "choco-pi-codex-usage-limit";
export type CodexUsageLimitEntry = {
  resetAt?: number;
  planType?: string;
  accountId?: string;
  observedAt: number;
};
const isCodexUsageLimitEntry = compile(
  obj(
    {
      resetAt: opt(finiteNum()),
      planType: opt(str()),
      accountId: opt(str()),
      observedAt: finiteNum(),
    },
    { open: true },
  ),
).check;
export const CODEX_ENTRY_WINDOW_MS = 60_000;

export interface BranchEntryView {
  type: string;
  customType?: string;
  data?: HostSlotValue;
}

export function latestCodexUsageLimitEntry(
  branch: readonly BranchEntryView[],
  failedAt: number,
): CodexUsageLimitEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "custom") continue;
    if (entry.customType !== CODEX_USAGE_LIMIT_ENTRY) continue;
    const data = entry.data;
    if (!isCodexUsageLimitEntry(data)) continue;
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

export function formatResetAt(resetAt: number | undefined): string {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return "unknown";
  return new Date(resetAt).toISOString();
}

export function describeUsageLimit(limit: SubagentUsageLimit): string {
  return (
    `${formatProviderLabel(limit.provider)} usage limit (${limit.kind})${scopeNote(limit.scope)}; resets ~${formatResetAt(limit.resetAt)}; ` +
    `suggested model: ${limit.suggestedModel ?? "none available"}; status: ${limit.status}`
  );
}
