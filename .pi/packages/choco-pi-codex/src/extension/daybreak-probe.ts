import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  beginCodexDaybreakRequest,
  getCodexDaybreakController,
  resolveCodexDaybreakTicket,
} from "../providers/openai-codex/daybreak-decision.ts";
import type { DaybreakController } from "../providers/openai-codex/daybreak-types.ts";
import { withLiveCtx } from "./live-context.ts";

export type DaybreakProbeContext = Pick<ExtensionContext, "model"> & {
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

/** One serialized lookup lane: synchronous mutations coalesce and stale flights cannot report. */
export function createCodexDaybreakProbe() {
  let epoch = 0;
  let pending: (() => Promise<void>) | undefined;
  let flight: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let subscribedController: DaybreakController | undefined;

  const drain = (): Promise<void> => {
    if (flight) return flight;
    const promise = (async () => {
      // Delay acquisition until sibling session-start handlers have registered their controller.
      await new Promise<void>((done) => setImmediate(done));
      while (pending) {
        const next = pending;
        pending = undefined;
        await next();
      }
    })().finally(() => {
      if (flight === promise) flight = undefined;
    });
    flight = promise;
    return promise;
  };

  const bind = (ctx: DaybreakProbeContext): Promise<void> => {
    const owner = ++epoch;
    const sessionId = ctx.sessionManager.getSessionId();
    const model = ctx.model ? { ...ctx.model } : undefined;
    const registry = ctx.modelRegistry;
    unsubscribe?.();
    unsubscribe = undefined;
    subscribedController = undefined;
    const initialController = getCodexDaybreakController(sessionId);
    const initialState = initialController?.getState();
    if (initialState?.requested) initialController?.report("pending", initialState.revision);
    const schedule = (): Promise<void> => {
      pending = async () => {
        if (owner !== epoch) return;
        const controller = getCodexDaybreakController(sessionId);
        if (!controller) return;
        if (subscribedController !== controller) {
          unsubscribe?.();
          subscribedController = controller;
          let observedRevision = controller.getState().revision;
          unsubscribe = controller.subscribe(() => {
            const state = controller.getState();
            if (state.revision === observedRevision) return; // report() repaints, not another lookup.
            observedRevision = state.revision;
            void schedule();
          });
        }
        const state = controller.getState();
        if (!state.requested || !model) return;
        // A model change cannot display the previous model's grant while this lookup runs.
        controller.report("pending", state.revision);
        const probeRevision = state.revision;
        const isCurrent = (): boolean =>
          owner === epoch &&
          getCodexDaybreakController(sessionId) === controller &&
          controller.getState().generation === state.generation &&
          controller.getState().revision === probeRevision;
        if (!isCurrent()) return;
        const auth = await withLiveCtx(() => registry.getApiKeyAndHeaders(model));
        if (!isCurrent() || !auth) return;
        const ticket = beginCodexDaybreakRequest({
          sessionId,
          model: auth.ok && auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
          credentials: auth.ok
            ? { apiKey: auth.apiKey, headers: auth.headers, modelHeaders: model.headers }
            : undefined,
          isCurrent,
        });
        await resolveCodexDaybreakTicket(ticket);
        if (!isCurrent()) return;
      };
      return drain();
    };
    return schedule();
  };

  const dispose = (): void => {
    epoch++;
    pending = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    subscribedController = undefined;
  };
  return { bind, dispose, settled: (): Promise<void> => flight ?? Promise.resolve() };
}

export function registerCodexDaybreakProbe(pi: ExtensionAPI): void {
  const probe = createCodexDaybreakProbe();
  // Do not block sibling handlers from registering/seeding their controller.
  pi.on("session_start", (_event, ctx) => {
    void probe.bind(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    void probe.bind(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    void probe.bind(ctx);
  });
  pi.on("session_before_switch", () => probe.dispose());
  pi.on("session_before_fork", () => probe.dispose());
  pi.on("session_shutdown", () => probe.dispose());
}
