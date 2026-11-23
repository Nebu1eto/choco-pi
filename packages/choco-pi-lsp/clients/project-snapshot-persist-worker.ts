import {
  type GzipStageWorkerRequest,
  type GzipStageWorkerResult,
  serveGzipStageWorker,
} from "./gzip-stage-write.ts";

export type ProjectSnapshotPersistWorkerRequest = GzipStageWorkerRequest;
export type ProjectSnapshotPersistWorkerResult = GzipStageWorkerResult;

serveGzipStageWorker<ProjectSnapshotPersistWorkerRequest, ProjectSnapshotPersistWorkerResult>(
  (request) => ({
    id: request.id,
    generation: request.generation,
    stagePath: request.stagePath,
  }),
);
