import {
	type GzipStageWorkerRequest,
	type GzipStageWorkerResult,
	serveGzipStageWorker,
} from "./gzip-stage-write.js";

/**
 * Worker-thread persist for the project snapshot BODY (#958 item 2). The parent
 * (project-snapshot.ts) posts the (large) snapshot object plus a monotonic
 * `generation` and a per-generation `stagePath`; the streamed stringify+gzip
 * runs entirely off the main thread via the shared gzip-stage worker loop
 * (clients/gzip-stage-write.ts, also used by the review-graph persist worker).
 * The parent does the generation-gated promotion (rename stage → canonical) so
 * a slow write for an older generation can never clobber a newer snapshot.
 * The project snapshot needs no extra routing fields beyond the shared base.
 */
export type ProjectSnapshotPersistWorkerRequest = GzipStageWorkerRequest;
export type ProjectSnapshotPersistWorkerResult = GzipStageWorkerResult;

serveGzipStageWorker<ProjectSnapshotPersistWorkerRequest, ProjectSnapshotPersistWorkerResult>(
	(request) => ({
		id: request.id,
		generation: request.generation,
		stagePath: request.stagePath,
	}),
);
