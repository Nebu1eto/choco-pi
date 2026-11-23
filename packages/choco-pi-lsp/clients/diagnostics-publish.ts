import { logBusEvent } from "./bus-events-logger.ts";
import { normalizeFilePath } from "./path-utils.ts";
import {
  createLiveBusEmitter,
  recordStaleBusFailure,
  resolveLiveBusEmitter,
  type BusEmitFn,
  type BusEmitGetter,
} from "./live-bus-emitter.ts";
import { isBusPublishEnabled } from "./bus-publish.ts";

export const BUS_DIAGNOSTICS_EVENT = "pilens:diagnostics";
export const BUS_DIAGNOSTICS_VERSION = 1;

export const MAX_DIAGNOSTICS_PER_FILE_EVENT = 12;

export interface PilensDiagnosticEntry {
  ruleId?: string;
  severity: "error" | "warning" | "info" | "hint";
  line?: number;
  col?: number;
  message: string;
  tool: string;
  fixable?: boolean;
}

export interface PilensDiagnosticsFileEntry {
  path: string;
  diagnostics: PilensDiagnosticEntry[];
  truncated?: boolean;
}

export interface PilensDiagnosticsPayload {
  v: typeof BUS_DIAGNOSTICS_VERSION;
  source: "choco-pi-lsp";
  cwd: string;
  seq: number;
  ts: number;
  files: PilensDiagnosticsFileEntry[];
}

const liveEmitter = createLiveBusEmitter();
let hasLoggedFailure = false;
let hasLoggedUnwired = false;
let hasLoggedDisabled = false;
let seqCounter = 0;

const reportedDirtyPaths = new Set<string>();

export function wireDiagnosticsBusEmitter(emitFn: BusEmitFn | undefined): void {
  liveEmitter.wire(emitFn);
}

export function wireDiagnosticsBusEmitterGetter(getter: BusEmitGetter | undefined): void {
  liveEmitter.wireGetter(getter);
}

export function _resetDiagnosticsPublishForTests(): void {
  liveEmitter.reset();
  hasLoggedFailure = false;
  hasLoggedUnwired = false;
  hasLoggedDisabled = false;
  seqCounter = 0;
  reportedDirtyPaths.clear();
}

export interface PublishDiagnosticsFileInput {
  path: string;
  diagnostics: PilensDiagnosticEntry[];
}

export interface PublishDiagnosticsArgs {
  cwd: string;
  files: PublishDiagnosticsFileInput[];
  origin?: "bus";
  dbg?: (msg: string) => void;
}

function capDiagnostics(diagnostics: PilensDiagnosticEntry[]) {
  if (diagnostics.length <= MAX_DIAGNOSTICS_PER_FILE_EVENT) {
    return { capped: diagnostics, truncated: false };
  }
  const errors = diagnostics.filter((d) => d.severity === "error");
  const rest = diagnostics.filter((d) => d.severity !== "error");
  if (errors.length >= MAX_DIAGNOSTICS_PER_FILE_EVENT) {
    return {
      capped: errors.slice(0, MAX_DIAGNOSTICS_PER_FILE_EVENT),
      truncated: true,
    };
  }
  return {
    capped: [...errors, ...rest.slice(0, MAX_DIAGNOSTICS_PER_FILE_EVENT - errors.length)],
    truncated: true,
  };
}

export function publishDiagnostics(args: PublishDiagnosticsArgs): void {
  if (args.origin === "bus") return;
  if (args.files.length === 0) return;
  if (!isBusPublishEnabled()) {
    if (!hasLoggedDisabled) {
      hasLoggedDisabled = true;
      logBusEvent({
        event: BUS_DIAGNOSTICS_EVENT,
        outcome: "skipped_disabled",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
    event: BUS_DIAGNOSTICS_EVENT,
    cwd: normalizeFilePath(args.cwd),
  }));
  if (resolution.outcome === "stale-session") return;
  if (resolution.outcome === "unwired") {
    if (!hasLoggedUnwired) {
      hasLoggedUnwired = true;
      logBusEvent({
        event: BUS_DIAGNOSTICS_EVENT,
        outcome: "skipped_unwired",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const busEmit = resolution.emit;

  try {
    const fileEntries: PilensDiagnosticsFileEntry[] = args.files.map((f) => {
      const normPath = normalizeFilePath(f.path);
      const { capped, truncated } = capDiagnostics(f.diagnostics);
      if (capped.length > 0) {
        reportedDirtyPaths.add(normPath);
      } else {
        reportedDirtyPaths.delete(normPath);
      }
      const entry: PilensDiagnosticsFileEntry = {
        path: normPath,
        diagnostics: capped,
      };
      if (truncated) entry.truncated = true;
      return entry;
    });

    seqCounter += 1;
    const payload: PilensDiagnosticsPayload = {
      v: BUS_DIAGNOSTICS_VERSION,
      source: "choco-pi-lsp",
      cwd: normalizeFilePath(args.cwd),
      seq: seqCounter,
      ts: Date.now(),
      files: fileEntries,
    };
    busEmit(BUS_DIAGNOSTICS_EVENT, payload);
    hasLoggedFailure = false;
    logBusEvent({
      event: BUS_DIAGNOSTICS_EVENT,
      outcome: "emitted",
      cwd: payload.cwd,
      fileCount: payload.files.length,
      seq: payload.seq,
    });
  } catch (err) {
    logBusEvent({
      event: BUS_DIAGNOSTICS_EVENT,
      outcome: "emit_failed",
      cwd: normalizeFilePath(args.cwd),
      error: String(err),
      ctxSource: resolution.ctxSource,
    });
    if (!hasLoggedFailure) {
      hasLoggedFailure = true;
      recordStaleBusFailure(BUS_DIAGNOSTICS_EVENT, err);
      args.dbg?.(
        `diagnostics-publish: pilens:diagnostics emit failed (further failures suppressed): ${err}`,
      );
    }
  }
}

export function wasPreviouslyReportedDirty(path: string): boolean {
  return reportedDirtyPaths.has(normalizeFilePath(path));
}
