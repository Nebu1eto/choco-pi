import { logBusEvent } from "./bus-events-logger.ts";
import { normalizeFilePath } from "./path-utils.ts";
import { appendRecentTouches } from "./recent-touches.ts";
import {
  createLiveBusEmitter,
  recordStaleBusFailure,
  resolveLiveBusEmitter,
  type BusEmitFn,
  type BusEmitGetter,
} from "./live-bus-emitter.ts";

export const BUS_FILES_TOUCHED_EVENT = "pilens:files:touched";
export const BUS_FILES_TOUCHED_VERSION = 1;

export type FilesTouchedReason = "autofix" | "format";

export interface FixProvenanceEntry {
  path: string;
  tool: string;
  ruleId?: string;
  kind: "autofix" | "format";
}

export interface FilesTouchedPayload {
  v: typeof BUS_FILES_TOUCHED_VERSION;
  source: "choco-pi-lsp";
  reason: FilesTouchedReason;
  paths: string[];
  cwd: string;
  fixes?: FixProvenanceEntry[];
}

const liveEmitter = createLiveBusEmitter();
let hasLoggedFailure = false;
let hasLoggedUnwired = false;
let hasLoggedDisabled = false;

export function wireBusEmitter(emitFn: BusEmitFn | undefined): void {
  liveEmitter.wire(emitFn);
}

export function wireBusEmitterGetter(getter: BusEmitGetter | undefined): void {
  liveEmitter.wireGetter(getter);
}

export function _resetForTests(): void {
  liveEmitter.reset();
  hasLoggedFailure = false;
  hasLoggedUnwired = false;
  hasLoggedDisabled = false;
  _envCache = undefined;
}

let _envCache: boolean | undefined;

export function isBusPublishEnabled(): boolean {
  if (_envCache === undefined) {
    _envCache = process.env.CHOCO_PI_LSP_BUS_PUBLISH !== "0";
  }
  return _envCache;
}

export interface PublishFilesTouchedArgs {
  reason: FilesTouchedReason;
  paths: string[];
  cwd: string;
  origin?: "bus";
  sessionId?: string;
  fixes?: FixProvenanceEntry[];
  dbg?: (msg: string) => void;
}

export function publishFilesTouched(args: PublishFilesTouchedArgs): void {
  if (args.origin === "bus") return;
  if (args.paths.length === 0) return;
  if (!isBusPublishEnabled()) {
    if (!hasLoggedDisabled) {
      hasLoggedDisabled = true;
      logBusEvent({
        event: BUS_FILES_TOUCHED_EVENT,
        outcome: "skipped_disabled",
        cwd: normalizeFilePath(args.cwd),
        reason: args.reason,
      });
    }
    return;
  }

  void appendRecentTouches({
    cwd: args.cwd,
    reason: args.reason,
    paths: args.paths,
    sessionId: args.sessionId,
  }).catch((err) => {
    args.dbg?.(`bus-publish: recent-touches append failed: ${err}`);
  });

  const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
    event: BUS_FILES_TOUCHED_EVENT,
    cwd: normalizeFilePath(args.cwd),
    reason: args.reason,
  }));
  if (resolution.outcome === "stale-session") return;
  if (resolution.outcome === "unwired") {
    if (!hasLoggedUnwired) {
      hasLoggedUnwired = true;
      logBusEvent({
        event: BUS_FILES_TOUCHED_EVENT,
        outcome: "skipped_unwired",
        cwd: normalizeFilePath(args.cwd),
        reason: args.reason,
      });
    }
    return;
  }
  const busEmit = resolution.emit;

  try {
    const payload: FilesTouchedPayload = {
      v: BUS_FILES_TOUCHED_VERSION,
      source: "choco-pi-lsp",
      reason: args.reason,
      paths: args.paths.map((p) => normalizeFilePath(p)),
      cwd: normalizeFilePath(args.cwd),
    };
    if (args.fixes && args.fixes.length > 0) {
      payload.fixes = args.fixes.map((f) => ({
        ...f,
        path: normalizeFilePath(f.path),
      }));
    }
    busEmit(BUS_FILES_TOUCHED_EVENT, payload);
    hasLoggedFailure = false;
    logBusEvent({
      event: BUS_FILES_TOUCHED_EVENT,
      outcome: "emitted",
      cwd: payload.cwd,
      reason: args.reason,
      fileCount: payload.paths.length,
    });
  } catch (err) {
    logBusEvent({
      event: BUS_FILES_TOUCHED_EVENT,
      outcome: "emit_failed",
      cwd: normalizeFilePath(args.cwd),
      reason: args.reason,
      error: String(err),
      ctxSource: resolution.ctxSource,
    });
    if (!hasLoggedFailure) {
      hasLoggedFailure = true;
      recordStaleBusFailure(BUS_FILES_TOUCHED_EVENT, err);
      args.dbg?.(
        `bus-publish: pilens:files:touched emit failed (further failures suppressed): ${err}`,
      );
    }
  }
}
