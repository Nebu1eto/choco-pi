import type { Worker } from "node:worker_threads";

export interface ReviewGraphBuilderState {
  _workspaceCacheEpoch: number;
  _graphGenerationCounter: number;
  _buildIdCounter: number;
  _persistWorker: Worker | undefined;
  _persistWorkerRequestId: number;
  _persistAttemptId: number;
  _workerDisabled: boolean;
  _persistWorkerUnavailableReason: string | undefined;
  _lastWorkerFallbackReasonForTests: string | undefined;
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
