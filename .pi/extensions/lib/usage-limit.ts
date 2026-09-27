/**
 * Usage-limit classification, corroboration against live quota data, the
 * cross-provider fallback table, and the owner policy published through the
 * usage-limit seam (`usage-limit-contract.ts`).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  SYNTHETIC_QUOTAS_READ_EVENT,
  SYNTHETIC_QUOTAS_REQUEST_EVENT,
  SyntheticQuotasSnapshotPayloadSchema,
} from "../../packages/choco-pi-provider-synthetic/src/types/quotas.ts";
import type { QuotasResponse } from "../../packages/choco-pi-provider-synthetic/src/types/quotas.ts";
import { providerUsageSnapshot } from "../provider-usage.ts";
import type { ProviderUsageSnapshot } from "../provider-usage.ts";
import { DEFAULT_ON_USAGE_LIMIT } from "./usage-limit-contract.ts";
import type {
  CodexUsageLimitEntry,
  FallbackCandidateContext,
  OnUsageLimit,
  UsageLimitClassification,
  UsageLimitClassifyInput,
  UsageLimitEvidence,
  UsageLimitPolicy,
} from "./usage-limit-contract.ts";
import type { RuntimeValue } from "./runtime-values.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Longest a provider stays closed on one report; a later report can re-close it. */
export const MAX_CLOSE_MS = 24 * HOUR_MS;
/** A Codex usage-limit entry further than this from the failure describes another failure. */
export const CODEX_ENTRY_WINDOW_MS = 60_000;
/** How long corroboration waits for the Synthetic provider to answer a quota refresh. */
const SYNTHETIC_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Host non-retryable provider-limit pattern, copied verbatim from
 * `@earendil-works/pi-ai/dist/utils/retry.js` (`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`).
 */
const BILLING_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const CODEX_LIMIT_PATTERN =
  /Codex usage limit reached|hit your ChatGPT usage limit|usage_limit_reached/i;
/** `Resets in ~12m.`, `Resets in ~1.5h.`, `Try again in ~5 min.` (codex `errors.ts`). */
const CODEX_RESET_PATTERN = /~(\d+(?:\.\d+)?) ?(min|m|hours?|h)\b/i;
const ANTHROPIC_LIMIT_PATTERN = /^429\b|rate_limit_error/;
/** `provider-retry.js` wrapper: `Server requested Ns retry delay (max: Ms). <message>`. */
const RETRY_DELAY_WRAPPER_PATTERN =
  /^Server requested (\d+)s retry delay \(max: \d+s\)\. ?([\s\S]*)$/;
const SYNTHETIC_LIMIT_PATTERN = /^429\b/;

export type ClassifyUsageLimitInput = UsageLimitClassifyInput & { now?: number };

function codexResetAt(message: string, now: number): number | undefined {
  const match = CODEX_RESET_PATTERN.exec(message);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] ?? "").toLowerCase().startsWith("h") ? HOUR_MS : MINUTE_MS;
  return now + amount * unit;
}

/**
 * Classifies a settled provider error. Returns `undefined` when the message is
 * not a usage limit. `resetAt` from a Codex message is a lower bound because the
 * provider rounds it; an Anthropic wrapper delay only proves a long requested
 * delay, so it is a candidate reset for a 429 and a transient failure otherwise.
 */
export function classifyUsageLimit(
  input: ClassifyUsageLimitInput,
): UsageLimitClassification | undefined {
  const now = input.now ?? Date.now();
  const { provider, modelId, errorMessage } = input;
  const base = { provider, modelId };
  if (BILLING_PATTERN.test(errorMessage)) {
    return { ...base, kind: "billing", confidence: "inferred" };
  }
  if (provider === "openai-codex") {
    if (!CODEX_LIMIT_PATTERN.test(errorMessage)) return undefined;
    const resetAt = codexResetAt(errorMessage, now);
    return resetAt === undefined
      ? { ...base, kind: "quota", confidence: "inferred" }
      : { ...base, kind: "quota", confidence: "parsed", resetAt };
  }
  if (provider === "anthropic") {
    const wrapped = RETRY_DELAY_WRAPPER_PATTERN.exec(errorMessage);
    if (wrapped) {
      const inner = wrapped[2] ?? "";
      if (!ANTHROPIC_LIMIT_PATTERN.test(inner)) {
        return { ...base, kind: "transient", confidence: "inferred" };
      }
      const seconds = Number(wrapped[1]);
      return Number.isFinite(seconds)
        ? { ...base, kind: "quota", confidence: "inferred", resetAt: now + seconds * 1000 }
        : { ...base, kind: "quota", confidence: "inferred" };
    }
    return ANTHROPIC_LIMIT_PATTERN.test(errorMessage)
      ? { ...base, kind: "quota", confidence: "inferred" }
      : undefined;
  }
  if (provider === "synthetic") {
    return SYNTHETIC_LIMIT_PATTERN.test(errorMessage)
      ? { ...base, kind: "quota", confidence: "inferred" }
      : undefined;
  }
  return undefined;
}

/** One quota window that currently blocks requests, with the time it restores capacity. */
type ExhaustedWindow = { resetAt?: number };

/** A provider reading reduced to what readiness needs. */
type QuotaReading = { exhausted: ExhaustedWindow[]; observedAt: number };

export type SyntheticQuotaEvents = Pick<EventBus, "emit">;

export type UsageLimitCorroborationContext = {
  /** Reads Anthropic/Codex quota windows; defaults to `provider-usage.ts` when `extension` is set. */
  usageSnapshot?: (provider: string) => Promise<ProviderUsageSnapshot | undefined>;
  extension?: ExtensionContext;
  /** Extension event bus used to reach the Synthetic quota store. */
  events?: SyntheticQuotaEvents;
  /** Latest `CODEX_USAGE_LIMIT_ENTRY` payload on the session branch, if any. */
  codexEntry?: CodexUsageLimitEntry;
  /** Epoch ms of the failure; defaults to `now()` at the start of corroboration. */
  failedAt?: number;
  now?: () => number;
  syntheticTimeoutMs?: number;
};

export type { UsageLimitEvidence } from "./usage-limit-contract.ts";

export type UsageLimitCorroboration = {
  ready: boolean;
  classification: UsageLimitClassification;
  evidence: UsageLimitEvidence;
};

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function windowReading(snapshot: ProviderUsageSnapshot): QuotaReading {
  return {
    observedAt: snapshot.observedAt,
    exhausted: snapshot.windows
      .filter((window) => window.percent >= 100)
      .map((window) => {
        const time = window.eventAt?.getTime();
        return time === undefined || Number.isNaN(time) ? {} : { resetAt: time };
      }),
  };
}

/** Synthetic windows that block chat requests; search and free tool-call quotas do not. */
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
      events.emit(channel, { respond: (snapshot: RuntimeValue) => finish(snapshot) });
    } catch {
      finish(undefined);
    }
  });
}

/**
 * Asks the Synthetic provider to refresh its quota store, then reads the store.
 * Resolves `undefined` when the provider does not answer or the payload is
 * malformed.
 */
async function syntheticReading(
  events: SyntheticQuotaEvents,
  timeoutMs: number,
): Promise<QuotaReading | undefined> {
  const refreshed = await emitForSnapshot(events, SYNTHETIC_QUOTAS_REQUEST_EVENT, timeoutMs);
  const read = await emitForSnapshot(events, SYNTHETIC_QUOTAS_READ_EVENT, timeoutMs);
  let best: Static<typeof SyntheticQuotasSnapshotPayloadSchema> | undefined;
  for (const candidate of [read, refreshed]) {
    if (!Value.Check(SyntheticQuotasSnapshotPayloadSchema, candidate)) continue;
    const parsed = Value.Parse(SyntheticQuotasSnapshotPayloadSchema, candidate);
    if (!best || parsed.updatedAt > best.updatedAt) best = parsed;
  }
  if (!best) return undefined;
  return { observedAt: best.updatedAt, exhausted: syntheticExhaustedWindows(best.quotas) };
}

function earliest(times: readonly (number | undefined)[]): number | undefined {
  let result: number | undefined;
  for (const time of times) {
    if (time !== undefined && (result === undefined || time < result)) result = time;
  }
  return result;
}

/**
 * Applies a reading. A reading taken at or after the failure is authoritative
 * both ways. An older reading can still prove exhaustion through a window whose
 * reset lies ahead, but its absence of exhaustion proves nothing, because the
 * limit may have been reached after it was taken.
 */
function applyReading(
  classification: UsageLimitClassification,
  reading: QuotaReading,
  failedAt: number,
  now: number,
): UsageLimitCorroboration {
  const fresh = reading.observedAt >= failedAt;
  const blocking = fresh
    ? reading.exhausted
    : reading.exhausted.filter((window) => window.resetAt !== undefined && window.resetAt > now);
  if (blocking.length > 0) {
    const resetAt = earliest(blocking.map((window) => window.resetAt));
    return {
      ready: false,
      classification: resetAt === undefined ? classification : { ...classification, resetAt },
      evidence: "confirmed",
    };
  }
  return { ready: fresh, classification, evidence: fresh ? "capacity" : "unavailable" };
}

function withCodexEntry(
  classification: UsageLimitClassification,
  entry: CodexUsageLimitEntry | undefined,
  failedAt: number,
): UsageLimitClassification {
  if (!entry || Math.abs(failedAt - entry.observedAt) > CODEX_ENTRY_WINDOW_MS) {
    return classification;
  }
  const upgraded: UsageLimitClassification = { ...classification, confidence: "structured" };
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

/** The provider's live quota reading, or `undefined` when none can be read. Never rejects. */
async function liveReading(
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

/**
 * Corroborates a classification that already carries the provider's structured
 * reset (for example a child session's Codex entry). The structured report
 * confirms the failure, so evidence is always `confirmed`, and another
 * session's branch entry is never consulted. Readiness additionally requires
 * that live window data, when readable, shows no window still exhausted; such a
 * window keeps the limit in force until the later of the two resets.
 */
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
  const blocking = reading.exhausted.filter(
    (window) => fresh || (window.resetAt !== undefined && window.resetAt > current),
  );
  if (blocking.length === 0) return { ready: elapsed, classification, evidence: "confirmed" };
  const windowResetAt = earliest(blocking.map((window) => window.resetAt));
  const resetAt =
    windowResetAt === undefined ? structuredResetAt : Math.max(structuredResetAt, windowResetAt);
  return { ready: false, classification: { ...classification, resetAt }, evidence: "confirmed" };
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
    // A structured entry is the provider's own report that this failure hit the limit.
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
    // A structured reset outranks window data, which may omit the limit that was hit.
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

/**
 * Checks a classification against live account data. `ready` means the
 * provider currently has capacity; `evidence` says what the data proved. When
 * the data cannot be read the input comes back unchanged with `ready: false`
 * and `evidence: "unavailable"`; this function never rejects. Billing and
 * transient kinds are not corroborated and report `unavailable`.
 */
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
  // A structured reset in the input is the provider's own report for this failure (for
  // example a child session's Codex entry): it confirms the limit, and another session's
  // branch entry must not override it. Live window data can still delay readiness.
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

const FallbackTierSchema = Type.Object(
  {
    primary: Type.Array(Type.String()),
    secondary: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const ModelFallbacksSchema = Type.Object(
  {
    tiers: Type.Record(Type.String(), FallbackTierSchema),
    lastResort: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const ModelFallbacksOverrideSchema = Type.Object(
  {
    tiers: Type.Optional(Type.Record(Type.String(), FallbackTierSchema)),
    lastResort: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export type ModelFallbacks = Static<typeof ModelFallbacksSchema>;
export type ModelFallbacksOverride = Static<typeof ModelFallbacksOverrideSchema>;

export const MODEL_FALLBACKS_FILE = "model-fallbacks.json";
export const DEFAULT_MODEL_FALLBACKS_PATH = fileURLToPath(
  new URL(`../../${MODEL_FALLBACKS_FILE}`, import.meta.url),
);

async function readJson(path: string): Promise<{ found: boolean; value: RuntimeValue }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { found: false, value: undefined };
    }
    throw error;
  }
  try {
    const value: RuntimeValue = JSON.parse(text);
    return { found: true, value };
  } catch {
    throw new Error(`Malformed JSON in ${path}`);
  }
}

/** Override tiers replace base tiers of the same name; a given `lastResort` replaces the base list. */
export function mergeModelFallbacks(
  base: ModelFallbacks,
  override: ModelFallbacksOverride,
): ModelFallbacks {
  return {
    tiers: { ...base.tiers, ...override.tiers },
    lastResort: override.lastResort ?? base.lastResort,
  };
}

/**
 * Loads the repository fallback table and merges `<agentDir>/model-fallbacks.json`
 * over it. A missing override is ignored; a malformed one is rejected so a typo
 * never silently routes work elsewhere. A missing or malformed base table rejects.
 */
export async function loadModelFallbacks(
  agentDir: string = getAgentDir(),
  basePath: string = DEFAULT_MODEL_FALLBACKS_PATH,
): Promise<ModelFallbacks> {
  const base = await readJson(basePath);
  if (!base.found) throw new Error(`Model fallback table not found: ${basePath}`);
  if (!Value.Check(ModelFallbacksSchema, base.value)) {
    throw new Error(`Invalid model fallback table: ${basePath}`);
  }
  const table = Value.Parse(ModelFallbacksSchema, base.value);
  const overridePath = join(agentDir, MODEL_FALLBACKS_FILE);
  const override = await readJson(overridePath);
  if (!override.found) return table;
  if (!Value.Check(ModelFallbacksOverrideSchema, override.value)) {
    throw new Error(`Invalid model fallback override: ${overridePath}`);
  }
  return mergeModelFallbacks(table, Value.Parse(ModelFallbacksOverrideSchema, override.value));
}

type ModelRef = { provider: string; id: string };

/** Splits `provider/id` at the first slash; ids such as `hf:org/model` keep theirs. */
export function parseModelRef(ref: string): ModelRef | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function refKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

function parseRefs(refs: readonly string[] | undefined): ModelRef[] {
  return (refs ?? []).flatMap((ref) => {
    const parsed = parseModelRef(ref);
    return parsed ? [parsed] : [];
  });
}

/**
 * Ordered fallback candidates for `current`: same-tier primaries on another
 * provider, then same-tier secondaries (another provider first), then the last
 * resort list. A model outside every tier only gets the last resort.
 */
export function fallbackCandidates(table: ModelFallbacks, current: ModelRef): ModelRef[] {
  const currentKey = refKey(current);
  const tier = Object.values(table.tiers).find((entry) =>
    [...entry.primary, ...(entry.secondary ?? [])].includes(currentKey),
  );
  const primary = parseRefs(tier?.primary).filter((ref) => ref.provider !== current.provider);
  const secondary = parseRefs(tier?.secondary);
  const ordered = [
    ...primary,
    ...secondary.filter((ref) => ref.provider !== current.provider),
    ...secondary.filter((ref) => ref.provider === current.provider),
    ...parseRefs(table.lastResort),
  ];
  const seen = new Set<string>([currentKey]);
  return ordered.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type AccountIdResolver = (provider: string) => string;

const defaultAccountId: AccountIdResolver = () => "default";

/**
 * First candidate that is available, allowed by the scoped model list (empty
 * means unrestricted), and whose provider account is not closed. Never returns
 * `current`.
 */
export function pickFallback(
  table: ModelFallbacks,
  current: ModelRef,
  context: FallbackCandidateContext,
  resolveAccountId: AccountIdResolver = defaultAccountId,
): ModelRef | undefined {
  const available = new Set(context.available.map(refKey));
  const scoped = new Set(context.scoped);
  for (const candidate of fallbackCandidates(table, current)) {
    const key = refKey(candidate);
    if (!available.has(key)) continue;
    if (scoped.size > 0 && !scoped.has(key)) continue;
    if (context.isClosed(candidate.provider, resolveAccountId(candidate.provider))) continue;
    return { provider: candidate.provider, id: candidate.id };
  }
  return undefined;
}

export type UsageLimitPolicyOptions = {
  owner: string;
  generation: number;
  readPreference: () => Promise<OnUsageLimit>;
  /** Session context used for quota reads. */
  ctx?: ExtensionContext;
  /** Extension event bus, required to corroborate Synthetic limits. */
  events?: SyntheticQuotaEvents;
  /**
   * Fallback table. When omitted the policy loads it asynchronously and
   * `pickFallback` returns `undefined` until `fallbacksLoaded` resolves.
   */
  fallbacks?: ModelFallbacks;
  /** Overrides the quota reader, mainly for tests. */
  usageSnapshot?: (provider: string) => Promise<ProviderUsageSnapshot | undefined>;
  /** Latest Codex usage-limit entry on the session branch. */
  readCodexEntry?: () => CodexUsageLimitEntry | undefined;
  resolveAccountId?: AccountIdResolver;
  now?: () => number;
};

export type UsageLimitPolicyInstance = Omit<UsageLimitPolicy, "corroborate"> & {
  corroborate(classification: UsageLimitClassification): Promise<UsageLimitCorroboration>;
  accountId(provider: string): string;
  /** Settles once the fallback table is available (or failed to load). */
  fallbacksLoaded: Promise<void>;
};

function closedKey(providerKey: string, accountId: string): string {
  return `${providerKey}\u0000${accountId}`;
}

/** Builds the owner policy the usage-limit seam publishes. */
export function createUsageLimitPolicy(options: UsageLimitPolicyOptions): UsageLimitPolicyInstance {
  const now = options.now ?? Date.now;
  const resolveAccountId = options.resolveAccountId ?? defaultAccountId;
  const closed = new Map<string, number>();
  let fallbacks = options.fallbacks;
  const fallbacksLoaded: Promise<void> = fallbacks
    ? Promise.resolve()
    : loadModelFallbacks().then(
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
      try {
        return await options.readPreference();
      } catch {
        return DEFAULT_ON_USAGE_LIMIT;
      }
    },
    classify(input) {
      return classifyUsageLimit({ ...input, now: now() });
    },
    async corroborate(classification) {
      let codexEntry: CodexUsageLimitEntry | undefined;
      // The Codex entry lives on the owner's branch; it describes only the owner's failures.
      const ownFailure =
        classification.sessionId === undefined || classification.sessionId === options.owner;
      if (ownFailure) {
        try {
          codexEntry = options.readCodexEntry?.();
        } catch {
          codexEntry = undefined;
        }
      }
      return corroborateUsageLimit(
        {
          usageSnapshot: options.usageSnapshot,
          extension: options.ctx,
          events: options.events,
          codexEntry,
          now,
        },
        classification,
      );
    },
    pickFallback(current, context) {
      return fallbacks ? pickFallback(fallbacks, current, context, resolveAccountId) : undefined;
    },
    accountId(provider) {
      return resolveAccountId(provider);
    },
    closeProvider(providerKey, accountId, untilMs) {
      if (Number.isNaN(untilMs)) return;
      closed.set(closedKey(providerKey, accountId), Math.min(untilMs, now() + MAX_CLOSE_MS));
    },
    isClosed(providerKey, accountId, at = now()) {
      const key = closedKey(providerKey, accountId);
      const until = closed.get(key);
      if (until === undefined) return false;
      if (at < until) return true;
      closed.delete(key);
      return false;
    },
  };
}
