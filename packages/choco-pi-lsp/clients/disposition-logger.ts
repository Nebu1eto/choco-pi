import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";

const DISPOSITION_LOG_DIR = getGlobalPiLensDir();
const DISPOSITION_LOG_FILE = path.join(DISPOSITION_LOG_DIR, "dispositions.log");
const DISPOSITION_LOG_BACKUP_FILE = path.join(DISPOSITION_LOG_DIR, "dispositions.log.1");
const MAX_LOG_BYTES = Math.max(
  128 * 1024,
  Number.parseInt(process.env.CHOCO_PI_LSP_DISPOSITION_LOG_MAX_BYTES ?? "1048576", 10) || 1048576,
);
const writer = createNdjsonLogger({
  filePath: DISPOSITION_LOG_FILE,
  maxBytes: MAX_LOG_BYTES,
  backupPath: DISPOSITION_LOG_BACKUP_FILE,
});

export interface DispositionLogEntry {
  event: "mark";
  disposition: string;
  tool?: string;
  rule?: string;
  filePath: string;
  line?: number;
  reason?: string;
  anchor: string;
  previousDisposition?: string;
  model?: string;
  provider?: string;
}

export function logDispositionEvent(entry: DispositionLogEntry): void {
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getDispositionLogPath(): string {
  return DISPOSITION_LOG_FILE;
}

export function flushDispositionLog(): Promise<void> {
  return writer.flush();
}
