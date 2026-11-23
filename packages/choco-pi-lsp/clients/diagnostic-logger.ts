import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";

export interface DiagnosticEntry {
  timestamp: string;

  tool: string;
  ruleId: string;
  severity: string;
  language: string;

  filePath: string;
  line: number;
  column: number;
  message: string;

  caughtByPipeline: boolean;
  shownInline: boolean;
  autoFixed: boolean;
  shownToAgent: boolean;
  agentFixed: boolean;
  unresolved: boolean;

  model: string;
  sessionId: string;
  turnIndex: number;
  writeIndex: number;
}

export interface DiagnosticLogger {
  log(entry: DiagnosticEntry): void;
  logCaught(d: Diagnostic, context: LogContext, shownInline?: boolean): void;
  flush(): Promise<void>;
}

export interface Diagnostic {
  tool?: string;
  rule?: string;
  id?: string;
  severity?: string;
  language?: string;
  filePath: string;
  line?: number;
  column?: number;
  message?: string;
}

export interface LogContext {
  model: string;
  sessionId: string;
  turnIndex: number;
  writeIndex: number;
}

function getLogDir(): string {
  return path.join(getGlobalPiLensDir(), "logs");
}

function getLogFile(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(getLogDir(), `${date}.jsonl`);
}

let _logger: DiagnosticLogger | null = null;

export function getDiagnosticLogger(): DiagnosticLogger {
  if (!_logger) {
    _logger = createDiagnosticLogger();
  }
  return _logger;
}

export function createDiagnosticLogger(): DiagnosticLogger {
  const writer = createNdjsonLogger({ filePath: () => getLogFile() });

  return {
    log(entry: DiagnosticEntry) {
      if (isTestMode()) {
        return;
      }
      writer.log(entry);
    },

    logCaught(d: Diagnostic, context: LogContext, shownInline = false) {
      this.log({
        timestamp: new Date().toISOString(),
        tool: d.tool || "unknown",
        ruleId: d.rule || d.id || "unknown",
        severity: d.severity || "warning",
        language: d.language || "unknown",
        filePath: d.filePath,
        line: d.line || 1,
        column: d.column || 1,
        message: d.message || "",
        caughtByPipeline: true,
        shownInline,
        autoFixed: false,
        shownToAgent: shownInline,
        agentFixed: false,
        unresolved: true,
        model: context.model,
        sessionId: context.sessionId,
        turnIndex: context.turnIndex,
        writeIndex: context.writeIndex,
      });
    },

    async flush() {
      await writer.flush();
    },
  };
}
