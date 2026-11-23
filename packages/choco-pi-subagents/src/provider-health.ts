import { scopeCoversModel, scopeKey, scopeNote } from "./usage-limit-seam.ts";
import type { UsageLimitScope } from "./usage-limit-seam.ts";

export type TerminalProviderFailure = "rate_limit" | "overloaded";

type ProviderHealth = {
  consecutiveTerminal: number;
  closedUntil?: number;
};

export type UsageLimitClosure = {
  until: number;
  suggestedModel?: string;
  closedAt?: number;
  detail?: string;
  scope?: UsageLimitScope;
};

export type UsageLimitClosureKey = {
  owner: string;
  providerKey: string;
  accountId: string;
  scope?: UsageLimitScope;
};

export type TerminalFailureInput = string | Error;

const MIN_CLOSED_MS = 30_000;
const MAX_CLOSED_MS = 300_000;
export const MAX_USAGE_LIMIT_CLOSED_MS = 24 * 60 * 60 * 1_000;
const registry = new Map<string, ProviderHealth>();
const usageClosures = new Map<string, UsageLimitClosure & UsageLimitClosureKey>();

function closureKey(key: UsageLimitClosureKey): string {
  return `${key.owner}\u0000${key.providerKey}\u0000${key.accountId}\u0000${scopeKey(key.scope)}`;
}

function failureText(failure: TerminalFailureInput): string {
  return failure instanceof Error ? `${failure.name}: ${failure.message}` : failure;
}

export function classifyTerminalFailure(
  failure: TerminalFailureInput,
): TerminalProviderFailure | undefined {
  const text = failureText(failure);
  if (/rate_limit_error|(?<![\w,.])429(?!\d|,\d|[\w.])/i.test(text)) return "rate_limit";
  if (/overloaded_error/i.test(text)) return "overloaded";
  return undefined;
}

export function retryAfterMsFromFailure(failure: TerminalFailureInput): number | undefined {
  const text = failureText(failure);
  const match = text.match(/retry-after["'\s:=]+(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  const milliseconds = Number(match[1]) * 1_000;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function healthKey(providerKey: string, modelId: string | undefined): string {
  return `${providerKey}\u0000${modelId ?? ""}`;
}

function closedNow(key: string, now: number): boolean {
  const health = registry.get(key);
  if (health?.closedUntil === undefined) return false;
  if (now < health.closedUntil) return true;
  health.closedUntil = undefined;
  return false;
}

export function isAvailable(providerKey: string, now = Date.now(), modelId?: string): boolean {
  if (closedNow(healthKey(providerKey, undefined), now)) return false;
  return modelId === undefined || !closedNow(healthKey(providerKey, modelId), now);
}

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

export type BlockingUsageLimitClosure = {
  key: UsageLimitClosureKey;
  closure: UsageLimitClosure;
};

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

export function clearUsageLimitClosure(key: UsageLimitClosureKey): void {
  usageClosures.delete(closureKey(key));
}

export function transientBlockLevel(
  providerKey: string,
  modelId: string | undefined,
  now = Date.now(),
): "provider" | "model" | undefined {
  if (closedNow(healthKey(providerKey, undefined), now)) return "provider";
  if (modelId !== undefined && closedNow(healthKey(providerKey, modelId), now)) return "model";
  return undefined;
}

export function recordFailure(
  providerKey: string,
  _kind: TerminalProviderFailure,
  retryAfterMs?: number,
  modelId?: string,
): void {
  const key = healthKey(providerKey, modelId);
  const health = registry.get(key) ?? { consecutiveTerminal: 0 };
  health.consecutiveTerminal++;
  const exponentialMs = MIN_CLOSED_MS * 2 ** Math.min(health.consecutiveTerminal - 1, 3);
  const requestedMs = Math.max(MIN_CLOSED_MS, retryAfterMs ?? 0, exponentialMs);
  health.closedUntil = Date.now() + Math.min(MAX_CLOSED_MS, requestedMs);
  registry.set(key, health);
}

export function recordSuccess(providerKey: string, modelId?: string): void {
  if (modelId !== undefined) {
    registry.delete(healthKey(providerKey, modelId));
    registry.delete(healthKey(providerKey, undefined));
    return;
  }
  const prefix = `${providerKey}\u0000`;
  for (const key of registry.keys()) if (key.startsWith(prefix)) registry.delete(key);
}

export function resetProviderHealth(providerKey: string): void {
  recordSuccess(providerKey);
  for (const [id, closure] of usageClosures) {
    if (closure.providerKey === providerKey) usageClosures.delete(id);
  }
}

const UNAVAILABLE_PREFIX = "unavailable (temporarily rate limited).";

export function providerUnavailableMessage(
  providerKey: string,
  closure?: UsageLimitClosure,
  modelId?: string,
  modelOnly?: boolean,
): string {
  const scoped = closure?.scope !== undefined && modelId !== undefined;
  const modelLevel =
    modelId !== undefined &&
    (modelOnly ??
      (scoped || (closure === undefined && transientBlockLevel(providerKey, modelId) === "model")));
  const base = modelLevel
    ? `Model ${providerKey}/${modelId} ${UNAVAILABLE_PREFIX}`
    : `Provider ${providerKey} ${UNAVAILABLE_PREFIX}`;
  if (closure === undefined) return base;
  const suggestion =
    closure.suggestedModel === undefined ? "" : `; suggested: ${closure.suggestedModel}`;
  const detail = closure.detail === undefined ? "" : `; ${closure.detail}`;
  const covers = modelLevel ? scopeNote(closure.scope) : "";
  return `${base} Usage limit until ${new Date(closure.until).toISOString()}${covers}${suggestion}${detail}.`;
}

export function providerKeyFromUnavailableMessage(message: string | undefined): string | undefined {
  return message?.match(
    /^(?:Provider|Model) (.+?) unavailable \(temporarily rate limited\)\.(?: Usage limit until [^\n]*)?$/,
  )?.[1];
}

export class ProviderUnavailableError extends Error {
  readonly providerKey: string;

  constructor(
    providerKey: string,
    closure?: UsageLimitClosure,
    modelId?: string,
    modelOnly?: boolean,
  ) {
    super(providerUnavailableMessage(providerKey, closure, modelId, modelOnly));
    this.name = "ProviderUnavailableError";
    this.providerKey = providerKey;
  }
}
