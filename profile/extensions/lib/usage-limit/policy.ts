import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageSnapshot } from "../../provider-usage.ts";
import {
  closureScopeFor,
  DEFAULT_ON_USAGE_LIMIT,
  scopeCoversModel,
  scopeKey,
  type CodexUsageLimitEntry,
  type OnUsageLimit,
  type UsageLimitClassification,
  type UsageLimitClosureState,
  type UsageLimitPolicy,
  type UsageLimitRecheck,
  type UsageLimitScope,
} from "../usage-limit-contract.ts";
import { classifyUsageLimit, MAX_CLOSE_MS } from "./classifiers.ts";
import {
  corroborateUsageLimit,
  liveReading,
  windowsBlockingModel,
  withScope,
  type ExhaustedWindow,
  type QuotaReading,
  type SyntheticQuotaEvents,
  type UsageLimitCorroboration,
} from "./corroboration.ts";
import {
  defaultAccountId,
  loadModelFallbacks,
  pickFallback,
  type AccountIdResolver,
  type ModelFallbacks,
} from "./fallbacks.ts";

export type UsageLimitPolicyOptions = {
  owner: string;
  generation: number;
  readPreference: () => Promise<OnUsageLimit>;
  ctx?: ExtensionContext;
  events?: SyntheticQuotaEvents;
  fallbacks?: ModelFallbacks;
  loadFallbacks?: () => Promise<ModelFallbacks>;
  usageSnapshot?: (provider: string) => Promise<ProviderUsageSnapshot | undefined>;
  readCodexEntry?: () => CodexUsageLimitEntry | undefined;
  resolveAccountId?: AccountIdResolver;
  now?: () => number;
};

export type UsageLimitPolicyInstance = Omit<UsageLimitPolicy, "corroborate"> & {
  corroborate(classification: UsageLimitClassification): Promise<UsageLimitCorroboration>;
  recheck(
    providerKey: string,
    accountId: string,
    since?: number,
    modelId?: string,
  ): Promise<UsageLimitRecheck>;
  reopen(providerKey: string, accountId: string, at?: number, modelId?: string): void;
  accountId(provider: string): string;
  fallbacksLoaded: Promise<void>;
};

function accountKey(providerKey: string, accountId: string): string {
  return `${providerKey}\u0000${accountId}`;
}

function closedKey(providerKey: string, accountId: string, scope?: UsageLimitScope): string {
  return `${accountKey(providerKey, accountId)}\u0000${scopeKey(scope)}`;
}

type ClosedAccount = { until: number; closedAt: number; scope?: UsageLimitScope };

export type RecheckTarget =
  | { kind: "closure"; scope?: UsageLimitScope }
  | { kind: "model"; modelId: string };

function exhaustedDetail(windows: readonly ExhaustedWindow[]): string {
  const labels = windows.flatMap((window) => (window.label ? [window.label] : []));
  return labels.length > 0
    ? `live usage shows ${labels.join(", ")} exhausted`
    : "live usage shows the quota exhausted";
}

export function recheckReading(
  reading: QuotaReading | undefined,
  closedAt: number,
  now: number,
  target: RecheckTarget = { kind: "closure" },
): UsageLimitRecheck {
  if (!reading) return { open: true, detail: "no live usage data" };
  const fresh = reading.observedAt >= closedAt;
  const current = reading.exhausted.filter(
    (window) => fresh || window.resetAt === undefined || window.resetAt > now,
  );
  let blocking: ExhaustedWindow[];
  let scope: UsageLimitScope | undefined;
  if (target.kind === "model") {
    ({ blocking, scope } = windowsBlockingModel(current, target.modelId));
  } else {
    const own = target.scope;
    blocking = current.filter(
      (window) => window.scope === undefined || (own !== undefined && window.scope === own.name),
    );
    scope = blocking.some((window) => window.scope === undefined) ? undefined : own;
  }
  if (blocking.length === 0) {
    return { open: true, detail: fresh ? "live usage shows capacity" : "no current usage data" };
  }
  const resets = blocking.map((window) => window.resetAt);
  const known = resets.every((reset) => reset !== undefined && reset > now);
  const result: UsageLimitRecheck = { open: false, detail: exhaustedDetail(blocking) };
  if (known) {
    let until = now;
    for (const reset of resets) if (reset !== undefined && reset > until) until = reset;
    result.until = until;
  }
  if (scope !== undefined) result.scope = scope;
  return result;
}

function closedAnswer(entries: readonly ClosedAccount[], detail?: string): UsageLimitRecheck {
  let until: number | undefined;
  for (const entry of entries) if (until === undefined || entry.until > until) until = entry.until;
  const answer: UsageLimitRecheck = { open: false };
  if (until !== undefined) answer.until = until;
  if (detail !== undefined) answer.detail = detail;
  const scoped = entries.every((entry) => entry.scope !== undefined);
  const scope = scoped ? entries[0]?.scope : undefined;
  if (scope !== undefined) answer.scope = scope;
  answer.inForce = entries.map((entry) => {
    const state: UsageLimitClosureState = { until: entry.until };
    if (entry.scope !== undefined) state.scope = entry.scope;
    return state;
  });
  return answer;
}

export function createUsageLimitPolicy(options: UsageLimitPolicyOptions): UsageLimitPolicyInstance {
  const now = options.now ?? Date.now;
  const resolveAccountId = options.resolveAccountId ?? defaultAccountId;
  const closed = new Map<string, ClosedAccount>();
  const succeededAt = new Map<string, Map<string, number>>();

  const blockingClosures = (
    providerKey: string,
    accountId: string,
    modelId: string | undefined,
    at: number,
  ): [string, ClosedAccount][] => {
    const prefix = `${accountKey(providerKey, accountId)}\u0000`;
    const result: [string, ClosedAccount][] = [];
    for (const [key, entry] of closed) {
      if (!key.startsWith(prefix)) continue;
      if (at >= entry.until) {
        closed.delete(key);
        continue;
      }
      if (
        entry.scope === undefined ||
        (modelId !== undefined && scopeCoversModel(entry.scope, modelId))
      ) {
        result.push([key, entry]);
      }
    }
    return result;
  };

  const latestSuccess = (
    providerKey: string,
    accountId: string,
    scope: UsageLimitScope | undefined,
  ): number | undefined => {
    let latest: number | undefined;
    for (const [modelId, at] of succeededAt.get(accountKey(providerKey, accountId)) ?? []) {
      if (scope !== undefined && (modelId === "" || !scopeCoversModel(scope, modelId))) continue;
      if (latest === undefined || at > latest) latest = at;
    }
    return latest;
  };

  const readLive = (providerKey: string): Promise<QuotaReading | undefined> =>
    liveReading(
      { usageSnapshot: options.usageSnapshot, extension: options.ctx, events: options.events },
      providerKey,
    );

  const widenClosure = (
    providerKey: string,
    accountId: string,
    entry: ClosedAccount,
    at: number,
  ): ClosedAccount => {
    const wideKey = closedKey(providerKey, accountId);
    const existing = closed.get(wideKey);
    if (existing !== undefined) {
      existing.until = Math.max(existing.until, entry.until);
      return existing;
    }
    const widened: ClosedAccount = { until: entry.until, closedAt: at };
    closed.set(wideKey, widened);
    return widened;
  };

  const recheckUnrecorded = async (
    providerKey: string,
    accountId: string,
    since: number | undefined,
    modelId: string | undefined,
  ): Promise<UsageLimitRecheck> => {
    const closedAt = since ?? 0;
    const proving =
      modelId === undefined ? undefined : { name: "", models: [modelId], exact: true };
    const success = latestSuccess(providerKey, accountId, proving);
    if (success !== undefined && success >= closedAt) {
      return { open: true, detail: "a request succeeded after the limit" };
    }
    const reading = await readLive(providerKey);
    const current = now();
    const succeeded = latestSuccess(providerKey, accountId, proving);
    if (succeeded !== undefined && succeeded >= closedAt) {
      return { open: true, detail: "a request succeeded after the limit" };
    }
    const written = blockingClosures(providerKey, accountId, modelId, current);
    if (written.length > 0) return closedAnswer(written.map(([, entry]) => entry));
    const result = recheckReading(
      reading,
      closedAt,
      current,
      modelId === undefined ? { kind: "closure" } : { kind: "model", modelId },
    );
    if (result.open) return result;
    const state: UsageLimitClosureState = {};
    if (result.scope !== undefined) state.scope = result.scope;
    if (result.until !== undefined) state.until = result.until;
    return { ...result, inForce: [state] };
  };

  let fallbacks = options.fallbacks;
  const loadFallbacks = options.loadFallbacks ?? (() => loadModelFallbacks());
  const fallbacksLoaded: Promise<void> = fallbacks
    ? Promise.resolve()
    : new Promise<ModelFallbacks>((resolve) => resolve(loadFallbacks())).then(
        (table) => {
          fallbacks = table;
        },
        () => undefined,
      );

  return {
    owner: options.owner,
    generation: options.generation,
    fallbacksLoaded,
    async preference() {
      let preference: OnUsageLimit;
      try {
        preference = await options.readPreference();
      } catch {
        preference = DEFAULT_ON_USAGE_LIMIT;
      }
      await fallbacksLoaded;
      return preference;
    },
    classify(input) {
      return classifyUsageLimit({ ...input, now: now() });
    },
    async corroborate(classification) {
      let codexEntry: CodexUsageLimitEntry | undefined;
      const ownFailure =
        classification.sessionId === undefined || classification.sessionId === options.owner;
      if (ownFailure) {
        try {
          codexEntry = options.readCodexEntry?.();
        } catch {
          codexEntry = undefined;
        }
      }
      const corroboration = await corroborateUsageLimit(
        {
          usageSnapshot: options.usageSnapshot,
          extension: options.ctx,
          events: options.events,
          codexEntry,
          now,
        },
        classification,
      );
      await fallbacksLoaded;
      const scope = closureScopeFor(
        corroboration.classification,
        corroboration.evidence === "confirmed",
      );
      if (scope === corroboration.classification.scope) return corroboration;
      return { ...corroboration, classification: withScope(corroboration.classification, scope) };
    },
    pickFallback(current, context) {
      return fallbacks ? pickFallback(fallbacks, current, context, resolveAccountId) : undefined;
    },
    accountId(provider) {
      return resolveAccountId(provider);
    },
    closeProvider(providerKey, accountId, untilMs, scope) {
      if (Number.isNaN(untilMs)) return;
      const closedAt = now();
      const entry: ClosedAccount = {
        until: Math.min(untilMs, closedAt + MAX_CLOSE_MS),
        closedAt,
      };
      if (scope !== undefined) {
        entry.scope = { name: scope.name, models: [...scope.models] };
        if (scope.exact === true) entry.scope.exact = true;
      }
      closed.set(closedKey(providerKey, accountId, scope), entry);
    },
    isClosed(providerKey, accountId, at = now(), modelId) {
      return blockingClosures(providerKey, accountId, modelId, at).length > 0;
    },
    reopen(providerKey, accountId, at = now(), modelId) {
      const account = accountKey(providerKey, accountId);
      const byModel = succeededAt.get(account) ?? new Map<string, number>();
      const model = modelId ?? "";
      byModel.set(model, Math.max(byModel.get(model) ?? at, at));
      succeededAt.set(account, byModel);
      for (const [key, entry] of blockingClosures(providerKey, accountId, modelId, now())) {
        if (at >= entry.closedAt) closed.delete(key);
      }
    },
    async recheck(providerKey, accountId, since, modelId) {
      const checked = blockingClosures(providerKey, accountId, modelId, now());
      if (checked.length === 0) return recheckUnrecorded(providerKey, accountId, since, modelId);
      const reopenChecked = (key: string, entry: ClosedAccount): void => {
        if (closed.get(key) === entry) closed.delete(key);
      };
      const pending: { key: string; entry: ClosedAccount; closedAt: number }[] = [];
      for (const [key, entry] of checked) {
        const closedAt = Math.max(entry.closedAt, since ?? 0);
        const success = latestSuccess(providerKey, accountId, entry.scope);
        if (success !== undefined && success >= closedAt) reopenChecked(key, entry);
        else pending.push({ key, entry, closedAt });
      }
      if (pending.length === 0)
        return { open: true, detail: "a request succeeded after the limit" };
      const reading = await readLive(providerKey);
      const current = now();
      const written = blockingClosures(providerKey, accountId, modelId, current).filter(
        ([key, entry]) => !checked.some(([oldKey, old]) => oldKey === key && old === entry),
      );
      if (written.length > 0) return closedAnswer(written.map(([, entry]) => entry));
      const stillClosed: ClosedAccount[] = [];
      let detail: string | undefined;
      let openDetail: string | undefined;
      for (const { key, entry, closedAt } of pending) {
        if (closed.get(key) !== entry) {
          openDetail ??= "a request succeeded after the limit";
          continue;
        }
        const success = latestSuccess(providerKey, accountId, entry.scope);
        if (success !== undefined && success >= closedAt) {
          openDetail ??= "a request succeeded after the limit";
          reopenChecked(key, entry);
          continue;
        }
        const exactModel = entry.scope?.exact === true ? entry.scope.models[0] : undefined;
        const result = recheckReading(
          reading,
          closedAt,
          current,
          exactModel === undefined
            ? { kind: "closure", scope: entry.scope }
            : { kind: "model", modelId: exactModel },
        );
        if (result.open) {
          openDetail ??= result.detail;
          reopenChecked(key, entry);
          continue;
        }
        if (result.until !== undefined)
          entry.until = Math.min(result.until, current + MAX_CLOSE_MS);
        detail ??= result.detail;
        stillClosed.push(entry);
        if (entry.scope !== undefined && result.scope === undefined) {
          const wide = widenClosure(providerKey, accountId, entry, current);
          if (!stillClosed.includes(wide)) stillClosed.push(wide);
        }
      }
      if (stillClosed.length === 0) {
        return openDetail === undefined ? { open: true } : { open: true, detail: openDetail };
      }
      return closedAnswer(stillClosed, detail);
    },
  };
}
