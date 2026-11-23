import type { DegradationKind } from "./degradation-ledger.ts";
import { incrementDegradationCount } from "./degradation-ledger.ts";
import { type LatencyEntry, logLatency } from "./latency-logger.ts";

export const BOUNDED_TELEMETRY_PHASES = [
  "agent_end_deferred_format_orphan_origin_mismatch",
  "lsp_pull_diagnostic_timeout",
  "lsp_pull_late_answer_discarded",
  "lsp_pull_skipped_budget_exhausted",
  "lsp_pull_late_rejection",
  "lsp_nav_request_timeout",
  "lsp_nav_late_answer_discarded",
  "lsp_client_skipped_broken",
  "lsp_client_skipped_unavailable_command",
  "loop_block",
] as const;

export type BoundedPhase = (typeof BOUNDED_TELEMETRY_PHASES)[number];

const REGISTERED_PHASES: ReadonlySet<string> = new Set(BOUNDED_TELEMETRY_PHASES);

export function isBoundedTelemetryPhase(phase: string): phase is BoundedPhase {
  return REGISTERED_PHASES.has(phase);
}

export interface TurnCap {
  limit: number;
  turnIndex: number;
}

interface BoundedTelemetryCommon {
  reason?: string;
  capPerTurn?: TurnCap;
}

export type BoundedTelemetryOptions = BoundedTelemetryCommon &
  (
    | {
        ledgerKind?: DegradationKind;
        risingEdgePer?: never;
      }
    | { ledgerKind: DegradationKind; risingEdgePer: "identity" }
  );

export type BoundedTelemetryPayload = Omit<
  LatencyEntry,
  "phase" | "filePath" | "ts" | "pid" | "type"
> & {
  filePath?: string;
  type?: LatencyEntry["type"];
};

let turnCounts = new Map<string, number>();
let countedTurnIndex: number | undefined;

export function admitBounded(
  phase: BoundedPhase,
  identity: string,
  options: BoundedTelemetryOptions = {},
): boolean {
  try {
    let isRisingEdge = true;
    if (options.ledgerKind !== undefined) {
      isRisingEdge = incrementDegradationCount({
        kind: options.ledgerKind,
        subject: identity,
        reason: options.reason ?? phase,
      });
    }
    if (options.risingEdgePer !== undefined && !isRisingEdge) return false;
    return admitAgainstTurnCap(phase, options.capPerTurn);
  } catch {
    return true;
  }
}

export function emitBounded(
  phase: BoundedPhase,
  identity: string,
  payload: BoundedTelemetryPayload,
  options: BoundedTelemetryOptions = {},
): boolean {
  try {
    if (!admitBounded(phase, identity, options)) return false;
    logLatency({
      ...payload,
      type: payload.type ?? "phase",
      phase,
      filePath: payload.filePath ?? identity,
      metadata: { ...payload.metadata, identity },
    });
    return true;
  } catch {
    return false;
  }
}

function admitAgainstTurnCap(phase: string, cap: BoundedTelemetryOptions["capPerTurn"]): boolean {
  if (cap === undefined) return true;
  if (countedTurnIndex !== cap.turnIndex) {
    turnCounts = new Map();
    countedTurnIndex = cap.turnIndex;
  }
  const used = turnCounts.get(phase) ?? 0;
  if (used >= cap.limit) return false;
  turnCounts.set(phase, used + 1);
  return true;
}

export function resetBoundedTelemetry(): void {
  turnCounts = new Map();
  countedTurnIndex = undefined;
}

export function _boundedTurnCountForTest(phase: string): number {
  return turnCounts.get(phase) ?? 0;
}
