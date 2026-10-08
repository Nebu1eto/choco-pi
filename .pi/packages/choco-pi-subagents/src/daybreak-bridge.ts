import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type DaybreakSource = "default" | "explicit" | "inherited";
export type DaybreakOutcome =
  | "off"
  | "pending"
  | "blue"
  | "red"
  | "not-granted"
  | "lookup-failed"
  | "model-not-supported"
  | "auth-not-eligible";

export interface DaybreakSnapshot {
  requested: boolean;
  source: DaybreakSource;
  revision: number;
}

export interface DaybreakState extends DaybreakSnapshot {
  sessionId: string;
  generation: number;
  outcome: DaybreakOutcome;
}

interface DaybreakOwner {
  toString(): string;
}

interface DaybreakRecordLookup extends DaybreakOwner {
  getRecord(id: string):
    | {
        daybreakRequested?: boolean;
        daybreakSource?: DaybreakSource;
        daybreakRevision?: number;
      }
    | undefined;
}

interface DaybreakController {
  getState(): DaybreakState;
  set(requested: boolean, source?: DaybreakSource): DaybreakState;
  report(outcome: DaybreakOutcome, revision: number): void;
  dispose(): void;
}

interface DaybreakBridge {
  version: 1;
  register(input: {
    sessionId: string;
    owner: DaybreakOwner;
    generation: number;
    initial: { requested: boolean; source: DaybreakSource };
  }): DaybreakController;
  get(sessionId: string): DaybreakController | undefined;
  createExtension(input: {
    owner: DaybreakOwner;
    generation: number;
    initial: { requested: boolean; source: DaybreakSource };
  }): ExtensionFactory;
}

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi.daybreak-state");

interface DaybreakRegistry {
  [BRIDGE_SYMBOL]?: Partial<DaybreakBridge>;
}

function validController(
  controller: DaybreakController | undefined,
): controller is DaybreakController {
  return (
    controller?.getState instanceof Function &&
    controller.set instanceof Function &&
    controller.report instanceof Function &&
    controller.dispose instanceof Function
  );
}

export function getSessionDaybreak(sessionId: string | undefined): DaybreakState | undefined {
  if (!sessionId) return undefined;
  const controller = resolveDaybreakBridge()?.get(sessionId);
  return validController(controller) ? controller.getState() : undefined;
}

export function resolveDaybreakBridge(): DaybreakBridge | undefined {
  const registry: typeof globalThis & DaybreakRegistry = globalThis;
  const candidate = registry[BRIDGE_SYMBOL];
  if (
    candidate?.version !== 1 ||
    !(candidate.register instanceof Function) ||
    !(candidate.get instanceof Function) ||
    !(candidate.createExtension instanceof Function)
  )
    return undefined;
  return {
    version: 1,
    register: (input) => candidate.register?.(input) ?? invalidDaybreakController(),
    get: (sessionId) => candidate.get?.(sessionId),
    createExtension: (input) => candidate.createExtension?.(input) ?? (() => {}),
  };
}

function invalidDaybreakController(): never {
  throw new Error("Daybreak bridge registration failed.");
}

export function snapshotDaybreak(sessionId: string | undefined): DaybreakSnapshot {
  const state = getSessionDaybreak(sessionId);
  return state
    ? { requested: state.requested, source: state.source, revision: state.revision }
    : { requested: false, source: "default", revision: 0 };
}

export function createChildDaybreakExtension(
  owner: DaybreakOwner,
  generation: number,
  initial: DaybreakSnapshot,
): ExtensionFactory {
  return (pi) => {
    const factory = resolveDaybreakBridge()?.createExtension({
      owner,
      generation,
      initial: { requested: initial.requested, source: initial.source },
    });
    factory?.(pi);
  };
}

export function reconcileChildDaybreak(
  sessionId: string | undefined,
  child: { id: string; manager: DaybreakRecordLookup },
): DaybreakState | undefined {
  if (!sessionId) return undefined;
  const record = child.manager.getRecord(child.id);
  const controller = resolveDaybreakBridge()?.get(sessionId);
  if (!record || !validController(controller)) return undefined;
  const current = controller.getState();
  const latest: DaybreakSnapshot = {
    requested: record.daybreakRequested ?? false,
    source: record.daybreakSource ?? "default",
    revision: record.daybreakRevision ?? 0,
  };
  const sourceRank = {
    default: 0,
    inherited: 1,
    explicit: 2,
  } satisfies Record<DaybreakSource, number>;
  if (
    latest.revision < current.revision ||
    (latest.revision === current.revision &&
      (sourceRank[latest.source] < sourceRank[current.source] ||
        (latest.requested === current.requested && latest.source === current.source)))
  )
    return current;
  let reconciled = controller.set(latest.requested, latest.source);
  while (reconciled.revision < latest.revision) {
    reconciled = controller.set(latest.requested, latest.source);
  }
  return reconciled;
}

export function setSessionDaybreak(
  sessionId: string | undefined,
  requested: boolean,
): DaybreakState | undefined {
  if (!sessionId) return undefined;
  const controller = resolveDaybreakBridge()?.get(sessionId);
  return validController(controller) ? controller.set(requested, "explicit") : undefined;
}
