import { logLatency } from "../latency-logger.ts";

export const SWEEP_IDLE_SAFETY_MARGIN_MS = 60_000;

let holds = new Map<number, number>();
let nextHoldId = 1;
let idleWaiters: Array<() => void> = [];

function flushIdleWaitersIfEmpty(): void {
  if (holds.size > 0) return;
  if (idleWaiters.length === 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const waiter of waiters) {
    try {
      waiter();
    } catch {}
  }
}

export function getWorkspaceSweepMaxHoldAgeMs(): number {
  return getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS;
}

function reapStaleHolds(): void {
  if (holds.size === 0) return;
  const maxAgeMs = getWorkspaceSweepMaxHoldAgeMs();
  const now = Date.now();
  for (const [holdId, acquiredAt] of holds) {
    const ageMs = now - acquiredAt;
    if (ageMs <= maxAgeMs) continue;
    holds.delete(holdId);
    logLatency({
      type: "phase",
      phase: "lsp_workspace_sweep_hold_force_released",
      filePath: "",
      durationMs: ageMs,
      metadata: { holdId, maxHoldAgeMs: maxAgeMs },
    });
  }
  flushIdleWaitersIfEmpty();
}

export function acquireWorkspaceSweepHold(): () => void {
  const holdId = nextHoldId++;
  holds.set(holdId, Date.now());
  return () => {
    if (!holds.delete(holdId)) return;
    flushIdleWaitersIfEmpty();
  };
}

export function isWorkspaceSweepActive(): boolean {
  reapStaleHolds();
  return holds.size > 0;
}

export function runWhenWorkspaceSweepIdle(cb: () => void): void {
  reapStaleHolds();
  if (holds.size === 0) {
    cb();
    return;
  }
  idleWaiters.push(cb);
}

export function clearWorkspaceSweepHoldForSessionStart(): void {
  if (holds.size === 0) return;
  logLatency({
    type: "phase",
    phase: "lsp_workspace_sweep_hold_session_reset",
    filePath: "",
    durationMs: 0,
    metadata: { clearedHolds: holds.size },
  });
  holds.clear();
  flushIdleWaitersIfEmpty();
}

export function _resetWorkspaceSweepHoldForTests(): void {
  holds = new Map();
  idleWaiters = [];
  nextHoldId = 1;
}

export function getFullScanWallClockMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}
