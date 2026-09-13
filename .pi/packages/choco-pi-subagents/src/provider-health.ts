export type TerminalProviderFailure = "rate_limit" | "overloaded";

type ProviderHealth = {
  consecutiveTerminal: number;
  closedUntil?: number;
};

export type TerminalFailureInput = string | Error;

const MIN_CLOSED_MS = 30_000;
const MAX_CLOSED_MS = 300_000;
const registry = new Map<string, ProviderHealth>();

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

export function isAvailable(providerKey: string, now = Date.now()): boolean {
  const health = registry.get(providerKey);
  if (health?.closedUntil === undefined) return true;
  if (now < health.closedUntil) return false;
  health.closedUntil = undefined;
  return true;
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

export class ProviderUnavailableError extends Error {
  readonly providerKey: string;

  constructor(providerKey: string) {
    super(`Provider ${providerKey} unavailable (temporarily rate limited).`);
    this.name = "ProviderUnavailableError";
    this.providerKey = providerKey;
  }
}
