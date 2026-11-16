import { scopeCoversModel, scopeKey, scopeNote } from "./usage-limit-seam.ts";
import type { UsageLimitScope } from "./usage-limit-seam.ts";

export type TerminalProviderFailure = "rate_limit" | "overloaded";

type ProviderHealth = {
  consecutiveTerminal: number;
  closedUntil?: number;
};

/** Metadata carried by a usage-limit closure for spawn-refusal text. */
export type UsageLimitClosure = {
  until: number;
  suggestedModel?: string;
  /** When the latest failure wrote this closure; evidence older than it proves nothing. */
  closedAt?: number;
  /** What the latest live re-check found, for refusal text. */
  detail?: string;
  /** Models the closure covers; absent: every model on the provider account. */
  scope?: UsageLimitScope;
};

/**
 * Usage-limit closures belong to one root owner's provider account. They are
 * kept apart from the process-global transient registry so a limit under one
 * owner or account never blocks another. `scope` narrows a closure to the
 * models a model-scoped limit covers; each scope is a separate closure.
 */
export type UsageLimitClosureKey = {
  owner: string;
  providerKey: string;
  accountId: string;
  scope?: UsageLimitScope;
};

export type TerminalFailureInput = string | Error;

const MIN_CLOSED_MS = 30_000;
const MAX_CLOSED_MS = 300_000;
/** Upper bound for one usage-limit closure; a later closure may extend it again. */
export const MAX_USAGE_LIMIT_CLOSED_MS = 24 * 60 * 60 * 1_000;
const registry = new Map<string, ProviderHealth>();
const usageClosures = new Map<string, UsageLimitClosure & UsageLimitClosureKey>();

function closureKey(key: UsageLimitClosureKey): string {
  return `${key.owner}\u0000${key.providerKey}\u0000${key.accountId}\u0000${scopeKey(key.scope)}`;
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

/** Active usage-limit closure under exactly `key` (account and scope), if any. */
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
  return closureView(closure);
}

function closureView(closure: UsageLimitClosure): UsageLimitClosure {
  const view: UsageLimitClosure = {
    until: closure.until,
    suggestedModel: closure.suggestedModel,
    closedAt: closure.closedAt,
    detail: closure.detail,
  };
  if (closure.scope !== undefined) view.scope = closure.scope;
  return view;
}

/** An active closure that blocks a model, with the key it is stored under. */
export type BlockingUsageLimitClosure = {
  key: UsageLimitClosureKey;
  closure: UsageLimitClosure;
};

/**
 * Active closures on one owner's provider account that block `modelId`: the
 * provider-wide closure and, with `modelId`, every scoped closure covering it.
 * Without `modelId` only the provider-wide closure counts.
 */
export function usageLimitClosuresFor(
  account: Omit<UsageLimitClosureKey, "scope">,
  modelId: string | undefined,
  now = Date.now(),
): BlockingUsageLimitClosure[] {
  const result: BlockingUsageLimitClosure[] = [];
  for (const [id, closure] of usageClosures) {
    if (
      closure.owner !== account.owner ||
      closure.providerKey !== account.providerKey ||
      closure.accountId !== account.accountId
    ) {
      continue;
    }
    if (now >= closure.until) {
      usageClosures.delete(id);
      continue;
    }
    if (closure.scope !== undefined) {
      if (modelId === undefined || !scopeCoversModel(closure.scope, modelId)) continue;
    }
    const key: UsageLimitClosureKey = { ...account };
    if (closure.scope !== undefined) key.scope = closure.scope;
    result.push({ key, closure: closureView(closure) });
  }
  return result;
}

/**
 * The closure to report for `modelId`: the provider-wide closure when there is
 * one, else the covering scoped closure that ends last.
 */
export function blockingUsageLimitClosure(
  account: Omit<UsageLimitClosureKey, "scope">,
  modelId: string | undefined,
  now = Date.now(),
): UsageLimitClosure | undefined {
  let chosen: UsageLimitClosure | undefined;
  for (const { closure } of usageLimitClosuresFor(account, modelId, now)) {
    if (closure.scope === undefined) return closure;
    if (chosen === undefined || closure.until > chosen.until) chosen = closure;
  }
  return chosen;
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
  const closure: UsageLimitClosure & UsageLimitClosureKey = {
    ...key,
    until: effectiveUntil,
    suggestedModel: details.suggestedModel,
    closedAt: now,
  };
  if (key.scope === undefined) delete closure.scope;
  usageClosures.set(closureKey(key), closure);
  return effectiveUntil;
}

/**
 * Record a live re-check that found the limit still in force: the closure ends
 * at `untilMs` when the reading names a reset (capped at 24 h, and possibly
 * earlier than before), keeps its end otherwise, and carries `detail`. A
 * closure that does not exist yet is created, keeping `closedAt` unset so a
 * later failure is still newer evidence.
 */
export function confirmUsageLimitClosure(
  key: UsageLimitClosureKey,
  untilMs: number | undefined,
  detail: string | undefined,
): void {
  const now = Date.now();
  const previous = usageClosures.get(closureKey(key));
  const until =
    untilMs !== undefined && Number.isFinite(untilMs)
      ? Math.min(untilMs, now + MAX_USAGE_LIMIT_CLOSED_MS)
      : previous?.until;
  if (until === undefined || until <= now) return;
  const closure: UsageLimitClosure & UsageLimitClosureKey = {
    ...key,
    until,
    suggestedModel: previous?.suggestedModel,
    closedAt: previous?.closedAt,
    detail,
  };
  if (key.scope === undefined) delete closure.scope;
  usageClosures.set(closureKey(key), closure);
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

/**
 * Refusal text; a usage-limit closure adds the reset time and suggestion. A
 * closure scoped to some models names the refused model (`Model
 * <provider>/<id>`) and what the limit covers, so callers can see the
 * provider's other models stay available.
 */
export function providerUnavailableMessage(
  providerKey: string,
  closure?: UsageLimitClosure,
  modelId?: string,
): string {
  const scoped = closure?.scope !== undefined && modelId !== undefined;
  const base = scoped
    ? `Model ${providerKey}/${modelId} ${UNAVAILABLE_PREFIX}`
    : `Provider ${providerKey} ${UNAVAILABLE_PREFIX}`;
  if (closure === undefined) return base;
  const suggestion =
    closure.suggestedModel === undefined ? "" : `; suggested: ${closure.suggestedModel}`;
  const detail = closure.detail === undefined ? "" : `; ${closure.detail}`;
  const covers = scoped ? scopeNote(closure.scope) : "";
  return `${base} Usage limit until ${new Date(closure.until).toISOString()}${covers}${suggestion}${detail}.`;
}

/**
 * Gate key named by a ProviderUnavailableError message, with or without the
 * usage-limit suffix: `<provider>` for a provider refusal, `<provider>/<id>`
 * for a model refused by a model-scoped limit.
 */
export function providerKeyFromUnavailableMessage(message: string | undefined): string | undefined {
  return message?.match(
    /^(?:Provider|Model) (.+?) unavailable \(temporarily rate limited\)\.(?: Usage limit until [^\n]*)?$/,
  )?.[1];
}

export class ProviderUnavailableError extends Error {
  readonly providerKey: string;

  constructor(providerKey: string, closure?: UsageLimitClosure, modelId?: string) {
    super(providerUnavailableMessage(providerKey, closure, modelId));
    this.name = "ProviderUnavailableError";
    this.providerKey = providerKey;
  }
}
