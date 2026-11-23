import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { checkModelScope } from "../model-scope.ts";
import {
  blockingUsageLimitClosure,
  clearUsageLimitClosure,
  closeUntil,
  isAvailable,
  providerUnavailableMessage,
  usageLimitClosuresFor,
  type UsageLimitClosureKey,
} from "../provider-health.ts";
import type { AgentRecord, SubagentUsageLimit } from "../types.ts";
import {
  classifyWithPolicy,
  closeProviderWithPolicy,
  closureScopeFor,
  corroborateWithPolicy,
  isClosedWithPolicy,
  pickFallbackWithPolicy,
  preferenceFromPolicy,
  readUsageLimitPolicy,
  scopeKey,
  type UsageLimitClassification,
  type UsageLimitPolicy,
} from "../usage-limit-seam.ts";
import {
  USAGE_LIMIT_RESET_MARGIN_MS,
  USAGE_LIMIT_MAX_WAIT_MS,
  USAGE_LIMIT_POLL_MS,
  USAGE_LIMIT_MAX_POLL_MS,
  USAGE_LIMIT_DEFAULT_CLOSE_MS,
  REARM_POLICY_RETRY_MS,
  REARM_POLICY_POLL_MS,
  USAGE_LIMIT_RESUME_PROMPT,
  type ModelRef,
  type UsageLimitScope,
  type UsageLimitDecision,
  type UsageWait,
  type UsageLimitListener,
  corroborationVerdict,
  accountKey,
  withCodexUsageEntry,
  childSessionId,
  withSessionId,
  type RunBudgetState,
  type CancellationCause,
  type ResumeOptions,
  type ManagerState,
  transition,
  publishTerminal,
} from "./state.ts";
import { finishDeferredWorktreeThen } from "./worktree-lifecycle.ts";
import { accountFor, providerBlock } from "./provider-recheck.ts";
import { scheduleJournal } from "./revival-journal.ts";
import { stopQueuedRecord, queueBackgroundResume } from "./admission-queue.ts";

export function setUsageLimitListener(
  mgr: ManagerState,
  listener: UsageLimitListener | undefined,
): void {
  mgr.usageLimitListener = listener;
}

export function notifyUsageLimit(mgr: ManagerState, record: AgentRecord): void {
  if (mgr.disposed || record.usageLimit === undefined) return;
  try {
    mgr.usageLimitListener?.(record);
  } catch {}
}

export async function evaluateUsageLimit(
  mgr: ManagerState,
  record: AgentRecord,
  failure: string,
  providerKey: string,
  model: ModelRef,
  session: AgentSession | undefined,
  allowPark: boolean,
  reportStatus: "reported" | "exhausted",
  eligible: () => boolean,
): Promise<UsageLimitDecision | undefined> {
  const failedAt = Date.now();
  const scope = mgr.usageScopes.get(record.id);
  const owner = scope?.owner;
  const policy = readUsageLimitPolicy(owner);
  if (scope === undefined || owner === undefined || policy === undefined) return undefined;
  const classified = classifyWithPolicy(policy, {
    provider: model.provider,
    modelId: model.id,
    errorMessage: failure,
  });
  if (classified === undefined || classified.kind === "transient") return undefined;
  const sessionId = childSessionId(record, session);
  const initial = withSessionId(
    withCodexUsageEntry(classified, model, session, failedAt, failure),
    sessionId,
  );
  const preference = await preferenceFromPolicy(policy);
  if (!eligible()) return undefined;
  const corroboration = await corroborateWithPolicy(policy, initial);
  if (!eligible()) return undefined;
  const verdict = corroborationVerdict(initial, corroboration);
  if (verdict === "transient") return undefined;
  const corroborated = withSessionId(corroboration?.classification ?? initial, sessionId);
  const billed: UsageLimitClassification =
    initial.kind === "billing" ? { ...corroborated, kind: "billing" } : corroborated;
  const limitScope = closureScopeFor(billed, verdict === "confirmed");
  const classification: UsageLimitClassification =
    limitScope === undefined ? billed : { ...billed, scope: limitScope };

  const limitedAccount = classification.accountId;
  if (limitedAccount !== undefined) {
    mgr.classifiedAccounts.set(accountKey(owner, providerKey.toLowerCase()), limitedAccount);
  }
  const accountId = accountFor(mgr, owner, providerKey, policy);
  const accountIds =
    limitedAccount === undefined || limitedAccount === accountId
      ? [accountId]
      : [accountId, limitedAccount];
  const now = Date.now();
  const resetAt =
    classification.resetAt !== undefined && Number.isFinite(classification.resetAt)
      ? classification.resetAt
      : undefined;
  const requestedUntil =
    resetAt !== undefined && resetAt > now ? resetAt : now + USAGE_LIMIT_DEFAULT_CLOSE_MS;
  for (const account of accountIds) {
    closeProviderWithPolicy(
      policy,
      providerKey,
      account,
      Math.min(requestedUntil, now + USAGE_LIMIT_MAX_WAIT_MS),
      limitScope,
    );
  }
  const suggestedModel = suggestFallback(mgr, policy, scope, owner, model, record);
  for (const account of accountIds) {
    const key: UsageLimitClosureKey = { owner, providerKey, accountId: account };
    if (limitScope !== undefined) key.scope = limitScope;
    closeUntil(key, requestedUntil, { suggestedModel });
  }
  const park =
    allowPark &&
    preference === "auto-resume" &&
    classification.kind === "quota" &&
    verdict === "confirmed";
  return {
    classification,
    accountIds,
    park,
    usageLimit: {
      provider: model.provider,
      accountId: limitedAccount ?? accountId,
      kind: classification.kind,
      resetAt,
      suggestedModel,
      status: park ? "waiting_for_reset" : reportStatus,
      ...(limitScope !== undefined && { scope: limitScope }),
    },
  };
}

export function suggestFallback(
  mgr: ManagerState,
  policy: UsageLimitPolicy,
  scope: UsageLimitScope,
  owner: string,
  current: ModelRef,
  record: AgentRecord,
): string | undefined {
  const registry = scope.modelRegistry;
  let available: ModelRef[] = [];
  try {
    available = (registry?.getAvailable?.() ?? []).map((entry) => ({
      provider: entry.provider,
      id: entry.id,
    }));
  } catch {
    available = [];
  }
  const pick = pickFallbackWithPolicy(policy, current, {
    available,
    scoped: scope.scoped,
    isClosed: (providerKey, accountId, modelId) => {
      const key = providerKey.toLowerCase();
      return (
        isClosedWithPolicy(policy, key, accountId, modelId) ||
        blockingUsageLimitClosure({ owner, providerKey: key, accountId }, modelId) !== undefined ||
        !isAvailable(key, undefined, modelId)
      );
    },
  });
  if (pick === undefined) return undefined;
  const key = `${pick.provider}/${pick.id}`;
  const lowered = key.toLowerCase();
  if (lowered === `${current.provider}/${current.id}`.toLowerCase()) return undefined;
  if (!available.some((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === lowered)) {
    return undefined;
  }
  if (scope.scoped.length > 0 && !scope.scoped.some((entry) => entry.toLowerCase() === lowered)) {
    return undefined;
  }
  if (registry !== undefined) {
    const verdict = checkModelScope({
      model: pick,
      cwd: scope.cwd,
      modelRegistry: registry,
      callerSupplied: true,
      agentLabel: record.type,
      modelInput: key,
    });
    if (verdict.kind === "error") return undefined;
  }
  return key;
}

export function usageEvaluationEligible(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  runBudget: RunBudgetState,
): boolean {
  return (
    !mgr.disposed &&
    record.resultGeneration === generation &&
    record.status !== "stopped" &&
    record.cancellation?.generation !== generation &&
    runBudget.forcedStatus === undefined
  );
}

export async function evaluateRunUsageLimit(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  runBudget: RunBudgetState,
  failure: string | undefined,
  providerKey: string,
  model: ModelRef | undefined,
  session: AgentSession | undefined,
  allowPark: boolean,
  reportStatus: "reported" | "exhausted",
): Promise<UsageLimitDecision | undefined> {
  const eligible = () => usageEvaluationEligible(mgr, record, generation, runBudget);
  if (failure === undefined || model === undefined || !eligible()) return undefined;
  let decision: UsageLimitDecision | undefined;
  try {
    decision = await evaluateUsageLimit(
      mgr,
      record,
      failure,
      providerKey,
      model,
      session,
      allowPark,
      reportStatus,
      eligible,
    );
  } catch {
    decision = undefined;
  }
  return decision !== undefined && eligible() ? decision : undefined;
}

export function currentUsageDecision(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  runBudget: RunBudgetState,
  decision: UsageLimitDecision | undefined,
): UsageLimitDecision | undefined {
  return decision !== undefined && usageEvaluationEligible(mgr, record, generation, runBudget)
    ? decision
    : undefined;
}

export function parkForReset(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  decision: UsageLimitDecision,
  providerKey: string,
  resumeOptions: ResumeOptions,
): void {
  const owner = mgr.usageScopes.get(record.id)?.owner ?? "";
  let release: (value: string | PromiseLike<string>) => void = () => undefined;
  const parkedPromise = new Promise<string>((resolve) => {
    release = resolve;
  });
  transition(mgr, record, "waiting_for_reset");
  record.isBackground = true;
  record.usageLimit = { ...decision.usageLimit, status: "waiting_for_reset" };
  record.promise = parkedPromise;
  const wait: UsageWait = {
    generation,
    owner,
    providerKey,
    accountIds: decision.accountIds,
    classification: decision.classification,
    resumeOptions,
    continuation: [],
    parkedPromise,
    release,
  };
  mgr.usageWaits.set(record.id, wait);
  notifyUsageLimit(mgr, record);
  armUsageWake(mgr, record, wait, decision.usageLimit.resetAt);
}

export function isCurrentWait(
  mgr: ManagerState,
  record: AgentRecord | undefined,
  wait: UsageWait,
): record is AgentRecord {
  return (
    !mgr.disposed &&
    record !== undefined &&
    mgr.usageWaits.get(record.id) === wait &&
    record.status === "waiting_for_reset" &&
    record.resultGeneration === wait.generation
  );
}

export function armUsageWake(
  mgr: ManagerState,
  record: AgentRecord,
  wait: UsageWait,
  resetAt: number | undefined,
): void {
  const now = Date.now();
  let delay: number;
  if (resetAt !== undefined && resetAt + USAGE_LIMIT_RESET_MARGIN_MS > now) {
    wait.pollUntil = undefined;
    delay = Math.min(resetAt + USAGE_LIMIT_RESET_MARGIN_MS, now + USAGE_LIMIT_MAX_WAIT_MS) - now;
  } else {
    wait.pollUntil ??= now + USAGE_LIMIT_MAX_POLL_MS;
    if (now >= wait.pollUntil) {
      settleParked(mgr, record, wait, {
        status: "error",
        usageStatus: "exhausted",
        reason: `${record.error ?? "Provider usage limit."}\n\nAuto-resume gave up: no usage-window reset was confirmed within ${USAGE_LIMIT_MAX_POLL_MS / 3_600_000} h.`,
        notify: true,
      });
      return;
    }
    delay = Math.min(USAGE_LIMIT_POLL_MS, wait.pollUntil - now);
  }
  armWakeTimer(mgr, record, wait, delay);
}

export function armWakeTimer(
  mgr: ManagerState,
  record: AgentRecord,
  wait: UsageWait,
  delay: number,
): void {
  if (wait.timer !== undefined) clearTimeout(wait.timer);
  wait.timer = setTimeout(() => {
    wait.timer = undefined;
    void wakeUsageLimited(mgr, record.id, wait);
  }, delay);
  wait.timer.unref?.();
}

export async function wakeUsageLimited(
  mgr: ManagerState,
  id: string,
  wait: UsageWait,
): Promise<void> {
  const record = mgr.agents.get(id);
  if (!isCurrentWait(mgr, record, wait)) return;
  const policy = readUsageLimitPolicy(wait.owner);
  if (policy === undefined && wait.revived === true) {
    const now = Date.now();
    wait.policyRetryUntil ??= now + REARM_POLICY_RETRY_MS;
    if (now < wait.policyRetryUntil) {
      armWakeTimer(mgr, record, wait, Math.min(REARM_POLICY_POLL_MS, wait.policyRetryUntil - now));
      return;
    }
  }
  if (policy === undefined) {
    settleParked(mgr, record, wait, {
      status: "error",
      usageStatus: "exhausted",
      reason: `${record.error ?? "Provider usage limit."}\n\nAuto-resume gave up: the usage-limit policy is no longer available to confirm the reset.`,
      notify: true,
    });
    return;
  }
  const result = await corroborateWithPolicy(policy, wait.classification);
  const current = mgr.agents.get(id);
  if (current !== record || !isCurrentWait(mgr, current, wait)) return;
  if (result?.ready === true) {
    resumeAfterReset(mgr, record, wait);
    return;
  }
  let nextReset: number | undefined;
  if (result !== undefined && result.classification.kind !== "transient") {
    wait.classification = withSessionId(result.classification, wait.classification.sessionId);
    nextReset = result.classification.resetAt;
    if (record.usageLimit !== undefined) {
      record.usageLimit = { ...record.usageLimit, resetAt: nextReset };
    }
    scheduleJournal(mgr, record);
  }
  armUsageWake(mgr, record, wait, nextReset);
}

export function resumeAfterReset(mgr: ManagerState, record: AgentRecord, wait: UsageWait): void {
  mgr.usageWaits.delete(record.id);
  const policy = readUsageLimitPolicy(wait.owner);
  const modelId = wait.classification.modelId;
  for (const accountId of wait.accountIds) {
    const account = { owner: wait.owner, providerKey: wait.providerKey, accountId };
    const scopes = new Map<string, UsageLimitClosureKey["scope"]>([["", undefined]]);
    for (const entry of usageLimitClosuresFor(account, modelId)) {
      scopes.set(scopeKey(entry.key.scope), entry.key.scope);
      clearUsageLimitClosure(entry.key);
    }
    const waitScope = wait.classification.scope;
    if (waitScope !== undefined) scopes.set(scopeKey(waitScope), waitScope);
    if (policy !== undefined) {
      for (const scope of scopes.values()) {
        closeProviderWithPolicy(policy, wait.providerKey, accountId, Date.now(), scope);
      }
    }
  }
  wait.continuation = [...wait.continuation, ...(record.pendingSteers ?? [])];
  record.pendingSteers = undefined;
  const prompt = [USAGE_LIMIT_RESUME_PROMPT, ...wait.continuation].join("\n\n");
  if (record.usageLimit !== undefined) {
    record.usageLimit = { ...record.usageLimit, status: "resumed" };
  }
  const generation = (record.resultGeneration ?? 1) + 1;
  mgr.wakeRuns.set(record.id, generation);
  queueBackgroundResume(mgr, record.id, record, prompt, undefined, wait.resumeOptions, {
    onRunStarted: (promise) => {
      wait.continuation = [];
      if (promise !== wait.parkedPromise) wait.release(promise);
    },
    finalize: (notify) => settleDroppedWake(mgr, record, wait, generation, notify),
    repark: () => reparkQueuedWake(mgr, record, wait, generation),
    wait,
  });
  notifyUsageLimit(mgr, record);
}

export function reparkQueuedWake(
  mgr: ManagerState,
  record: AgentRecord,
  wait: UsageWait,
  generation: number,
): void {
  if (mgr.wakeRuns.get(record.id) === generation) mgr.wakeRuns.delete(record.id);
  const key = wait.providerKey.toLowerCase();
  const modelId = wait.classification.modelId;
  const block = providerBlock(mgr, key, wait.owner, modelId);
  const resetAt = block?.closure?.until;
  const account = accountFor(mgr, wait.owner, key);
  if (!wait.accountIds.includes(account)) wait.accountIds.push(account);
  wait.generation = record.resultGeneration ?? generation;
  wait.pollUntil = undefined;
  if (resetAt !== undefined) wait.classification = { ...wait.classification, resetAt };
  transition(mgr, record, "waiting_for_reset");
  record.error = providerUnavailableMessage(key, block?.closure, modelId, block?.modelOnly);
  record.usageLimit =
    record.usageLimit === undefined
      ? undefined
      : {
          ...record.usageLimit,
          resetAt: resetAt ?? record.usageLimit.resetAt,
          status: "waiting_for_reset",
        };
  mgr.usageWaits.set(record.id, wait);
  notifyUsageLimit(mgr, record);
  armUsageWake(mgr, record, wait, resetAt);
}

export function settleDroppedWake(
  mgr: ManagerState,
  record: AgentRecord,
  wait: UsageWait,
  generation: number,
  notify: boolean,
): void {
  if (mgr.wakeRuns.get(record.id) === generation) mgr.wakeRuns.delete(record.id);
  record.error ??= record.cancellation?.reason;
  if (record.usageLimit !== undefined) {
    record.usageLimit = { ...record.usageLimit, status: "exhausted" };
  }
  finishDeferredWorktreeThen(mgr, record, () => {
    publishTerminal(mgr, record);
    wait.release(record.result ?? "");
    if (!notify || mgr.disposed) return;
    notifyUsageLimit(mgr, record);
    try {
      mgr.onComplete?.(record);
    } catch {}
  });
}

export function settleParked(
  mgr: ManagerState,
  record: AgentRecord,
  wait: UsageWait | undefined,
  outcome: {
    status: "stopped" | "error";
    usageStatus?: SubagentUsageLimit["status"];
    reason: string;
    cause?: CancellationCause;
    notify: boolean;
  },
): void {
  if (wait !== undefined) {
    if (wait.timer !== undefined) clearTimeout(wait.timer);
    wait.timer = undefined;
  }
  mgr.usageWaits.delete(record.id);
  const generation = record.resultGeneration ?? 1;
  transition(mgr, record, outcome.status);
  if (outcome.cause !== undefined) {
    record.cancellation = {
      generation,
      cause: outcome.cause,
      reason: outcome.reason,
      requestedAt: Date.now(),
    };
  }
  record.error = outcome.reason;
  record.pendingSteers = undefined;
  if (record.usageLimit !== undefined && outcome.usageStatus !== undefined) {
    record.usageLimit = { ...record.usageLimit, status: outcome.usageStatus };
  }
  record.completedAt = Date.now();
  if (record.outputCleanup) {
    try {
      record.outputCleanup();
    } catch {}
    record.outputCleanup = undefined;
  }
  finishDeferredWorktreeThen(mgr, record, () => {
    publishTerminal(mgr, record);
    wait?.release(record.result ?? "");
    if (!outcome.notify || mgr.disposed) return;
    notifyUsageLimit(mgr, record);
    try {
      mgr.onComplete?.(record);
    } catch {}
  });
}

export function cancelUsageLimitWaits(mgr: ManagerState, reason: string): number {
  let count = 0;
  for (const record of mgr.agents.values()) {
    if (record.status !== "waiting_for_reset") continue;
    settleParked(mgr, record, mgr.usageWaits.get(record.id), {
      status: "stopped",
      usageStatus: "exhausted",
      reason,
      cause: "shutdown",
      notify: false,
    });
    count++;
  }
  const continuations = mgr.queue.filter((entry) => entry.finalize !== undefined);
  mgr.queue = mgr.queue.filter((entry) => entry.finalize === undefined);
  for (const entry of continuations) {
    const record = mgr.agents.get(entry.id);
    if (record === undefined || record.status !== "queued") continue;
    stopQueuedRecord(mgr, record, "shutdown", reason);
    entry.finalize?.(false);
    count++;
  }
  return count;
}
