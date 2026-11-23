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

export const BUS_FORMAT_QUEUED_EVENT = "pilens:format:queued";
export const BUS_FORMAT_QUEUED_VERSION = 1;

export const BUS_FORMAT_START_EVENT = "pilens:format:start";
export const BUS_FORMAT_START_VERSION = 1;

export const BUS_AUTOFIX_START_EVENT = "pilens:autofix:start";
export const BUS_AUTOFIX_START_VERSION = 1;

export interface FormatQueuedPayload {
  v: typeof BUS_FORMAT_QUEUED_VERSION;
  source: "choco-pi-lsp";
  filePath: string;
  cwd: string;
  tool: "write" | "edit";
  kinds: Array<"autofix" | "format">;
}

export interface FormatStartPayload {
  v: typeof BUS_FORMAT_START_VERSION;
  source: "choco-pi-lsp";
  cwd: string;
  paths: string[];
  fileCount: number;
  kinds: Array<"autofix" | "format">;
}

export interface AutofixStartPayload {
  v: typeof BUS_AUTOFIX_START_VERSION;
  source: "choco-pi-lsp";
  cwd: string;
  paths: string[];
  fileCount: number;
  eligibleCount: number;
}

const liveEmitter = createLiveBusEmitter();
let hasLoggedQueuedFailure = false;
let hasLoggedQueuedUnwired = false;
let hasLoggedQueuedDisabled = false;
let hasLoggedStartFailure = false;
let hasLoggedStartUnwired = false;
let hasLoggedStartDisabled = false;
let hasLoggedAutofixStartFailure = false;
let hasLoggedAutofixStartUnwired = false;
let hasLoggedAutofixStartDisabled = false;

export function wireFormatEventsBusEmitter(emitFn: BusEmitFn | undefined): void {
  liveEmitter.wire(emitFn);
}

export function wireFormatEventsBusEmitterGetter(getter: BusEmitGetter | undefined): void {
  liveEmitter.wireGetter(getter);
}

export function _resetFormatEventsPublishForTests(): void {
  liveEmitter.reset();
  hasLoggedQueuedFailure = false;
  hasLoggedQueuedUnwired = false;
  hasLoggedQueuedDisabled = false;
  hasLoggedStartFailure = false;
  hasLoggedStartUnwired = false;
  hasLoggedStartDisabled = false;
  hasLoggedAutofixStartFailure = false;
  hasLoggedAutofixStartUnwired = false;
  hasLoggedAutofixStartDisabled = false;
}

export interface PublishFormatQueuedArgs {
  filePath: string;
  cwd: string;
  tool: "write" | "edit";
  kinds: Array<"autofix" | "format">;
  dbg?: (msg: string) => void;
}

export function publishFormatQueued(args: PublishFormatQueuedArgs): void {
  if (!isBusPublishEnabled()) {
    if (!hasLoggedQueuedDisabled) {
      hasLoggedQueuedDisabled = true;
      logBusEvent({
        event: BUS_FORMAT_QUEUED_EVENT,
        outcome: "skipped_disabled",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
    event: BUS_FORMAT_QUEUED_EVENT,
    cwd: normalizeFilePath(args.cwd),
  }));
  if (resolution.outcome === "stale-session") return;
  if (resolution.outcome === "unwired") {
    if (!hasLoggedQueuedUnwired) {
      hasLoggedQueuedUnwired = true;
      logBusEvent({
        event: BUS_FORMAT_QUEUED_EVENT,
        outcome: "skipped_unwired",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const busEmit = resolution.emit;

  try {
    const payload: FormatQueuedPayload = {
      v: BUS_FORMAT_QUEUED_VERSION,
      source: "choco-pi-lsp",
      filePath: normalizeFilePath(args.filePath),
      cwd: normalizeFilePath(args.cwd),
      tool: args.tool,
      kinds: args.kinds,
    };
    busEmit(BUS_FORMAT_QUEUED_EVENT, payload);
    hasLoggedQueuedFailure = false;
    logBusEvent({
      event: BUS_FORMAT_QUEUED_EVENT,
      outcome: "emitted",
      cwd: payload.cwd,
      fileCount: 1,
    });
  } catch (err) {
    logBusEvent({
      event: BUS_FORMAT_QUEUED_EVENT,
      outcome: "emit_failed",
      cwd: normalizeFilePath(args.cwd),
      error: String(err),
      ctxSource: resolution.ctxSource,
    });
    if (!hasLoggedQueuedFailure) {
      hasLoggedQueuedFailure = true;
      recordStaleBusFailure(BUS_FORMAT_QUEUED_EVENT, err);
      args.dbg?.(
        `format-events-publish: pilens:format:queued emit failed (further failures suppressed): ${err}`,
      );
    }
  }
}

export interface PublishFormatStartArgs {
  cwd: string;
  paths: string[];
  kinds?: Array<"autofix" | "format">;
  dbg?: (msg: string) => void;
}

export function publishFormatStart(args: PublishFormatStartArgs): void {
  if (args.paths.length === 0) return;
  if (!isBusPublishEnabled()) {
    if (!hasLoggedStartDisabled) {
      hasLoggedStartDisabled = true;
      logBusEvent({
        event: BUS_FORMAT_START_EVENT,
        outcome: "skipped_disabled",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
    event: BUS_FORMAT_START_EVENT,
    cwd: normalizeFilePath(args.cwd),
  }));
  if (resolution.outcome === "stale-session") return;
  if (resolution.outcome === "unwired") {
    if (!hasLoggedStartUnwired) {
      hasLoggedStartUnwired = true;
      logBusEvent({
        event: BUS_FORMAT_START_EVENT,
        outcome: "skipped_unwired",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const busEmit = resolution.emit;

  try {
    const paths = args.paths.map((p) => normalizeFilePath(p));
    const payload: FormatStartPayload = {
      v: BUS_FORMAT_START_VERSION,
      source: "choco-pi-lsp",
      cwd: normalizeFilePath(args.cwd),
      paths,
      fileCount: paths.length,
      kinds: args.kinds ?? ["format"],
    };
    busEmit(BUS_FORMAT_START_EVENT, payload);
    hasLoggedStartFailure = false;
    logBusEvent({
      event: BUS_FORMAT_START_EVENT,
      outcome: "emitted",
      cwd: payload.cwd,
      fileCount: payload.fileCount,
    });
  } catch (err) {
    logBusEvent({
      event: BUS_FORMAT_START_EVENT,
      outcome: "emit_failed",
      cwd: normalizeFilePath(args.cwd),
      error: String(err),
      ctxSource: resolution.ctxSource,
    });
    if (!hasLoggedStartFailure) {
      hasLoggedStartFailure = true;
      recordStaleBusFailure(BUS_FORMAT_START_EVENT, err);
      args.dbg?.(
        `format-events-publish: pilens:format:start emit failed (further failures suppressed): ${err}`,
      );
    }
  }
}

export interface PublishAutofixStartArgs {
  cwd: string;
  paths: string[];
  eligibleCount: number;
  dbg?: (msg: string) => void;
}

export function publishAutofixStart(args: PublishAutofixStartArgs): void {
  if (args.paths.length === 0) return;
  if (!isBusPublishEnabled()) {
    if (!hasLoggedAutofixStartDisabled) {
      hasLoggedAutofixStartDisabled = true;
      logBusEvent({
        event: BUS_AUTOFIX_START_EVENT,
        outcome: "skipped_disabled",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
    event: BUS_AUTOFIX_START_EVENT,
    cwd: normalizeFilePath(args.cwd),
  }));
  if (resolution.outcome === "stale-session") return;
  if (resolution.outcome === "unwired") {
    if (!hasLoggedAutofixStartUnwired) {
      hasLoggedAutofixStartUnwired = true;
      logBusEvent({
        event: BUS_AUTOFIX_START_EVENT,
        outcome: "skipped_unwired",
        cwd: normalizeFilePath(args.cwd),
      });
    }
    return;
  }
  const busEmit = resolution.emit;

  try {
    const paths = args.paths.map((p) => normalizeFilePath(p));
    const payload: AutofixStartPayload = {
      v: BUS_AUTOFIX_START_VERSION,
      source: "choco-pi-lsp",
      cwd: normalizeFilePath(args.cwd),
      paths,
      fileCount: paths.length,
      eligibleCount: args.eligibleCount,
    };
    busEmit(BUS_AUTOFIX_START_EVENT, payload);
    hasLoggedAutofixStartFailure = false;
    logBusEvent({
      event: BUS_AUTOFIX_START_EVENT,
      outcome: "emitted",
      cwd: payload.cwd,
      fileCount: payload.fileCount,
    });
  } catch (err) {
    logBusEvent({
      event: BUS_AUTOFIX_START_EVENT,
      outcome: "emit_failed",
      cwd: normalizeFilePath(args.cwd),
      error: String(err),
      ctxSource: resolution.ctxSource,
    });
    if (!hasLoggedAutofixStartFailure) {
      hasLoggedAutofixStartFailure = true;
      recordStaleBusFailure(BUS_AUTOFIX_START_EVENT, err);
      args.dbg?.(
        `format-events-publish: pilens:autofix:start emit failed (further failures suppressed): ${err}`,
      );
    }
  }
}
