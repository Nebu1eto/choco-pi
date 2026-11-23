import { recordDegradationOnce } from "./degradation-ledger.ts";
import { toPositiveFinite } from "./env-utils.ts";
import { isQuietWindowEnabled, quietWindowWaitMs } from "./quiet-window-config.ts";
import { RUNTIME_CONFIG } from "./runtime-config.ts";

export function cascadeSettleWaitMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_CASCADE_SETTLE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

const MIN_NEIGHBOUR_BUDGET = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

const DEFAULT_NEIGHBOUR_BUDGET = 40;

export const CASCADE_NEIGHBOUR_BUDGET = Math.max(
  MIN_NEIGHBOUR_BUDGET,
  Number.parseInt(process.env.CHOCO_PI_LSP_CASCADE_NEIGHBOUR_BUDGET ?? "40", 10) ||
    DEFAULT_NEIGHBOUR_BUDGET,
);

const NEIGHBOUR_BUDGET_OVERRIDDEN =
  process.env.CHOCO_PI_LSP_CASCADE_NEIGHBOUR_BUDGET !== undefined &&
  CASCADE_NEIGHBOUR_BUDGET !== DEFAULT_NEIGHBOUR_BUDGET;

const DEFAULT_NEIGHBOUR_COST_MS = 100;

function neighbourCostMs(): number {
  return (
    toPositiveFinite(process.env.CHOCO_PI_LSP_CASCADE_NEIGHBOUR_COST_MS) ||
    DEFAULT_NEIGHBOUR_COST_MS
  );
}

function neighbourFloor(): number {
  return toPositiveFinite(process.env.CHOCO_PI_LSP_CASCADE_NEIGHBOUR_FLOOR) || MIN_NEIGHBOUR_BUDGET;
}

export type CascadeBudgetZone = "fits" | "narrowed" | "past-rescue" | "no-rescue-window";

export interface CascadeBudgetDecision {
  budget: number;
  ceiling: number;
  remainingMs: number;
  zone: CascadeBudgetZone;
  deliveryWindowMs: number;
}

export function deriveCascadeNeighbourBudget(options: {
  elapsedMs: number;
  settleWaitMs?: number;
  quietDrainMs?: number;
  ceiling?: number;
  floor?: number;
  perNeighbourMs?: number;
}): CascadeBudgetDecision {
  const ceiling = options.ceiling ?? CASCADE_NEIGHBOUR_BUDGET;
  const floor = Math.min(ceiling, options.floor ?? neighbourFloor());
  const onTimeMs = options.settleWaitMs ?? cascadeSettleWaitMs();
  const perNeighbourMs = options.perNeighbourMs ?? neighbourCostMs();
  const elapsedMs = toPositiveFinite(options.elapsedMs);
  const remainingMs = onTimeMs - elapsedMs;
  const deliveryWindowMs =
    onTimeMs + (options.quietDrainMs ?? (isQuietWindowEnabled() ? quietWindowWaitMs() : 0));
  const full = { budget: ceiling, ceiling, remainingMs, deliveryWindowMs };

  if (onTimeMs <= 0 || onTimeMs < ceiling * perNeighbourMs) {
    if (options.ceiling === undefined && NEIGHBOUR_BUDGET_OVERRIDDEN) {
      recordDegradationOnce({
        kind: "cascade-budget-override-disarmed",
        subject: "cascade-neighbour-budget",
        reason:
          `CHOCO_PI_LSP_CASCADE_NEIGHBOUR_BUDGET=${CASCADE_NEIGHBOUR_BUDGET} needs ` +
          `${ceiling * perNeighbourMs}ms to walk the full cap, which exceeds ` +
          `the ${onTimeMs}ms settle window — the rescue band is disarmed and ` +
          `every cascade keeps the flat (overridden) cap`,
      });
    }
    return { ...full, zone: "no-rescue-window" };
  }
  if (remainingMs >= ceiling * perNeighbourMs) {
    return { ...full, zone: "fits" };
  }
  if (remainingMs < floor * perNeighbourMs) {
    return { ...full, zone: "past-rescue" };
  }
  return {
    budget: Math.min(ceiling, Math.max(floor, Math.floor(remainingMs / perNeighbourMs))),
    ceiling,
    remainingMs,
    deliveryWindowMs,
    zone: "narrowed",
  };
}
