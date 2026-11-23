import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import {
  SYNTHETIC_QUOTAS_READ_EVENT,
  SYNTHETIC_QUOTAS_REQUEST_EVENT,
  SyntheticQuotasSnapshotPayloadSchema,
  type QuotasResponse,
  type SyntheticQuotasSnapshotPayload,
} from "../../../../packages/choco-pi-provider-synthetic/src/types/quotas.ts";
import { providerUsageSnapshot, type ProviderUsageSnapshot } from "../../provider-usage.ts";
import type { RuntimeValue } from "../runtime-values.ts";
import {
  scopeCoversModel,
  type CodexUsageLimitEntry,
  type UsageLimitClassification,
  type UsageLimitEvidence,
  type UsageLimitScope,
} from "../usage-limit-contract.ts";
import { CODEX_ENTRY_WINDOW_MS, parseTime } from "./classifiers.ts";

const SYNTHETIC_REQUEST_TIMEOUT_MS = 10_000;

export type ExhaustedWindow = { resetAt?: number; label?: string; scope?: string };

export type QuotaReading = { exhausted: ExhaustedWindow[]; observedAt: number };

export type SyntheticQuotaEvents = Pick<EventBus, "emit">;

export type UsageLimitCorroborationContext = {
  usageSnapshot?: (provider: string) => Promise<ProviderUsageSnapshot | undefined>;
  extension?: ExtensionContext;
  events?: SyntheticQuotaEvents;
  codexEntry?: CodexUsageLimitEntry;
  failedAt?: number;
  now?: () => number;
  syntheticTimeoutMs?: number;
};

export type UsageLimitCorroboration = {
  ready: boolean;
  classification: UsageLimitClassification;
  evidence: UsageLimitEvidence;
};

function windowReading(snapshot: ProviderUsageSnapshot): QuotaReading {
  return {
    observedAt: snapshot.observedAt,
    exhausted: snapshot.windows
      .filter((window) => window.percent >= 100)
      .map((window) => {
        const time = window.eventAt?.getTime();
        const exhausted: ExhaustedWindow =
          time === undefined || Number.isNaN(time)
            ? { label: window.label }
            : { resetAt: time, label: window.label };
        if (window.scope !== undefined) exhausted.scope = window.scope.toLowerCase();
        return exhausted;
      }),
  };
}

export const KNOWN_LIMIT_SCOPES = new Map([["fable", ["claude-fable", "claude-mythos"]]]);

function knownScope(name: string): UsageLimitScope | undefined {
  const models = KNOWN_LIMIT_SCOPES.get(name);
  return models === undefined ? undefined : { name, models: [...models] };
}

export type ModelBlockingWindows = { blocking: ExhaustedWindow[]; scope?: UsageLimitScope };

export function windowsBlockingModel(
  exhausted: readonly ExhaustedWindow[],
  modelId: string,
): ModelBlockingWindows {
  const blocking: ExhaustedWindow[] = [];
  let providerWide = false;
  let known: UsageLimitScope | undefined;
  let unknown: UsageLimitScope | undefined;
  for (const window of exhausted) {
    if (window.scope === undefined) {
      blocking.push(window);
      providerWide = true;
      continue;
    }
    const scope = knownScope(window.scope);
    if (scope === undefined) {
      blocking.push(window);
      unknown ??= { name: window.scope, models: [modelId], exact: true };
    } else if (scopeCoversModel(scope, modelId)) {
      blocking.push(window);
      known ??= scope;
    }
  }
  const result: ModelBlockingWindows = { blocking };
  const scope = known ?? unknown;
  if (!providerWide && scope !== undefined) result.scope = scope;
  return result;
}

export function withScope(
  classification: UsageLimitClassification,
  scope: UsageLimitScope | undefined,
): UsageLimitClassification {
  const copy: UsageLimitClassification = { ...classification };
  if (scope === undefined) delete copy.scope;
  else copy.scope = scope;
  return copy;
}

export function syntheticExhaustedWindows(quotas: QuotasResponse): ExhaustedWindow[] {
  const exhausted: ExhaustedWindow[] = [];
  const rolling = quotas.rollingFiveHourLimit;
  if (rolling && (rolling.limited || rolling.remaining <= 0)) {
    exhausted.push({ resetAt: parseTime(rolling.nextTickAt) });
  }
  const weekly = quotas.weeklyTokenLimit;
  if (weekly && weekly.percentRemaining <= 0) {
    exhausted.push({ resetAt: parseTime(weekly.nextRegenAt) });
  }
  const subscription = quotas.subscription;
  if (subscription && subscription.limit > 0 && subscription.requests >= subscription.limit) {
    exhausted.push({ resetAt: parseTime(subscription.renewsAt) });
  }
  return exhausted;
}

function emitForSnapshot(
  events: SyntheticQuotaEvents,
  channel: string,
  timeoutMs: number,
): Promise<RuntimeValue> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: RuntimeValue): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      events.emit(channel, {
        respond: (snapshot: RuntimeValue) => finish(snapshot),
      });
    } catch {
      finish(undefined);
    }
  });
}

const isSyntheticSnapshot = compile(SyntheticQuotasSnapshotPayloadSchema).check;

async function syntheticReading(
  events: SyntheticQuotaEvents,
  timeoutMs: number,
): Promise<QuotaReading | undefined> {
  const refreshed = await emitForSnapshot(events, SYNTHETIC_QUOTAS_REQUEST_EVENT, timeoutMs);
  const read = await emitForSnapshot(events, SYNTHETIC_QUOTAS_READ_EVENT, timeoutMs);
  let best: SyntheticQuotasSnapshotPayload | undefined;
  for (const candidate of [read, refreshed]) {
    if (!isSyntheticSnapshot(candidate)) continue;
    if (!best || candidate.updatedAt > best.updatedAt) best = candidate;
  }
  if (!best) return undefined;
  return {
    observedAt: best.updatedAt,
    exhausted: syntheticExhaustedWindows(best.quotas),
  };
}

function earliest(times: readonly (number | undefined)[]): number | undefined {
  let result: number | undefined;
  for (const time of times) {
    if (time !== undefined && (result === undefined || time < result)) result = time;
  }
  return result;
}

function applyReading(
  classification: UsageLimitClassification,
  reading: QuotaReading,
  failedAt: number,
  now: number,
): UsageLimitCorroboration {
  const fresh = reading.observedAt >= failedAt;
  const current = fresh
    ? reading.exhausted
    : reading.exhausted.filter((window) => window.resetAt !== undefined && window.resetAt > now);
  const { blocking, scope } = windowsBlockingModel(current, classification.modelId);
  if (blocking.length > 0) {
    const resetAt = earliest(blocking.map((window) => window.resetAt));
    const scoped = withScope(classification, scope);
    return {
      ready: false,
      classification: resetAt === undefined ? scoped : { ...scoped, resetAt },
      evidence: "confirmed",
    };
  }
  return {
    ready: fresh,
    classification,
    evidence: fresh ? "capacity" : "unavailable",
  };
}

function withCodexEntry(
  classification: UsageLimitClassification,
  entry: CodexUsageLimitEntry | undefined,
  failedAt: number,
): UsageLimitClassification {
  if (!entry || Math.abs(failedAt - entry.observedAt) > CODEX_ENTRY_WINDOW_MS) {
    return classification;
  }
  const upgraded: UsageLimitClassification = {
    ...classification,
    confidence: "structured",
  };
  if (entry.resetAt !== undefined) upgraded.resetAt = entry.resetAt;
  if (entry.accountId !== undefined) upgraded.accountId = entry.accountId;
  return upgraded;
}

async function readUsageSnapshot(
  context: UsageLimitCorroborationContext,
  provider: string,
): Promise<ProviderUsageSnapshot | undefined> {
  if (context.usageSnapshot) return context.usageSnapshot(provider);
  if (context.extension) return providerUsageSnapshot(context.extension, provider);
  return undefined;
}

export async function liveReading(
  context: UsageLimitCorroborationContext,
  provider: string,
): Promise<QuotaReading | undefined> {
  try {
    if (provider === "anthropic" || provider === "openai-codex") {
      const snapshot = await readUsageSnapshot(context, provider);
      return snapshot ? windowReading(snapshot) : undefined;
    }
    if (provider === "synthetic" && context.events) {
      return await syntheticReading(
        context.events,
        context.syntheticTimeoutMs ?? SYNTHETIC_REQUEST_TIMEOUT_MS,
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function corroborateStructured(
  context: UsageLimitCorroborationContext,
  classification: UsageLimitClassification,
  structuredResetAt: number,
  now: () => number,
): Promise<UsageLimitCorroboration> {
  const failedAt = context.failedAt ?? now();
  const reading = await liveReading(context, classification.provider);
  const current = now();
  const elapsed = structuredResetAt <= current;
  if (!reading) return { ready: elapsed, classification, evidence: "confirmed" };
  const fresh = reading.observedAt >= failedAt;
  const { blocking, scope } = windowsBlockingModel(
    reading.exhausted.filter(
      (window) => fresh || (window.resetAt !== undefined && window.resetAt > current),
    ),
    classification.modelId,
  );
  if (blocking.length === 0) return { ready: elapsed, classification, evidence: "confirmed" };
  const windowResetAt = earliest(blocking.map((window) => window.resetAt));
  const resetAt =
    windowResetAt === undefined ? structuredResetAt : Math.max(structuredResetAt, windowResetAt);
  return {
    ready: false,
    classification: { ...withScope(classification, scope), resetAt },
    evidence: "confirmed",
  };
}

async function corroborateQuota(
  context: UsageLimitCorroborationContext,
  classification: UsageLimitClassification,
  failedAt: number,
  now: () => number,
): Promise<UsageLimitCorroboration> {
  const unchanged: UsageLimitCorroboration = {
    ready: false,
    classification,
    evidence: "unavailable",
  };
  const { provider } = classification;
  if (provider === "anthropic") {
    const snapshot = await readUsageSnapshot(context, provider);
    return snapshot
      ? applyReading(classification, windowReading(snapshot), failedAt, now())
      : unchanged;
  }
  if (provider === "openai-codex") {
    const structured = withCodexEntry(classification, context.codexEntry, failedAt);
    const snapshot = await readUsageSnapshot(context, provider);
    const current = now();
    const pending =
      structured.confidence === "structured" &&
      structured.resetAt !== undefined &&
      structured.resetAt > current;
    if (!snapshot) {
      return {
        ready: false,
        classification: structured,
        evidence: pending ? "confirmed" : "unavailable",
      };
    }
    const result = applyReading(structured, windowReading(snapshot), failedAt, current);
    if (structured.confidence !== "structured") return result;
    return {
      ready: result.ready && !pending,
      classification: { ...result.classification, resetAt: structured.resetAt },
      evidence: pending ? "confirmed" : result.evidence,
    };
  }
  if (provider === "synthetic") {
    if (!context.events) return unchanged;
    const reading = await syntheticReading(
      context.events,
      context.syntheticTimeoutMs ?? SYNTHETIC_REQUEST_TIMEOUT_MS,
    );
    return reading ? applyReading(classification, reading, failedAt, now()) : unchanged;
  }
  return unchanged;
}

export async function corroborateUsageLimit(
  context: UsageLimitCorroborationContext,
  classification: UsageLimitClassification,
): Promise<UsageLimitCorroboration> {
  const now = context.now ?? Date.now;
  if (classification.kind === "billing") {
    return { ready: false, classification, evidence: "unavailable" };
  }
  if (classification.kind === "transient") {
    return { ready: true, classification, evidence: "unavailable" };
  }
  if (classification.confidence === "structured" && classification.resetAt !== undefined) {
    return corroborateStructured(context, classification, classification.resetAt, now);
  }
  const failedAt = context.failedAt ?? now();
  try {
    return await corroborateQuota(context, classification, failedAt, now);
  } catch {
    return { ready: false, classification, evidence: "unavailable" };
  }
}
