/**
 * Per-session handoff of structured Codex usage-limit data from the provider stream to the
 * extension's `message_end` handler. The provider records a signal just before it emits the
 * terminal error event; the extension drains it for the same session id and persists it as a
 * custom session entry. `resetAt` and `observedAt` are epoch milliseconds.
 */
export type UsageLimitSignal = {
  resetAt?: number;
  planType?: string;
  accountId?: string;
  observedAt: number;
};

export type UsageLimitSignalInput = {
  resetAt?: number | undefined;
  planType?: string | undefined;
  accountId?: string | undefined;
  observedAt?: number | undefined;
};

export const USAGE_LIMIT_SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;

const signals = new Map<string, UsageLimitSignal>();

function isStale(signal: UsageLimitSignal, now: number): boolean {
  return now - signal.observedAt > USAGE_LIMIT_SIGNAL_MAX_AGE_MS;
}

export function recordUsageLimitSignal(
  sessionId: string,
  input: UsageLimitSignalInput,
  now: number = Date.now(),
): void {
  for (const [id, signal] of signals) {
    if (isStale(signal, now)) signals.delete(id);
  }
  const signal: UsageLimitSignal = { observedAt: input.observedAt ?? now };
  if (input.resetAt !== undefined && Number.isFinite(input.resetAt)) signal.resetAt = input.resetAt;
  if (input.planType !== undefined) signal.planType = input.planType;
  if (input.accountId !== undefined) signal.accountId = input.accountId;
  signals.set(sessionId, signal);
}

/** Drain the signal for `sessionId`; stale signals are discarded instead of returned. */
export function takeUsageLimitSignal(
  sessionId: string,
  now: number = Date.now(),
): UsageLimitSignal | undefined {
  const signal = signals.get(sessionId);
  if (!signal) return undefined;
  signals.delete(sessionId);
  return isStale(signal, now) ? undefined : signal;
}

export function clearUsageLimitSignal(sessionId: string): void {
  signals.delete(sessionId);
}
