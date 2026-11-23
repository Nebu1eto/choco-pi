import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";

const CASCADE_LOG_DIR = getGlobalPiLensDir();
const CASCADE_LOG_FILE = path.join(CASCADE_LOG_DIR, "cascade.log");

const writer = createNdjsonLogger({
  filePath: CASCADE_LOG_FILE,
  maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

type CascadeMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CascadeMetadataValue[]
  | { [key: string]: CascadeMetadataValue };

export interface CascadeLogEntry {
  ts?: string;
  phase:
    | "cascade_skip"
    | "graph_build"
    | "reverse_deps_cache"
    | "neighbors_computed"
    | "neighbor_touch"
    | "neighbor_snapshot"
    | "neighbor_fallback"
    | "cascade_result"
    | "cascade_turn_end"
    | "cascade_indeterminate"
    | "cascade_tier3_skip"
    | "cascade_tier3_reconcile"
    | "cascade_carry_over_drop"
    | "cascade_injected"
    | "cascade_test_targets";
  filePath: string;
  neighborFile?: string;
  reason?: string;

  graphBuiltMs?: number;
  graphReused?: boolean;
  graphNodeCount?: number;
  graphFileCount?: number;
  graphChangedSymbolCount?: number;

  neighborCount?: number;
  totalNeighborCount?: number;
  importerCount?: number;
  callerCount?: number;
  referenceCount?: number;
  riskFlags?: string[];

  snapshotMissing?: boolean;
  snapshotAgeSec?: number;

  lspServerCount?: number;
  touchedCount?: number;
  snapshotCount?: number;
  coldSnapshot?: boolean;

  fallbackUsed?: boolean;
  diagnosticCount?: number;
  durationMs?: number;
  autoPropagate?: boolean;
  lspTouched?: boolean;
  error?: string;
  metadata?: Record<string, CascadeMetadataValue>;
}

export function logCascade(entry: CascadeLogEntry): void {
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getCascadeLogPath(): string {
  return CASCADE_LOG_FILE;
}

export function flushCascadeLog(): Promise<void> {
  return writer.flush();
}
