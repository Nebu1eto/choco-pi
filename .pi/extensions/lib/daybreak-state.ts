import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  DAYBREAK_BRIDGE_SYMBOL,
  type DaybreakBridge,
  type DaybreakController,
  type DaybreakInitialization,
  type DaybreakOutcome,
  type DaybreakRegistration,
  type DaybreakRequest,
  type DaybreakSource,
  type DaybreakState,
} from "../../packages/choco-pi-codex/src/providers/openai-codex/daybreak-types.ts";
import { isBoolean, isFunction, isJsonRecord, isNumber } from "./runtime-values.ts";
import type { JsonRecord, RuntimeValue } from "./runtime-values.ts";

export {
  DAYBREAK_BRIDGE_SYMBOL,
  type DaybreakBridge,
  type DaybreakController,
  type DaybreakInitialization,
  type DaybreakOutcome,
  type DaybreakRegistration,
  type DaybreakRequest,
  type DaybreakSource,
  type DaybreakState,
};

export const DAYBREAK_ENTRY = "choco-pi-daybreak";
/** Request field that carries a Daybreak entitlement; only the provider finalizer may add it. */
export const DAYBREAK_ACCESS_FIELD = "access_programs";

export type DaybreakExtensionContext = Pick<ExtensionContext, "model"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
};

export type DaybreakExtensionHooks = Readonly<{
  appendEntry(type: string, data: Readonly<Record<string, boolean | number | string>>): void;
  onSessionStart(handler: (ctx: DaybreakExtensionContext) => void): void;
  onSessionTree(handler: (ctx: DaybreakExtensionContext) => void): void;
  onBeforeProviderRequest(
    handler: (payload: RuntimeValue, ctx: DaybreakExtensionContext) => RuntimeValue,
  ): void;
  onSessionShutdown(handler: () => void): void;
}>;

type StoredState = {
  controller: DaybreakController;
  owner: object;
  generation: number;
  unregisterCleanup: () => void;
};

/** A request without a confirmed entitlement is honestly unknown until a lookup succeeds. */
export function defaultDaybreakOutcome(requested: DaybreakRequest): DaybreakOutcome {
  return requested ? "pending" : "off";
}

/** Persisted request record; the entitlement outcome is deliberately absent. */
export type DaybreakEntryData = Readonly<{
  enabled: DaybreakRequest;
  source: DaybreakSource;
  revision: number;
}>;

export function daybreakEntryData(state: DaybreakState): DaybreakEntryData {
  return { enabled: state.requested, source: state.source, revision: state.revision };
}

function parseSource(value: RuntimeValue): DaybreakSource {
  if (value === "inherited" || value === "default") return value;
  return "explicit";
}

/**
 * Replays persisted Daybreak requests. Only the request is stored; the
 * entitlement outcome is never restored. A stored `default` request remains a
 * replaceable seed: a current default seed replaces its value, and a changed
 * value advances the revision so earlier entitlement lookups are invalidated.
 */
export function restoreDaybreakInitialization(
  entries: readonly SessionEntry[] | undefined,
  fallback: DaybreakInitialization,
): DaybreakInitialization & { revision: number } {
  let restored = { ...fallback, revision: 0 };
  let found = false;
  for (const entry of entries ?? []) {
    if (entry.type !== "custom" || entry.customType !== DAYBREAK_ENTRY) continue;
    const data = entry.data;
    if (!isJsonRecord(data) || !(isBoolean(data.enabled) || data.enabled === "auto")) continue;
    const revision =
      isNumber(data.revision) && Number.isSafeInteger(data.revision) && data.revision >= 0
        ? data.revision
        : restored.revision;
    restored = { requested: data.enabled, source: parseSource(data.source), revision };
    found = true;
  }
  if (
    found &&
    restored.source === "default" &&
    fallback.source === "default" &&
    restored.requested !== fallback.requested
  )
    return { requested: fallback.requested, source: "default", revision: restored.revision + 1 };
  return restored;
}

export function createDaybreakBridge(): DaybreakBridge {
  const registrations = new Map<string, StoredState>();

  const bridge: DaybreakBridge = {
    version: 1,
    register(input) {
      const existing = registrations.get(input.sessionId);
      if (existing?.owner === input.owner && existing.generation === input.generation)
        return existing.controller;

      existing?.controller.dispose();

      const initial = restoreDaybreakInitialization(input.entries, input.initial);
      let state: DaybreakState = {
        sessionId: input.sessionId,
        requested: initial.requested,
        source: initial.source,
        revision: initial.revision,
        generation: input.generation,
        outcome: defaultDaybreakOutcome(initial.requested),
      };
      const listeners = new Set<() => void>();
      const notify = (): void => {
        for (const listener of listeners) listener();
      };
      const isCurrent = (): boolean =>
        registrations.get(input.sessionId)?.controller === controller;
      const controller: DaybreakController = {
        getState: () => state,
        subscribe(listener) {
          if (!isCurrent()) return () => {};
          listeners.add(listener);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            listeners.delete(listener);
          };
        },
        set(requested, source = "explicit") {
          if (!isCurrent()) throw new Error("Daybreak controller is stale.");
          const next: DaybreakState = {
            ...state,
            requested,
            source,
            revision: state.revision + 1,
            outcome: defaultDaybreakOutcome(requested),
          };
          input.persist?.(next);
          state = next;
          notify();
          return state;
        },
        report(outcome, revision) {
          if (!isCurrent() || revision !== state.revision) return;
          // An unrequested session is always off, and a requested one cannot report off.
          if (!state.requested || outcome === "off") return;
          if (state.outcome === outcome) return;
          state = { ...state, outcome };
          notify();
        },
        dispose() {
          listeners.clear();
          const current = registrations.get(input.sessionId);
          if (current?.controller !== controller) return;
          registrations.delete(input.sessionId);
          current.unregisterCleanup();
        },
      };
      const unregisterCleanup = registerSessionResourceCleanup((sessionId) => {
        if (sessionId !== undefined && sessionId !== input.sessionId) return;
        if (isCurrent()) controller.dispose();
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
        installDaybreakExtension(bridge, input, {
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

/**
 * Removes any existing Daybreak access field from a request payload. No bridge
 * outcome attests the current auth or model, so even a previously granted
 * session is stripped; the provider finalizer adds the actual entitlement
 * afterward. Returns `undefined` when the payload needs no change.
 */
export function stripStaleDaybreakAccess(payload: RuntimeValue): JsonRecord | undefined {
  if (!isJsonRecord(payload) || !(DAYBREAK_ACCESS_FIELD in payload)) return undefined;
  const { [DAYBREAK_ACCESS_FIELD]: _stale, ...rest } = payload;
  return rest;
}

/**
 * Status text distinguishing off, an active blue/red grant, and each reason a
 * request is not applied. An unconfirmed request reads as pending.
 */
export function daybreakStatusValue(state: DaybreakState | undefined): string {
  if (!state) return "not initialized";
  if (!state.requested) return "off";
  return `${state.requested === "auto" ? "auto; " : ""}${DAYBREAK_REQUESTED_STATUS[state.outcome]}`;
}

const DAYBREAK_REQUESTED_STATUS = {
  pending: "requested; checking availability",
  blue: "on",
  red: "on",
  "not-granted": "requested; not granted for this account",
  "auth-not-eligible": "requested; current authentication is not eligible",
  "lookup-failed": "requested; Daybreak lookup failed",
  "model-not-supported": "unavailable; the current model does not support Daybreak",
  // A requested state never reports off; read it as unconfirmed.
  off: "requested; checking availability",
} satisfies Record<DaybreakOutcome, string>;

export function describeDaybreakState(state: DaybreakState | undefined): string {
  return `Daybreak: ${daybreakStatusValue(state)}`;
}

/**
 * Hidden child-session extension: registers the session's Daybreak state and
 * strips stale access fields. It never grants an entitlement itself.
 */
export function installDaybreakExtension(
  bridge: DaybreakBridge,
  input: Omit<DaybreakRegistration, "sessionId" | "entries" | "persist">,
  hooks: DaybreakExtensionHooks,
): void {
  let controller: DaybreakController | undefined;
  let generation = input.generation;
  let firstRegistration = true;
  const registerForContext = (ctx: DaybreakExtensionContext): void => {
    const entries = ctx.sessionManager.getBranch();
    const initialOverridesHistory = firstRegistration && input.initial.source !== "default";
    const registration = {
      ...input,
      sessionId: ctx.sessionManager.getSessionId(),
      generation,
      persist: (state) => hooks.appendEntry(DAYBREAK_ENTRY, daybreakEntryData(state)),
    } satisfies Omit<DaybreakRegistration, "entries">;
    controller = initialOverridesHistory
      ? bridge.register(registration)
      : bridge.register({ ...registration, entries });
    if (
      input.initial.source !== "default" &&
      (initialOverridesHistory ||
        !entries.some((entry) => entry.type === "custom" && entry.customType === DAYBREAK_ENTRY))
    )
      hooks.appendEntry(DAYBREAK_ENTRY, daybreakEntryData(controller.getState()));
    firstRegistration = false;
  };
  hooks.onSessionStart(registerForContext);
  hooks.onSessionTree((ctx) => {
    controller?.dispose();
    generation++;
    registerForContext(ctx);
  });
  hooks.onBeforeProviderRequest((payload) => stripStaleDaybreakAccess(payload));
  hooks.onSessionShutdown(() => controller?.dispose());
}

type BridgeHost = typeof globalThis & { [DAYBREAK_BRIDGE_SYMBOL]?: DaybreakBridge };

export function getDaybreakBridge(): DaybreakBridge {
  const host: BridgeHost = globalThis;
  const candidate = host[DAYBREAK_BRIDGE_SYMBOL];
  if (
    candidate?.version === 1 &&
    isFunction(candidate.register) &&
    isFunction(candidate.get) &&
    isFunction(candidate.createExtension)
  )
    return candidate;
  const bridge = createDaybreakBridge();
  host[DAYBREAK_BRIDGE_SYMBOL] = bridge;
  return bridge;
}
