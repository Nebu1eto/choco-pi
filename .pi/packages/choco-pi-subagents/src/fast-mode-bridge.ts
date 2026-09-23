import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export type FastModeSource = "default" | "explicit" | "inherited";

export interface FastModeSnapshot {
  requested: boolean;
  source: FastModeSource;
  revision: number;
}

interface FastModeState extends FastModeSnapshot {
  sessionId: string;
}

interface FastModeOwner {
  toString(): string;
}

interface FastModeRecordLookup extends FastModeOwner {
  getRecord(id: string):
    | {
        fastModeRequested?: boolean;
        fastModeSource?: FastModeSource;
        fastModeRevision?: number;
      }
    | undefined;
}

interface FastModeController {
  getState(): FastModeState;
  decide(model: Model<Api> | undefined): FastModeDecision;
  set(requested: boolean, source?: FastModeSource): FastModeState;
  dispose(): void;
}

export interface FastModeDecision extends FastModeState {
  supported: boolean;
  active: boolean;
}

interface FastModeBridge {
  version: 1;
  register(input: {
    sessionId: string;
    owner: FastModeOwner;
    generation: number;
    initial: { requested: boolean; source: FastModeSource };
  }): FastModeController;
  get(sessionId: string): FastModeController | undefined;
  createExtension(input: {
    owner: FastModeOwner;
    generation: number;
    initial: { requested: boolean; source: FastModeSource };
  }): ExtensionFactory;
}

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi.fast-mode-state");

interface FastModeRegistry {
  [BRIDGE_SYMBOL]?: Partial<FastModeBridge>;
}

function validController(
  controller: FastModeController | undefined,
): controller is FastModeController {
  return (
    controller?.getState instanceof Function &&
    controller.decide instanceof Function &&
    controller.set instanceof Function &&
    controller.dispose instanceof Function
  );
}

export function decideSessionFastMode(
  sessionId: string | undefined,
  model: Model<Api> | undefined,
): FastModeDecision | undefined {
  if (!sessionId) return undefined;
  const controller = resolveFastModeBridge()?.get(sessionId);
  return validController(controller) ? controller.decide(model) : undefined;
}

export function resolveFastModeBridge(): FastModeBridge | undefined {
  const registry: typeof globalThis & FastModeRegistry = globalThis;
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
    register: (input) => candidate.register?.(input) ?? invalidFastModeController(),
    get: (sessionId) => candidate.get?.(sessionId),
    createExtension: (input) => candidate.createExtension?.(input) ?? (() => {}),
  };
}

function invalidFastModeController(): never {
  throw new Error("Fast-mode bridge registration failed.");
}

export function snapshotFastMode(sessionId: string | undefined): FastModeSnapshot {
  if (!sessionId) return { requested: false, source: "default", revision: 0 };
  const controller = resolveFastModeBridge()?.get(sessionId);
  if (!validController(controller)) return { requested: false, source: "default", revision: 0 };
  const state = controller.getState();
  return { requested: state.requested, source: state.source, revision: state.revision };
}

export function createChildFastModeExtension(
  owner: FastModeOwner,
  generation: number,
  initial: FastModeSnapshot,
): ExtensionFactory {
  return (pi) => {
    const factory = resolveFastModeBridge()?.createExtension({
      owner,
      generation,
      initial: { requested: initial.requested, source: initial.source },
    });
    factory?.(pi);
  };
}

export function reconcileChildFastMode(
  sessionId: string | undefined,
  child: { id: string; manager: FastModeRecordLookup },
): FastModeState | undefined {
  if (!sessionId) return undefined;
  const record = child.manager.getRecord(child.id);
  const controller = resolveFastModeBridge()?.get(sessionId);
  if (!record || !validController(controller)) return undefined;
  const current = controller.getState();
  const latest: FastModeSnapshot = {
    requested: record.fastModeRequested ?? false,
    source: record.fastModeSource ?? "default",
    revision: record.fastModeRevision ?? 0,
  };
  const sourceRank = {
    default: 0,
    inherited: 1,
    explicit: 2,
  } satisfies Record<FastModeSource, number>;
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

export function setSessionFastMode(
  sessionId: string | undefined,
  requested: boolean,
): FastModeState | undefined {
  if (!sessionId) return undefined;
  const controller = resolveFastModeBridge()?.get(sessionId);
  return validController(controller) ? controller.set(requested, "explicit") : undefined;
}
