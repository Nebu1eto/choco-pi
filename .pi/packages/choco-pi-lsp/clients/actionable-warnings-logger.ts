import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const AW_LOG_DIR = getGlobalPiLensDir();
const AW_LOG_FILE = path.join(AW_LOG_DIR, "actionable-warnings.log");
const AW_LOG_BACKUP_FILE = path.join(AW_LOG_DIR, "actionable-warnings.log.1");
const MAX_LOG_BYTES = Math.max(
  128 * 1024,
  Number.parseInt(process.env.CHOCO_PI_LSP_AW_LOG_MAX_BYTES ?? "1048576", 10) || 1048576,
);
const writer = createNdjsonLogger({
  filePath: AW_LOG_FILE,
  maxBytes: MAX_LOG_BYTES,
  backupPath: AW_LOG_BACKUP_FILE,
});

type ActionableWarningMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ActionableWarningMetadataValue[]
  | { [key: string]: ActionableWarningMetadataValue };

export interface ActionableWarningsLogEntry {
  event: string;
  sessionId?: string;
  filePath?: string;
  metadata?: Record<string, ActionableWarningMetadataValue>;
}

export function logActionableWarningsEvent(entry: ActionableWarningsLogEntry): void {
  if (isTestMode()) {
    return;
  }
  writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getActionableWarningsLogPath(): string {
  return AW_LOG_FILE;
}

/** Resolve once all enqueued actionable-warnings writes are on disk. */
export function flushActionableWarningsLog(): Promise<void> {
  return writer.flush();
}
