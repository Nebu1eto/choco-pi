import {
  type GzipStageWorkerRequest,
  type GzipStageWorkerResult,
  serveGzipStageWorker,
} from "../gzip-stage-write.ts";

export interface ReviewGraphPersistWorkerRequest extends GzipStageWorkerRequest {
  cwd: string;
  elements: number;
}

export interface ReviewGraphPersistWorkerResult extends GzipStageWorkerResult {
  cwd: string;
  elements: number;
}

serveGzipStageWorker<ReviewGraphPersistWorkerRequest, ReviewGraphPersistWorkerResult>(
  (request) => ({
    id: request.id,
    cwd: request.cwd,
    generation: request.generation,
    stagePath: request.stagePath,
    elements: request.elements,
  }),
);
