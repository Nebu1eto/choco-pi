import { logBusEvent } from "./bus-events-logger.ts";
import { isBusPublishEnabled } from "./bus-publish.ts";
import { normalizeFilePath } from "./path-utils.ts";
import {
  createLiveBusEmitter,
  recordStaleBusFailure,
  resolveLiveBusEmitter,
  type BusEmitFn,
  type BusEmitGetter,
} from "./live-bus-emitter.ts";

export const BUS_DISPOSITION_EVENT = "pilens:diagnostic:disposition";
export const BUS_DISPOSITION_VERSION = 1;

export interface PilensDispositionPayload {
  v: typeof BUS_DISPOSITION_VERSION;
  source: "choco-pi-lsp";
  cwd: string;
  filePath: string;
  disposition: string;
  tool?: string;
  rule?: string;
  line?: number;
  anchor: string;
  reason?: string;
}

const liveEmitter = createLiveBusEmitter();
let hasLoggedFailure = false;
let hasLoggedUnwired = false;
let hasLoggedDisabled = false;

export function wireDispositionBusEmitter(emitFn: BusEmitFn | undefined): void {
  liveEmitter.wire(emitFn);
}

export function wireDispositionBusEmitterGetter(getter: BusEmitGetter | undefined): void {
  liveEmitter.wireGetter(getter);
}

export function _resetDispositionPublishForTests(): void {
  liveEmitter.reset();
  hasLoggedFailure = false;
  hasLoggedUnwired = false;
  hasLoggedDisabled = false;
}

export interface PublishDispositionArgs {
  cwd: string;
  filePath: string;
  disposition: string;
  tool?: string;
  rule?: string;
  line?: number;
  anchor: string;
  reason?: string;
  dbg?: (msg: string) => void;
}

export function publishDisposition(args: PublishDispositionArgs): void {
  if (!isBusPublishEnabled()) {
    if (!hasLoggedDisabled) {
      hasLoggedDisabled = true;
      logBusEvent({
        event: BUS_DISPOSITION_EVENT,
        outcome: "skipped_disabled",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
    event: BUS_DISPOSITION_EVENT,
    cwd: normalizeFilePath(args.cwd),
  }));
  if (resolution.outcome === "stale-session") return;
  if (resolution.outcome === "unwired") {
    if (!hasLoggedUnwired) {
      hasLoggedUnwired = true;
      logBusEvent({
        event: BUS_DISPOSITION_EVENT,
        outcome: "skipped_unwired",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const busEmit = resolution.emit;

  try {
    const payload: PilensDispositionPayload = {
      v: BUS_DISPOSITION_VERSION,
      source: "choco-pi-lsp",
      cwd: normalizeFilePath(args.cwd),
      filePath: normalizeFilePath(args.filePath),
      disposition: args.disposition,
      tool: args.tool,
      rule: args.rule,
      line: args.line,
      anchor: args.anchor,
      reason: args.reason,
    };
    busEmit(BUS_DISPOSITION_EVENT, payload);
    hasLoggedFailure = false;
    logBusEvent({
      event: BUS_DISPOSITION_EVENT,
      outcome: "emitted",
      cwd: payload.cwd,
    });
  } catch (err) {
    logBusEvent({
      event: BUS_DISPOSITION_EVENT,
      outcome: "emit_failed",
      cwd: normalizeFilePath(args.cwd),
      error: String(err),
      ctxSource: resolution.ctxSource,
    });
    if (!hasLoggedFailure) {
      hasLoggedFailure = true;
      recordStaleBusFailure(BUS_DISPOSITION_EVENT, err);
      args.dbg?.(
        `disposition-publish: pilens:diagnostic:disposition emit failed (further failures suppressed): ${err}`,
      );
    }
  }
}
