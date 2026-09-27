export type TerminalProviderFailure = "rate_limit" | "overloaded";

type ProviderHealth = {
  consecutiveTerminal: number;
  closedUntil?: number;
};

/** Metadata carried by a usage-limit closure for spawn-refusal text. */
export type UsageLimitClosure = {
  until: number;
  suggestedModel?: string;
};

/**
 * Usage-limit closures belong to one root owner's provider account. They are
 * kept apart from the process-global transient registry so a limit under one
 * owner or account never blocks another.
 */
export type UsageLimitClosureKey = {
  owner: string;
  providerKey: string;
  accountId: string;
};

export type TerminalFailureInput = string | Error;

const MIN_CLOSED_MS = 30_000;
const MAX_CLOSED_MS = 300_000;
/** Upper bound for one usage-limit closure; a later closure may extend it again. */
export const MAX_USAGE_LIMIT_CLOSED_MS = 24 * 60 * 60 * 1_000;
const registry = new Map<string, ProviderHealth>();
const usageClosures = new Map<string, UsageLimitClosure & UsageLimitClosureKey>();

function closureKey(key: UsageLimitClosureKey): string {
  return `${key.owner}\u0000${key.providerKey}\u0000${key.accountId}`;
}

function failureText(failure: TerminalFailureInput): string {
  return failure instanceof Error ? `${failure.name}: ${failure.message}` : failure;
}

/** Classify only terminal provider capacity failures (after Pi's bounded retries). */
export function classifyTerminalFailure(
  failure: TerminalFailureInput,
): TerminalProviderFailure | undefined {
  const text = failureText(failure);
  if (/rate_limit_error|(?<![\w,.])429(?!\d|,\d|[\w.])/i.test(text)) return "rate_limit";
  if (/overloaded_error/i.test(text)) return "overloaded";
  return undefined;
}

/** Read a surfaced Retry-After value expressed in seconds. */
export function retryAfterMsFromFailure(failure: TerminalFailureInput): number | undefined {
  const text = failureText(failure);
  const match = text.match(/retry-after["'\s:=]+(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  const milliseconds = Number(match[1]) * 1_000;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/** Transient (process-global, provider-keyed) availability. */
export function isAvailable(providerKey: string, now = Date.now()): boolean {
  const health = registry.get(providerKey);
  if (health?.closedUntil === undefined) return true;
  if (now < health.closedUntil) return false;
  health.closedUntil = undefined;
  return true;
}

/** Active usage-limit closure for one owner's provider account, if any. */
export function usageLimitClosure(
  key: UsageLimitClosureKey,
  now = Date.now(),
): UsageLimitClosure | undefined {
  const id = closureKey(key);
  const closure = usageClosures.get(id);
  if (closure === undefined) return undefined;
  if (now >= closure.until) {
    usageClosures.delete(id);
    return undefined;
  }
  return { until: closure.until, suggestedModel: closure.suggestedModel };
}

/**
 * Close one owner's provider account until a usage-limit reset (capped at
 * 24 h from now). Never shortens an existing closure; the latest suggestion wins.
 */
export function closeUntil(
  key: UsageLimitClosureKey,
  untilMs: number,
  details: { suggestedModel?: string } = {},
): number {
  const now = Date.now();
  const requested = Number.isFinite(untilMs) ? untilMs : now + MIN_CLOSED_MS;
  const until = Math.max(now, Math.min(requested, now + MAX_USAGE_LIMIT_CLOSED_MS));
  const previous = usageLimitClosure(key, now);
  const effectiveUntil = previous !== undefined && previous.until > until ? previous.until : until;
  usageClosures.set(closureKey(key), {
    ...key,
    until: effectiveUntil,
    suggestedModel: details.suggestedModel,
  });
  return effectiveUntil;
}

/** Drop one usage-limit closure once the owner's policy confirms the window reset. */
export function clearUsageLimitClosure(key: UsageLimitClosureKey): void {
  usageClosures.delete(closureKey(key));
}

export function recordFailure(
  providerKey: string,
  _kind: TerminalProviderFailure,
  retryAfterMs?: number,
): void {
  const health = registry.get(providerKey) ?? { consecutiveTerminal: 0 };
  health.consecutiveTerminal++;
  const exponentialMs = MIN_CLOSED_MS * 2 ** Math.min(health.consecutiveTerminal - 1, 3);
  const requestedMs = Math.max(MIN_CLOSED_MS, retryAfterMs ?? 0, exponentialMs);
  health.closedUntil = Date.now() + Math.min(MAX_CLOSED_MS, requestedMs);
  registry.set(providerKey, health);
}

export function recordSuccess(providerKey: string): void {
  registry.delete(providerKey);
}

/** Test and reset hook: drop the transient state and every owner's usage-limit closure for a provider. */
export function resetProviderHealth(providerKey: string): void {
  registry.delete(providerKey);
  for (const [id, closure] of usageClosures) {
    if (closure.providerKey === providerKey) usageClosures.delete(id);
  }
}

const UNAVAILABLE_PREFIX = "unavailable (temporarily rate limited).";

/** Refusal text; a usage-limit closure adds the reset time and suggestion. */
export function providerUnavailableMessage(
  providerKey: string,
  closure?: UsageLimitClosure,
): string {
  const base = `Provider ${providerKey} ${UNAVAILABLE_PREFIX}`;
  if (closure === undefined) return base;
  const suggestion =
    closure.suggestedModel === undefined ? "" : `; suggested: ${closure.suggestedModel}`;
  return `${base} Usage limit until ${new Date(closure.until).toISOString()}${suggestion}.`;
}

/** Provider key named by a ProviderUnavailableError message, with or without the usage-limit suffix. */
export function providerKeyFromUnavailableMessage(message: string | undefined): string | undefined {
  return message?.match(
    /^Provider (.+?) unavailable \(temporarily rate limited\)\.(?: Usage limit until [^\n]*)?$/,
  )?.[1];
}

export class ProviderUnavailableError extends Error {
  readonly providerKey: string;

  constructor(providerKey: string, closure?: UsageLimitClosure) {
    super(providerUnavailableMessage(providerKey, closure));
    this.name = "ProviderUnavailableError";
    this.providerKey = providerKey;
  }
}
