/**
 * provider-recheck.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  blockingUsageLimitClosure,
  clearUsageLimitClosure,
  confirmUsageLimitClosure,
  transientBlockLevel,
  ProviderUnavailableError,
  providerUnavailableMessage,
  usageLimitClosuresFor,
  type UsageLimitClosure,
  type UsageLimitClosureKey,
} from "../provider-health.ts";
import {
  accountIdWithPolicy,
  isClosedWithPolicy,
  readUsageLimitPolicy,
  recheckWithPolicy,
  reopenWithPolicy,
  scopeKey,
  type UsageLimitPolicy,
} from "../usage-limit-seam.ts";
import {
  type UsageModelRegistry,
  type UsageLimitScope,
  scopedModelKeys,
  accountKey,
  sessionRootOf,
  providerKeyFor,
  modelIdFor,
  closuresRewritten,
  type SpawnOptions,
  type ManagerState,
} from "./state.ts";
import { getDormant } from "./revival-journal.ts";

/**
 * Whether `owner` may run `modelId` on `providerKey`. Without `modelId`
 * only provider-wide closures count; a model-scoped closure (such as the
 * Fable limit) blocks only the models it covers.
 */
export function isProviderAvailable(
  mgr: ManagerState,
  providerKey: string,
  owner?: string,
  modelId?: string,
): boolean {
  return providerBlock(mgr, providerKey, owner, modelId) === undefined;
}

/** Refusal text for `modelId` on `providerKey` under `owner`, with any usage-limit details. */
export function managerProviderUnavailableMessage(
  mgr: ManagerState,
  providerKey: string,
  owner?: string,
  modelId?: string,
): string {
  const key = providerKey.toLowerCase();
  const block = providerBlock(mgr, key, owner, modelId);
  return providerUnavailableMessage(key, block?.closure, modelId, block?.modelOnly);
}

export function unavailableError(
  mgr: ManagerState,
  providerKey: string,
  owner: string | undefined,
  modelId: string | undefined,
): Error {
  const key = providerKey.toLowerCase();
  const block = providerBlock(mgr, key, owner, modelId);
  return new ProviderUnavailableError(key, block?.closure, modelId, block?.modelOnly);
}

/**
 * Re-check `owner`'s usage-limit closures that block `modelId` on
 * `providerKey` against live evidence, for callers about to run a
 * synchronous availability gate. A
 * closure is reopened when the owner's policy finds the limit gone (a later
 * success, a reading showing capacity, or no live reading at all) and keeps
 * the policy's reset and reason otherwise. Concurrent callers share one
 * check. A policy without `recheck`, a failed check, or a closure written
 * during the check leaves the stored state. Never rejects.
 */
export async function refreshProviderBlock(
  mgr: ManagerState,
  providerKey: string,
  owner: string | undefined,
  modelId?: string,
): Promise<void> {
  await closureRecheck(mgr, providerKey, owner, modelId);
}

/**
 * The shared re-check for `refreshProviderBlock`, or undefined (decided
 * synchronously) when no usage-limit closure blocks, so callers whose
 * ordering is synchronous only yield when there is something to check.
 */
export function closureRecheck(
  mgr: ManagerState,
  providerKey: string,
  owner: string | undefined,
  modelId: string | undefined,
): Promise<void> | undefined {
  if (owner === undefined || mgr.disposed) return undefined;
  const key = providerKey.toLowerCase();
  if (providerBlock(mgr, key, owner, modelId)?.usage !== true) return undefined;
  const policy = readUsageLimitPolicy(owner);
  if (policy?.recheck === undefined) return undefined;
  const accountId = accountFor(mgr, owner, key, policy);
  const id = `${owner}\u0000${key}\u0000${accountId}\u0000${modelId ?? ""}`;
  const existing = mgr.closureRechecks.get(id);
  if (existing !== undefined) return existing;
  const recheck = recheckClosure(
    mgr,
    policy,
    { owner, providerKey: key, accountId },
    modelId,
  ).finally(() => {
    if (mgr.closureRechecks.get(id) === recheck) mgr.closureRechecks.delete(id);
  });
  mgr.closureRechecks.set(id, recheck);
  return recheck;
}

export async function recheckClosure(
  mgr: ManagerState,
  policy: UsageLimitPolicy,
  key: { owner: string; providerKey: string; accountId: string },
  modelId: string | undefined,
): Promise<void> {
  const before = usageLimitClosuresFor(key, modelId);
  // Evidence must postdate the newest of the closures being checked.
  let since: number | undefined;
  for (const { closure } of before) {
    if (closure.closedAt !== undefined && (since === undefined || closure.closedAt > since)) {
      since = closure.closedAt;
    }
  }
  const result = await recheckWithPolicy(policy, key.providerKey, key.accountId, since, modelId);
  if (mgr.disposed || readUsageLimitPolicy(key.owner) !== policy || result === undefined) return;
  // A failure that closed the account during the check is newer evidence.
  if (closuresRewritten(before, usageLimitClosuresFor(key, modelId))) return;
  if (result.open) {
    for (const entry of before) clearUsageLimitClosure(entry.key);
    return;
  }
  // Reconcile each closure on its own: one still in force keeps its own end,
  // one the policy reopened is dropped, and one only the policy holds is
  // recorded. A policy without `inForce` names at most the scope in force.
  const inForce = result.inForce ?? [{ scope: result.scope, until: result.until }];
  const states = new Map(inForce.map((state) => [scopeKey(state.scope), state]));
  for (const entry of before) {
    const state = states.get(scopeKey(entry.key.scope));
    if (state === undefined) {
      // Without the list, a provider-wide answer says nothing about scoped closures.
      if (result.inForce !== undefined || entry.key.scope === undefined) {
        clearUsageLimitClosure(entry.key);
      }
      continue;
    }
    states.delete(scopeKey(entry.key.scope));
    confirmUsageLimitClosure(entry.key, state.until, result.detail);
  }
  for (const state of states.values()) {
    const confirmed: UsageLimitClosureKey = { ...key };
    if (state.scope !== undefined) confirmed.scope = state.scope;
    confirmUsageLimitClosure(confirmed, state.until, result.detail);
  }
}

/** Root owner a spawn with `options` is accounted to (see `captureUsageScope`). */
export function spawnOwner(
  mgr: ManagerState,
  ctx: ExtensionContext,
  options: SpawnOptions,
): string | undefined {
  const parent =
    options.parentAgentId === undefined ? undefined : mgr.usageScopes.get(options.parentAgentId);
  return options.rootSessionId ?? parent?.owner ?? sessionRootOf(ctx);
}

/** `refreshProviderBlock` for the provider and owner `spawn` would check. Never rejects. */
export async function refreshSpawnProvider(
  mgr: ManagerState,
  ctx: ExtensionContext,
  options: SpawnOptions,
): Promise<void> {
  await closureRecheck(
    mgr,
    providerKeyFor(options, ctx),
    spawnOwner(mgr, ctx, options),
    modelIdFor(options, ctx),
  );
}

/**
 * `refreshProviderBlock` for the provider a resume of `id` would check:
 * the `provider/id` it switches to, else the session's current provider.
 * A dormant agent is checked under the journal root. Never rejects.
 */
export async function refreshResumeProvider(
  mgr: ManagerState,
  id: string,
  model?: string,
  ctx?: ExtensionContext,
): Promise<void> {
  await resumeRecheck(mgr, id, model, ctx);
}

/** The re-check `refreshResumeProvider` awaits, or undefined when nothing blocks. */
export function resumeRecheck(
  mgr: ManagerState,
  id: string,
  model: string | undefined,
  ctx: ExtensionContext | undefined,
): Promise<void> | undefined {
  const slash = model?.indexOf("/") ?? -1;
  const target = model !== undefined && slash > 0 ? model.slice(0, slash) : undefined;
  const targetId = model !== undefined && slash > 0 ? model.slice(slash + 1) : undefined;
  const record = mgr.agents.get(id);
  if (record !== undefined) {
    const current = record.session?.model;
    const provider = target ?? current?.provider;
    if (provider === undefined) return undefined;
    const modelId = target === undefined ? current?.id : targetId;
    return closureRecheck(mgr, provider, mgr.usageScopes.get(id)?.owner, modelId);
  }
  const saved = getDormant(mgr, id);
  if (saved === undefined) return undefined;
  const fallback = saved.model ?? ctx?.model;
  const provider = target ?? fallback?.provider;
  if (provider === undefined) return undefined;
  const modelId = target === undefined ? fallback?.id : targetId;
  const owner =
    mgr.journalSink?.rootSessionId ?? (ctx === undefined ? undefined : sessionRootOf(ctx));
  return closureRecheck(mgr, provider, owner, modelId);
}

/**
 * A request on `modelId` that started at `startedAt` succeeded on
 * `providerKey`: reopen `owner`'s usage-limit closures that blocked it
 * there (the provider-wide one and the scoped ones covering the model),
 * except any written after that start.
 */
export function reopenAfterSuccess(
  mgr: ManagerState,
  owner: string | undefined,
  providerKey: string,
  startedAt: number,
  modelId: string | undefined,
) {
  if (owner === undefined) return;
  const key = providerKey.toLowerCase();
  const policy = readUsageLimitPolicy(owner);
  const accountId = accountFor(mgr, owner, key, policy);
  if (policy !== undefined) reopenWithPolicy(policy, key, accountId, startedAt, modelId);
  for (const entry of usageLimitClosuresFor({ owner, providerKey: key, accountId }, modelId)) {
    if (startedAt >= (entry.closure.closedAt ?? Number.POSITIVE_INFINITY)) {
      clearUsageLimitClosure(entry.key);
    }
  }
}

/**
 * Account key for `owner`'s closures on `providerKey`: the owner policy's
 * current account when it answers, else the account last classified for this
 * owner and provider, else `"default"`. Availability checks and closure
 * writes both use it, so a root closure and a manager closure share a key.
 */
export function accountFor(
  mgr: ManagerState,
  owner: string,
  providerKey: string,
  policy: UsageLimitPolicy | undefined = readUsageLimitPolicy(owner),
): string {
  const key = providerKey.toLowerCase();
  const fromPolicy = policy === undefined ? undefined : accountIdWithPolicy(policy, key);
  return fromPolicy ?? mgr.classifiedAccounts.get(accountKey(owner, key)) ?? "default";
}

/**
 * Why `modelId` on `providerKey` is closed for `owner`, or undefined when it
 * is open. The
 * owner's usage-limit closures (policy first, then the manager's own record of
 * them, which carries the reset time and suggestion) are consulted before the
 * process-global transient registry. Other owners and accounts never block.
 * A model-scoped closure blocks only the models it covers; without
 * `modelId` only provider-wide closures count.
 * `usage` is true when a usage-limit closure (not a transient one) blocks.
 * `modelOnly` is true when only `modelId` is closed and the provider's other
 * models are open; refusal text then names the model, so a workflow skips
 * only that model's steps.
 */
export function providerBlock(
  mgr: ManagerState,
  providerKey: string,
  owner: string | undefined,
  modelId?: string,
): { closure?: UsageLimitClosure; usage: boolean; modelOnly: boolean } | undefined {
  const key = providerKey.toLowerCase();
  if (owner !== undefined) {
    const policy = readUsageLimitPolicy(owner);
    const accountId = accountFor(mgr, owner, key, policy);
    const closure = blockingUsageLimitClosure({ owner, providerKey: key, accountId }, modelId);
    const policyWide = policy !== undefined && isClosedWithPolicy(policy, key, accountId);
    // A provider-wide policy closure must not be reported as a scoped one.
    if (policyWide && closure?.scope !== undefined) {
      return { usage: true, modelOnly: false };
    }
    if (policy !== undefined && isClosedWithPolicy(policy, key, accountId, modelId)) {
      // Without a provider-wide closure on either side, only this model is closed,
      // even when the policy holds the only copy of the closure.
      const modelOnly =
        modelId !== undefined &&
        !policyWide &&
        (closure === undefined || closure.scope !== undefined);
      return { closure, usage: true, modelOnly };
    }
    if (closure !== undefined) {
      return {
        closure,
        usage: true,
        modelOnly: modelId !== undefined && closure.scope !== undefined,
      };
    }
  }
  const level = transientBlockLevel(key, modelId);
  return level === undefined ? undefined : { usage: false, modelOnly: level === "model" };
}

export function captureUsageScope(
  mgr: ManagerState,
  ctx: ExtensionContext,
  options: SpawnOptions,
): UsageLimitScope {
  const parent =
    options.parentAgentId === undefined ? undefined : mgr.usageScopes.get(options.parentAgentId);
  const owner = spawnOwner(mgr, ctx, options);
  const scoped = scopedModelKeys(ctx);
  // Widened read: test fixtures and RPC contexts may omit the registry.
  const modelRegistry: UsageModelRegistry | undefined = ctx.modelRegistry;
  return {
    owner,
    cwd: ctx.cwd ?? parent?.cwd ?? process.cwd(),
    modelRegistry: modelRegistry ?? parent?.modelRegistry,
    scoped: scoped.length > 0 ? scoped : (parent?.scoped ?? []),
  };
}
