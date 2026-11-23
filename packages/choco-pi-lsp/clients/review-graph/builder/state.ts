import type { Worker } from "node:worker_threads";

/** Mutable module state shared by sibling modules (the former top-level let bindings). */
export interface ReviewGraphBuilderState {
  // A workspace-wide clear must invalidate builds for workspaces that are not
  // resident yet, too. This process-wide component therefore survives cache
  // deletion; per-workspace eviction/reset increments the map component below.
  _workspaceCacheEpoch: number;
  // #459: process-wide monotonic source for ReviewGraph.buildGeneration stamps.
  // Never reset (uniqueness is the invariant — a workspace-cache clear must not
  // let a new build collide with a generation a derived-data cache recorded
  // earlier in the same process).
  _graphGenerationCounter: number;
  // Build invocation identity is separate from graph content generation: cached
  // builds can reuse content while still needing a stable lifecycle join key.
  _buildIdCounter: number;
  _persistWorker: Worker | undefined;
  _persistWorkerRequestId: number;
  _persistAttemptId: number;
  _workerDisabled: boolean;
  _persistWorkerUnavailableReason: string | undefined;
  _lastWorkerFallbackReasonForTests: string | undefined;
  // Test-observable: how many checkpoint writes actually took the OFFLOADED
  // (worker) path rather than the synchronous fallback, so a test can assert the
  // offload really fired instead of passing trivially on a completed build.
  _checkpointOffloadCountForTests: number;
}

export const reviewGraphBuilderState: ReviewGraphBuilderState = {
  _workspaceCacheEpoch: 0,
  _graphGenerationCounter: 0,
  _buildIdCounter: 0,
  _persistWorker: undefined,
  _persistWorkerRequestId: 0,
  _persistAttemptId: 0,
  _workerDisabled: false,
  _persistWorkerUnavailableReason: undefined,
  _lastWorkerFallbackReasonForTests: undefined,
  _checkpointOffloadCountForTests: 0,
};
