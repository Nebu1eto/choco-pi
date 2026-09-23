import { registerSessionResourceCleanup, type Api, type Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ExtensionFactory,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isBoolean, isFunction, isJsonRecord, isNumber } from "./runtime-values.ts";
import type { RuntimeValue } from "./runtime-values.ts";

export const FAST_MODE_ENTRY = "choco-pi-fast-mode";
export const FAST_MODE_BRIDGE_SYMBOL = Symbol.for("choco-pi.fast-mode-state");

export type FastModeSource = "default" | "explicit" | "inherited";

export type FastModeState = Readonly<{
  sessionId: string;
  requested: boolean;
  source: FastModeSource;
  revision: number;
}>;

export type FastModeDecision = FastModeState &
  Readonly<{
    supported: boolean;
    active: boolean;
    serviceTier: "priority" | "standard" | undefined;
  }>;

export type FastModeInitialization = Readonly<{
  requested: boolean;
  source: FastModeSource;
}>;

export type FastModeRegistration = Readonly<{
  sessionId: string;
  owner: object;
  generation: number;
  initial: FastModeInitialization;
  entries?: readonly SessionEntry[];
  persist?: (state: FastModeState) => void;
}>;

export type FastModeController = Readonly<{
  getState(): FastModeState;
  decide(model: Model<Api> | undefined): FastModeDecision;
  set(requested: boolean, source?: FastModeSource): FastModeState;
  dispose(): void;
}>;

export type FastModeBridge = Readonly<{
  version: 1;
  register(input: FastModeRegistration): FastModeController;
  get(sessionId: string): FastModeController | undefined;
  createExtension(
    input: Omit<FastModeRegistration, "sessionId" | "entries" | "persist">,
  ): ExtensionFactory;
}>;

export type FastModeExtensionContext = Pick<ExtensionContext, "model"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
};

export type FastModeExtensionHooks = Readonly<{
  appendEntry(type: string, data: Readonly<Record<string, boolean | number | string>>): void;
  onSessionStart(handler: (ctx: FastModeExtensionContext) => void): void;
  onSessionTree(handler: (ctx: FastModeExtensionContext) => void): void;
  onBeforeProviderRequest(
    handler: (payload: RuntimeValue, ctx: FastModeExtensionContext) => RuntimeValue,
  ): void;
  onSessionShutdown(handler: () => void): void;
}>;

type StoredState = {
  controller: FastModeController;
  owner: object;
  generation: number;
  unregisterCleanup: () => void;
};

function restoredInitialization(
  entries: readonly SessionEntry[] | undefined,
  fallback: FastModeInitialization,
): FastModeInitialization & { revision: number } {
  let restored = { ...fallback, revision: 0 };
  for (const entry of entries ?? []) {
    if (entry.type !== "custom" || entry.customType !== FAST_MODE_ENTRY) continue;
    const data = entry.data;
    if (!isJsonRecord(data) || !isBoolean(data.enabled)) continue;
    const source =
      data.source === "inherited"
        ? "inherited"
        : data.source === "default"
          ? "default"
          : "explicit";
    const revision =
      isNumber(data.revision) && Number.isSafeInteger(data.revision) && data.revision >= 0
        ? data.revision
        : restored.revision;
    restored = { requested: data.enabled, source, revision };
  }
  return restored;
}

export function supportsFastMode(model: Model<Api> | undefined): boolean {
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  try {
    const hostname = new URL(model.baseUrl).hostname;
    return model.provider === "openai"
      ? hostname === "api.openai.com"
      : hostname === "chatgpt.com" || hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export function decideFastMode(
  state: FastModeState,
  model: Model<Api> | undefined,
): FastModeDecision {
  const supported = supportsFastMode(model);
  return {
    ...state,
    supported,
    active: state.requested && supported,
    serviceTier: supported ? (state.requested ? "priority" : "standard") : undefined,
  };
}

export function createFastModeBridge(): FastModeBridge {
  const registrations = new Map<string, StoredState>();

  const bridge: FastModeBridge = {
    version: 1,
    register(input) {
      const existing = registrations.get(input.sessionId);
      if (existing?.owner === input.owner && existing.generation === input.generation)
        return existing.controller;

      existing?.unregisterCleanup();

      const initial = restoredInitialization(input.entries, input.initial);
      let state: FastModeState = {
        sessionId: input.sessionId,
        requested: initial.requested,
        source: initial.source,
        revision: initial.revision,
      };
      const controller: FastModeController = {
        getState: () => state,
        decide: (model) => decideFastMode(state, model),
        set(requested, source = "explicit") {
          if (registrations.get(input.sessionId)?.controller !== controller)
            throw new Error("Fast mode controller is stale.");
          const next = { ...state, requested, source, revision: state.revision + 1 };
          input.persist?.(next);
          state = next;
          return state;
        },
        dispose() {
          const current = registrations.get(input.sessionId);
          if (current?.controller !== controller) return;
          registrations.delete(input.sessionId);
          current.unregisterCleanup();
        },
      };
      const unregisterCleanup = registerSessionResourceCleanup((sessionId) => {
        if (sessionId !== undefined && sessionId !== input.sessionId) return;
        if (registrations.get(input.sessionId)?.controller === controller) controller.dispose();
      });
      registrations.set(input.sessionId, {
        controller,
        owner: input.owner,
        generation: input.generation,
        unregisterCleanup,
      });
      return controller;
    },
    get: (sessionId) => registrations.get(sessionId)?.controller,
    createExtension(input) {
      return (pi) => {
        installFastModeExtension(bridge, input, {
          appendEntry: (type, data) => pi.appendEntry(type, data),
          onSessionStart: (handler) => pi.on("session_start", (_event, ctx) => handler(ctx)),
          onSessionTree: (handler) => pi.on("session_tree", (_event, ctx) => handler(ctx)),
          onBeforeProviderRequest: (handler) =>
            pi.on("before_provider_request", (event, ctx) => handler(event.payload, ctx)),
          onSessionShutdown: (handler) => pi.on("session_shutdown", handler),
        });
      };
    },
  };
  return bridge;
}

export function installFastModeExtension(
  bridge: FastModeBridge,
  input: Omit<FastModeRegistration, "sessionId" | "entries" | "persist">,
  hooks: FastModeExtensionHooks,
): void {
  let controller: FastModeController | undefined;
  let generation = input.generation;
  let firstRegistration = true;
  const registerForContext = (ctx: FastModeExtensionContext): void => {
    const entries = ctx.sessionManager.getBranch();
    const initialOverridesHistory = firstRegistration && input.initial.source !== "default";
    const registration = {
      ...input,
      sessionId: ctx.sessionManager.getSessionId(),
      generation,
      persist: (state) =>
        hooks.appendEntry(FAST_MODE_ENTRY, {
          enabled: state.requested,
          source: state.source,
          revision: state.revision,
        }),
    } satisfies Omit<FastModeRegistration, "entries">;
    controller = initialOverridesHistory
      ? bridge.register(registration)
      : bridge.register({ ...registration, entries });
    if (
      input.initial.source !== "default" &&
      (initialOverridesHistory ||
        !entries.some((entry) => entry.type === "custom" && entry.customType === FAST_MODE_ENTRY))
    ) {
      const state = controller.getState();
      hooks.appendEntry(FAST_MODE_ENTRY, {
        enabled: state.requested,
        source: state.source,
        revision: state.revision,
      });
    }
    firstRegistration = false;
  };
  hooks.onSessionStart(registerForContext);
  hooks.onSessionTree((ctx) => {
    controller?.dispose();
    generation++;
    registerForContext(ctx);
  });
  hooks.onBeforeProviderRequest((payload, ctx) => {
    const decision = controller?.decide(ctx.model);
    if (!decision?.supported || !isJsonRecord(payload)) return;
    return { ...payload, service_tier: decision.active ? "priority" : "default" };
  });
  hooks.onSessionShutdown(() => controller?.dispose());
}

type BridgeHost = typeof globalThis & { [FAST_MODE_BRIDGE_SYMBOL]?: FastModeBridge };

export function getFastModeBridge(): FastModeBridge {
  const host: BridgeHost = globalThis;
  const candidate = host[FAST_MODE_BRIDGE_SYMBOL];
  if (
    candidate?.version === 1 &&
    isFunction(candidate.register) &&
    isFunction(candidate.get) &&
    isFunction(candidate.createExtension)
  )
    return candidate;
  const bridge = createFastModeBridge();
  host[FAST_MODE_BRIDGE_SYMBOL] = bridge;
  return bridge;
}
