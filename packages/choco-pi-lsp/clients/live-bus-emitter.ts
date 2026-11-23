import { isFunction, type LspBoundaryValue } from "./runtime-guards.ts";
import { recordDegradation } from "./degradation-ledger.ts";
import { probeCtxActive } from "./session-lifecycle.ts";
import { logBusEvent, type BusEventLogEntry } from "./bus-events-logger.ts";

export type BusEmitFn = (channel: string, data: LspBoundaryValue) => void;
export interface BusEmitTarget {
  emit: BusEmitFn;
  ctx: unknown;
}

function isBusEmitFn(target: BusEmitFn | BusEmitTarget): target is BusEmitFn {
  return isFunction(target);
}

export type BusEmitGetter = () => BusEmitFn | BusEmitTarget | undefined;
export type BusEmitResolution =
  | { outcome: "ready"; emit: BusEmitFn; ctxSource: "own" | "global-fallback" }
  | { outcome: "unwired"; ctxSource: "unwired" }
  | { outcome: "stale-session"; ctxSource: "own" };

export interface LiveBusEmitter {
  wire(emit: BusEmitFn | undefined): void;
  wireGetter(getter: BusEmitGetter | undefined): void;
  resolve(): BusEmitResolution;
  reset(): void;
}

const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement";

export function recordStaleBusFailure(subject: string, error: LspBoundaryValue): void {
  const reason = String(error);
  if (!reason.includes(STALE_CTX_MESSAGE)) return;
  recordDegradation({ kind: "bus-stale", subject, reason });
}

export function createLiveBusEmitter(): LiveBusEmitter {
  let emit: BusEmitFn | undefined;
  let getter: BusEmitGetter | undefined;
  return {
    wire(next) {
      emit = next;
      getter = undefined;
    },
    wireGetter(next) {
      getter = next;
      emit = undefined;
    },
    resolve() {
      const target = getter?.() ?? emit;
      if (!target) return { outcome: "unwired", ctxSource: "unwired" };

      if (isBusEmitFn(target)) {
        return { outcome: "ready", emit: target, ctxSource: "global-fallback" };
      }
      const ctxSource = "own" as const;
      if (probeCtxActive(target.ctx) === false) {
        return { outcome: "stale-session", ctxSource };
      }
      return { outcome: "ready", emit: target.emit, ctxSource };
    },
    reset() {
      emit = undefined;
      getter = undefined;
    },
  };
}

export function resolveLiveBusEmitter(
  liveEmitter: LiveBusEmitter,
  entry: () => Omit<BusEventLogEntry, "ts" | "outcome" | "level">,
): BusEmitResolution {
  const resolution = liveEmitter.resolve();
  if (resolution.outcome === "stale-session") {
    logBusEvent({
      ...entry(),
      outcome: "skipped_stale_session",
      level: "info",
      ctxSource: resolution.ctxSource,
    });
  }
  return resolution;
}
