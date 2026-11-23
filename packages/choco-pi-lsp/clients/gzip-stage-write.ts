import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort } from "node:worker_threads";
import { createGzip } from "node:zlib";
import { stagePathFor } from "./atomic-write-staging.ts";

export interface GzipStageWriteMetrics {
  rawBytes: number;
  gzBytes: number;
  serializeMs: number;
  writeMs: number;
}

export interface GzipStageWorkerRequest {
  id: number;
  generation: number;
  stagePath: string;
  data: unknown;
  testDelayMs?: number;
}

export interface GzipStageWorkerResult {
  id: number;
  generation: number;
  stagePath: string;
  rawBytes?: number;
  gzBytes?: number;
  serializeMs?: number;
  writeMs?: number;
  error?: string;
}

export async function writeGzipStageFile<T>(
  data: T,
  stagePath: string,
  testDelayMs?: number,
): Promise<GzipStageWriteMetrics> {
  const tmpPath = stagePathFor(stagePath);
  try {
    if (testDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, testDelayMs));
    }
    const serializeStarted = performance.now();
    const json = JSON.stringify(data);
    const serializeMs = performance.now() - serializeStarted;
    const rawBytes = Buffer.byteLength(json);

    const writeStarted = performance.now();
    await fs.promises.mkdir(path.dirname(stagePath), { recursive: true });
    const chunks = function* () {
      const chunkChars = 256 * 1024;
      for (let offset = 0; offset < json.length; offset += chunkChars) {
        yield json.slice(offset, offset + chunkChars);
      }
    };
    await pipeline(Readable.from(chunks()), createGzip(), fs.createWriteStream(tmpPath));
    await fs.promises.rename(tmpPath, stagePath);
    const writeMs = performance.now() - writeStarted;
    const gzBytes = (await fs.promises.stat(stagePath)).size;
    return { rawBytes, gzBytes, serializeMs, writeMs };
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export function serveGzipStageWorker<
  Req extends GzipStageWorkerRequest,
  Base extends { id: number; generation: number; stagePath: string },
>(buildBaseResult: (request: Req) => Base): void {
  const port = parentPort;
  if (!port) {
    throw new Error("gzip stage persist worker requires a parent port");
  }
  port.on("message", (request: Req) => {
    void (async () => {
      const result: Base & GzipStageWorkerResult = {
        ...buildBaseResult(request),
      };
      try {
        const metrics = await writeGzipStageFile(
          request.data,
          request.stagePath,
          request.testDelayMs,
        );
        result.rawBytes = metrics.rawBytes;
        result.gzBytes = metrics.gzBytes;
        result.serializeMs = metrics.serializeMs;
        result.writeMs = metrics.writeMs;
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
      port.postMessage(result);
    })();
  });
}
