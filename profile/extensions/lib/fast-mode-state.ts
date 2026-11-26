import {
  registerSessionResourceCleanup,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  ExtensionFactory,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isBoolean, isFunction, isJsonRecord, isNumber, isString } from "./runtime-values.ts";
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
    reason?: string;
    fastModelId?: string;
  }>;

export type FastModeAuthRegistry = Readonly<{ isUsingOAuth(model: Model<Api>): boolean }>;

export const OPENAI_PLATFORM_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_SIGN_IN_FAST_REASON =
  "accepted but not honored by api.openai.com subscription sign-in";

export const XAI_FAST_HOST = "api.x.ai";
export const XAI_FAST_MODEL_IDS: ReadonlyMap<string, string> = new Map([
  ["grok-4.7", "grok-4.7-build-fast"],
]);
export const XAI_FAST_PRICE_MULTIPLIER = 2;
export const XAI_FAST_MODEL_REASON = `xAI Fast exists only for ${[...XAI_FAST_MODEL_IDS.keys()].join(", ")}`;
export const XAI_FAST_HOST_REASON = `xAI Fast requires ${XAI_FAST_HOST}`;

export const SYNTHETIC_FAST_HOST = "api.synthetic.new";
export const SYNTHETIC_FAST_PREFIX = "fast:";
export const SYNTHETIC_INFINITE_PREFIX = "infinite:";
export const SYNTHETIC_FAST_HOST_REASON = `Synthetic Fast requires ${SYNTHETIC_FAST_HOST}`;
export const SYNTHETIC_FAST_INFINITE_REASON =
  "Synthetic Fast is mutually exclusive with infinite: models";

function baseUrlHostname(model: Model<Api>): string | undefined {
  try {
    return new URL(model.baseUrl).hostname;
  } catch {
    return undefined;
  }
}

export function xaiFastModelId(model: Model<Api> | undefined): string | undefined {
  if (model?.provider !== "xai" || baseUrlHostname(model) !== XAI_FAST_HOST) return undefined;
  return XAI_FAST_MODEL_IDS.get(model.id);
}

function xaiFastUnsupportedReason(model: Model<Api> | undefined): string | undefined {
  if (model?.provider !== "xai" || xaiFastModelId(model) !== undefined) return undefined;
  return baseUrlHostname(model) === XAI_FAST_HOST ? XAI_FAST_MODEL_REASON : XAI_FAST_HOST_REASON;
}

export function syntheticFastModelId(model: Model<Api> | undefined): string | undefined {
  if (model?.provider !== "synthetic" || baseUrlHostname(model) !== SYNTHETIC_FAST_HOST)
    return undefined;
  if (!model.id || model.id.startsWith(SYNTHETIC_INFINITE_PREFIX)) return undefined;
  return model.id.startsWith(SYNTHETIC_FAST_PREFIX)
    ? model.id
    : `${SYNTHETIC_FAST_PREFIX}${model.id}`;
}

function syntheticFastUnsupportedReason(model: Model<Api> | undefined): string | undefined {
  if (model?.provider !== "synthetic" || syntheticFastModelId(model) !== undefined)
    return undefined;
  if (baseUrlHostname(model) !== SYNTHETIC_FAST_HOST) return SYNTHETIC_FAST_HOST_REASON;
  if (model.id.startsWith(SYNTHETIC_INFINITE_PREFIX)) return SYNTHETIC_FAST_INFINITE_REASON;
  return undefined;
}

export function isOpenAISubscriptionSignIn(
  model: Model<Api> | undefined,
  registry: FastModeAuthRegistry | undefined,
): boolean {
  if (!model || !registry || model.provider !== "openai") return false;
  if ((model.baseUrl ?? "").replace(/\/+$/, "") !== OPENAI_PLATFORM_BASE_URL) return false;
  try {
    return registry.isUsingOAuth(model) === true;
  } catch {
    return false;
  }
}

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
  modelRegistry?: FastModeAuthRegistry | undefined;
}>;

export type FastModeController = Readonly<{
  getState(): FastModeState;
  decide(model: Model<Api> | undefined, registry?: FastModeAuthRegistry): FastModeDecision;
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
  modelRegistry?: FastModeAuthRegistry;
};

export type FastModeExtensionHooks = Readonly<{
  appendEntry(type: string, data: Readonly<Record<string, boolean | number | string>>): void;
  onSessionStart(handler: (ctx: FastModeExtensionContext) => void): void;
  onSessionTree(handler: (ctx: FastModeExtensionContext) => void): void;
  onBeforeProviderRequest(
    handler: (payload: RuntimeValue, ctx: FastModeExtensionContext) => RuntimeValue,
  ): void;
  onProviderStreamEvent?(handler: (provider: string, data: RuntimeValue) => void): void;
  onMessageEnd?(handler: (message: AgentMessage) => AgentMessage | undefined): void;
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

export function supportsFastMode(
  model: Model<Api> | undefined,
  registry?: FastModeAuthRegistry,
): boolean {
  if (xaiFastModelId(model) !== undefined || syntheticFastModelId(model) !== undefined) return true;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  if (isOpenAISubscriptionSignIn(model, registry)) return false;
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
  registry?: FastModeAuthRegistry,
): FastModeDecision {
  if (isOpenAISubscriptionSignIn(model, registry))
    return {
      ...state,
      supported: false,
      active: false,
      serviceTier: undefined,
      reason: OPENAI_SIGN_IN_FAST_REASON,
    };
  const unsupportedReason =
    xaiFastUnsupportedReason(model) ?? syntheticFastUnsupportedReason(model);
  if (unsupportedReason !== undefined)
    return {
      ...state,
      supported: false,
      active: false,
      serviceTier: undefined,
      reason: unsupportedReason,
    };
  const fastModelId = xaiFastModelId(model) ?? syntheticFastModelId(model);
  if (fastModelId !== undefined)
    return {
      ...state,
      supported: true,
      active: state.requested,
      serviceTier: undefined,
      fastModelId,
    };
  const supported = supportsFastMode(model, registry);
  return {
    ...state,
    supported,
    active: state.requested && supported,
    serviceTier: supported ? (state.requested ? "priority" : "standard") : undefined,
  };
}

export function applyFastModeRequest(
  payload: RuntimeValue,
  decision: FastModeDecision | undefined,
  model: Model<Api> | undefined,
): RuntimeValue {
  if (!decision || !isJsonRecord(payload)) return undefined;
  if (decision.reason === OPENAI_SIGN_IN_FAST_REASON) {
    if (!("service_tier" in payload)) return undefined;
    const { service_tier: _ignored, ...rest } = payload;
    return rest;
  }
  if (!decision.supported) return undefined;
  if (decision.fastModelId !== undefined) {
    if (
      !decision.active ||
      model === undefined ||
      payload.model !== model.id ||
      decision.fastModelId === payload.model
    )
      return undefined;
    return { ...payload, model: decision.fastModelId };
  }
  if (decision.active) return { ...payload, service_tier: "priority" };
  const { service_tier: _standard, ...standard } = payload;
  return standard;
}

export type XaiFastPricing = Readonly<{
  observe(provider: string, data: RuntimeValue): void;
  apply(message: AgentMessage): AssistantMessage | undefined;
}>;

const XAI_FAST_PRICING_CAPACITY = 64;

export function createXaiFastPricing(): XaiFastPricing {
  const fastIds = new Set(XAI_FAST_MODEL_IDS.values());
  const confirmed = new Map<string, string>();
  return {
    observe(provider, data) {
      if (provider !== "xai" || !isJsonRecord(data) || !isJsonRecord(data.response)) return;
      const { id, model } = data.response;
      if (!isString(id) || !isString(model) || !fastIds.has(model)) return;
      confirmed.delete(id);
      confirmed.set(id, model);
      for (const stale of confirmed.keys()) {
        if (confirmed.size <= XAI_FAST_PRICING_CAPACITY) break;
        confirmed.delete(stale);
      }
    },
    apply(message) {
      if (message.role !== "assistant" || message.provider !== "xai") return undefined;
      if (message.responseId === undefined) return undefined;
      const fast = confirmed.get(message.responseId);
      if (fast === undefined) return undefined;
      confirmed.delete(message.responseId);
      if (XAI_FAST_MODEL_IDS.get(message.model) !== fast || message.responseModel === fast)
        return undefined;
      const cost = message.usage.cost;
      const input = cost.input * XAI_FAST_PRICE_MULTIPLIER;
      const output = cost.output * XAI_FAST_PRICE_MULTIPLIER;
      const cacheRead = cost.cacheRead * XAI_FAST_PRICE_MULTIPLIER;
      const cacheWrite = cost.cacheWrite * XAI_FAST_PRICE_MULTIPLIER;
      return {
        ...message,
        responseModel: fast,
        usage: {
          ...message.usage,
          cost: {
            input,
            output,
            cacheRead,
            cacheWrite,
            total: input + output + cacheRead + cacheWrite,
          },
        },
      };
    },
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
        decide: (model, registry = input.modelRegistry) => decideFastMode(state, model, registry),
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
          onProviderStreamEvent: (handler) =>
            pi.on("provider_stream_event", (event) => handler(event.provider, event.data)),
          onMessageEnd: (handler) =>
            pi.on("message_end", (event) => {
              const message = handler(event.message);
              return message ? { message } : undefined;
            }),
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
      modelRegistry: ctx.modelRegistry ?? input.modelRegistry,
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
    return applyFastModeRequest(
      payload,
      controller?.decide(ctx.model, ctx.modelRegistry),
      ctx.model,
    );
  });
  const pricing = createXaiFastPricing();
  hooks.onProviderStreamEvent?.((provider, data) => pricing.observe(provider, data));
  hooks.onMessageEnd?.((message) => pricing.apply(message));
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
