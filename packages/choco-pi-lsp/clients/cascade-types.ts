import type { Diagnostic } from "./dispatch/types.ts";
import type { CascadeIndeterminate, ImpactCascadeResult } from "./review-graph/types.ts";

export type { CascadeIndeterminate };

export interface CascadeNeighborResult {
  filePath: string;
  reason: "imports" | "calls" | "references" | "fallback";
  diagnostics: Diagnostic[];
  lspTouched: boolean;
  inconclusive?: boolean;
  unconfirmedServerIds?: string[];
  durationMs?: number;
}

export interface CascadeResult {
  filePath: string;
  impact: ImpactCascadeResult;
  neighbors: CascadeNeighborResult[];
  formatted: string;
}

export type CascadeSkipReason =
  | "blockers"
  | "non_code"
  | "no_neighbors"
  | "clean"
  | "indeterminate"
  | "error";

export interface CascadeRun {
  filePath: string;
  origin?: { turnSeq?: number; writeSeq?: number; projectSeq?: number };
  result: CascadeResult | undefined;
  neighborCount: number;
  diagnosticCount: number;
  selectedNeighborPaths?: string[];
  skipReason?: CascadeSkipReason;
  indeterminate?: CascadeIndeterminate;
  carriedTurns?: number;
}
