/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
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

const FINITE_NUMBER_SCHEMA = Type.Number();
const SESSION_ID_SCHEMA = Type.String({ minLength: 1 });

function finiteNumber(value: number | null | undefined): number | null {
  return Value.Check(FINITE_NUMBER_SCHEMA, value) && Number.isFinite(value) ? value : null;
}

/** Settled session cost paired with the stats identity that produced it. */
export function getSessionCostBaseline(
  session: SessionLike | undefined,
): SessionCostBaseline | null {
  if (!session) return null;
  try {
    const stats = session.getSessionStats();
    const cost = finiteNumber(stats.cost);
    return Value.Check(SESSION_ID_SCHEMA, stats.sessionId) && cost !== null && cost >= 0
      ? { sessionId: stats.sessionId, cost }
      : null;
  } catch {
    return null;
  }
}

/** Session cost, optionally reduced by a baseline from the same session. */
export function getSessionCost(
  session: SessionLike | undefined,
  baseline?: SessionCostBaseline,
): number | null {
  const current = getSessionCostBaseline(session);
  if (!current) return null;
  if (!baseline || baseline.sessionId !== current.sessionId) return current.cost;
  return Math.max(0, current.cost - baseline.cost);
}

/** Live context utilization; percent and window are validated independently. */
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

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 *
 * RESETS at compaction — upstream replaces `session.state.messages` and the
 * stats are derived from that array. For a lifetime total that survives
 * compaction, use `getLifetimeTotal(lifetimeUsage)` instead, which reads
 * from an independent accumulator fed by `message_end` events.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch {
    return 0;
  }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  return getSessionContextUsage(session).percent;
}
