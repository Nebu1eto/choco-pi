import { isFiniteNumber, isNonEmptyString } from "./value-guards.ts";

export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
}

export type SessionStatsLike = {
  sessionId?: string;
  tokens: { input: number; output: number; cacheWrite: number };
  cost?: number;
  contextUsage?: { percent: number | null; contextWindow?: number };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

export interface SessionCostBaseline {
  sessionId: string;
  cost: number;
}

export interface SessionContextUsage {
  percent: number | null;
  contextWindow: number | null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

export function getSessionCostBaseline(
  session: SessionLike | undefined,
): SessionCostBaseline | null {
  if (!session) return null;
  try {
    const stats = session.getSessionStats();
    const cost = finiteNumber(stats.cost);
    return isNonEmptyString(stats.sessionId) && cost !== null && cost >= 0
      ? { sessionId: stats.sessionId, cost }
      : null;
  } catch {
    return null;
  }
}

export function getSessionCost(
  session: SessionLike | undefined,
  baseline?: SessionCostBaseline,
): number | null {
  const current = getSessionCostBaseline(session);
  if (!current) return null;
  if (!baseline || baseline.sessionId !== current.sessionId) return current.cost;
  return Math.max(0, current.cost - baseline.cost);
}

export function getSessionContextUsage(
  session: SessionLike | undefined,
  fallbackContextWindow?: number,
): SessionContextUsage {
  const fallback = finiteNumber(fallbackContextWindow);
  const validFallback = fallback !== null && fallback > 0 ? fallback : null;
  if (!session) return { percent: null, contextWindow: validFallback };
  try {
    const usage = session.getSessionStats().contextUsage;
    const percent = finiteNumber(usage?.percent);
    const contextWindow = finiteNumber(usage?.contextWindow);
    return {
      percent,
      contextWindow: contextWindow !== null && contextWindow > 0 ? contextWindow : validFallback,
    };
  } catch {
    return { percent: null, contextWindow: validFallback };
  }
}

export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch {
    return 0;
  }
}

export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  return getSessionContextUsage(session).percent;
}
