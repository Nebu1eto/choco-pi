import { assignOptionalProperties } from "./optional-properties.ts";
import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";
import type { ReviewGraph, ReviewGraphPersistCoverage } from "./review-graph/types.ts";

const REVIEW_GRAPH_LOG_DIR = getGlobalPiLensDir();
const REVIEW_GRAPH_LOG_FILE = path.join(REVIEW_GRAPH_LOG_DIR, "review-graph.log");

const writer = createNdjsonLogger({ filePath: REVIEW_GRAPH_LOG_FILE });

export type ReviewGraphBuildMode = "full" | "cached" | "incremental" | "skipped" | "seq-fastpath";

export interface ReviewGraphBuildMetadata {
  buildId?: number;
  graphGeneration?: number;
  builtAt?: string;
  projectSeq?: number;
  seqHint?: boolean;
  mode?: ReviewGraphBuildMode;
  sourceFiles?: number;
  sourceFilesTruncated?: boolean;
  nodes: number;
  edges: number;
  persistCoverage?: ReviewGraphPersistCoverage;
}

export interface ReviewGraphPersistenceMetadata {
  generation: number;
  attemptId: number;
  status: "scheduled" | "succeeded" | "failed" | "fallback" | "superseded";
  supersededGeneration?: number;
  supersededByGeneration?: number;
  coalesced?: boolean;
  reason?: string;
  workerStarted?: boolean;
  workerCompleted?: boolean;
  workerFallback?: boolean;
}

export interface ReviewGraphOperationalMetadata {
  graph?: ReviewGraphBuildMetadata;
  persistence?: ReviewGraphPersistenceMetadata;
}

export interface ReviewGraphBuildMetadataOptions {
  buildId?: number;
  projectSeq?: number;
  seqHint?: boolean;
  mode?: ReviewGraphBuildMode;
  sourceFileCount?: number;
  sourceFileCountTruncated?: boolean;
}

export function makeReviewGraphBuildMetadata(
  graph: Pick<
    ReviewGraph,
    "buildGeneration" | "builtAt" | "nodes" | "edges" | "fileNodes" | "persistCoverage"
  >,
  options: ReviewGraphBuildMetadataOptions = {},
): ReviewGraphBuildMetadata {
  return assignOptionalProperties(
    Object.assign(
      assignOptionalProperties(
        Object.assign(
          assignOptionalProperties(
            assignOptionalProperties(
              assignOptionalProperties(
                Object.assign(
                  assignOptionalProperties(
                    assignOptionalProperties({}, !(options.buildId === undefined), () => ({
                      buildId: options.buildId,
                    })),
                    !(graph.buildGeneration === undefined),
                    () => ({ graphGeneration: graph.buildGeneration }),
                  ),
                  { builtAt: graph.builtAt },
                ),
                !(options.projectSeq === undefined),
                () => ({ projectSeq: options.projectSeq }),
              ),
              !(options.seqHint === undefined),
              () => ({ seqHint: options.seqHint }),
            ),
            !(options.mode === undefined),
            () => ({ mode: options.mode }),
          ),
          { sourceFiles: options.sourceFileCount ?? graph.fileNodes.size },
        ),
        options.sourceFileCountTruncated || graph.persistCoverage?.sourceFilesTruncated,
        () => ({ sourceFilesTruncated: true }),
      ),
      { nodes: graph.nodes.size, edges: graph.edges.length },
    ),
    graph.persistCoverage,
    () => ({ persistCoverage: graph.persistCoverage }),
  );
}

export interface ReviewGraphLogEntry {
  ts?: string;
  pid?: number;
  phase:
    | "build_started"
    | "build_succeeded"
    | "build_skipped"
    | "build_failed"
    | "lsp_symbol_fallback"
    | "persist_scheduled"
    | "persist_partial"
    | "persist_succeeded"
    | "persist_skipped"
    | "persist_failed"
    | "worker_fallback"
    | "checkpoint_written"
    | "checkpoint_resumed"
    | "checkpoint_discarded"
    | "checkpoint_write_failed";
  cwd: string;
  observability?: ReviewGraphOperationalMetadata;
  reason?: string;
  durationMs?: number;
  nodes?: number;
  edges?: number;
  elements?: number;
  persistedElements?: number;
  cap?: number;
  error?: string;
  rawBytes?: number;
  gzBytes?: number;
  serializeMs?: number;
  writeMs?: number;
  offloaded?: boolean;
  processed?: number;
  reused?: number;
  stale?: number;
  remaining?: number;
  target?: number;
}

export function logReviewGraph(entry: ReviewGraphLogEntry): void {
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry, pid: process.pid });
}

export function getReviewGraphLogPath(): string {
  return REVIEW_GRAPH_LOG_FILE;
}

export function flushReviewGraphLog(): Promise<void> {
  return writer.flush();
}

export function flushReviewGraphLogSync(): void {
  writer.flushSync();
}
