import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  SYNTHETIC_CONFIG_UPDATED_EVENT,
  SYNTHETIC_EXTENSIONS_REGISTER_EVENT,
  SYNTHETIC_EXTENSIONS_REQUEST_EVENT,
  SyntheticConfigUpdatedPayloadSchema,
} from "../../src/config-events.ts";
import { ensureSyntheticConfig, publishSyntheticConfig } from "../../src/config-state.ts";
import { QuotaHistory } from "../../src/services/quota-history.ts";
import { QuotaWarningNotifier } from "../../src/services/quota-warnings.ts";
import {
  SYNTHETIC_QUOTAS_UPDATED_EVENT,
  type SyntheticQuotasSnapshotPayload,
  SyntheticQuotasUpdatedPayloadSchema,
} from "../../src/types/quotas.ts";
import { buildProjectionHints } from "../../src/utils/quotas-projection.ts";
import { readQuotas, requestQuotas } from "../_shared/quota-events.ts";

export interface QuotaWarningsDependencies {
  ensureConfig: typeof ensureSyntheticConfig;
  publishConfig: typeof publishSyntheticConfig;
  createHistory: () => Pick<QuotaHistory, "initialize" | "record" | "getSnapshots" | "flush">;
  createNotifier: () => Pick<QuotaWarningNotifier, "evaluate" | "clearAlertState">;
  buildProjections: typeof buildProjectionHints;
  read: typeof readQuotas;
  request: typeof requestQuotas;
}

const DEFAULT_DEPENDENCIES: QuotaWarningsDependencies = {
  ensureConfig: ensureSyntheticConfig,
  publishConfig: publishSyntheticConfig,
  createHistory: () => new QuotaHistory(),
  createNotifier: () => new QuotaWarningNotifier(),
  buildProjections: buildProjectionHints,
  read: readQuotas,
  request: requestQuotas,
};

export async function activateQuotaWarnings(
  pi: ExtensionAPI,
  dependencies: QuotaWarningsDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  let enabled = (await dependencies.ensureConfig()).quotaWarnings;
  let generation = 0;
  let activeGeneration: number | undefined;

  function startSession(): number {
    activeGeneration = ++generation;
    return activeGeneration;
  }

  function invalidateSession(): void {
    generation += 1;
    activeGeneration = undefined;
  }

  function isCurrent(capturedGeneration: number): boolean {
    return activeGeneration === capturedGeneration;
  }

  const notifier = dependencies.createNotifier();
  const history = dependencies.createHistory();
  let historyReady = Promise.resolve();
  if (enabled) {
    historyReady = history.initialize();
    await historyReady;
  }

  async function evaluateSnapshot(
    snapshot: SyntheticQuotasSnapshotPayload,
    ctx: ExtensionContext,
    capturedGeneration: number,
  ): Promise<void> {
    await historyReady;
    if (!isCurrent(capturedGeneration)) return;
    if (!enabled || ctx.model?.provider !== "synthetic") return;

    history.record(snapshot);
    const projections = dependencies.buildProjections(history.getSnapshots());
    notifier.evaluate(
      snapshot.quotas,
      (message, level) => {
        if (!isCurrent(capturedGeneration)) return;
        ctx.ui.notify(message, level);
      },
      projections,
    );
  }

  function evaluateFromStoreOrRefresh(ctx: ExtensionContext): void {
    const capturedGeneration = activeGeneration;
    if (capturedGeneration === undefined || !isCurrent(capturedGeneration)) return;
    if (!enabled || ctx.model?.provider !== "synthetic") return;
    dependencies.read(pi, (snapshot) => {
      if (!isCurrent(capturedGeneration)) return;
      if (snapshot) {
        evaluateSnapshot(snapshot, ctx, capturedGeneration).catch(() => undefined);
      } else {
        dependencies.request(pi, (refreshed) => {
          if (!isCurrent(capturedGeneration)) return;
          if (!refreshed) return;
          evaluateSnapshot(refreshed, ctx, capturedGeneration).catch(() => undefined);
        });
      }
    });
  }

  pi.events.on(SYNTHETIC_QUOTAS_UPDATED_EVENT, (data) => {
    if (!Value.Check(SyntheticQuotasUpdatedPayloadSchema, data) || !enabled) return;
    const snapshot = data;
    historyReady
      .then(() => {
        if (enabled) history.record(snapshot);
      })
      .catch(() => undefined);
  });

  pi.events.on(SYNTHETIC_CONFIG_UPDATED_EVENT, (data) => {
    if (!Value.Check(SyntheticConfigUpdatedPayloadSchema, data)) return;
    const wasEnabled = enabled;
    enabled = data.config.quotaWarnings;
    dependencies.publishConfig(data.config);

    // Only reset alert state when the feature itself is toggled, so unrelated
    // config changes do not re-trigger one-time warnings.
    if (wasEnabled !== enabled) {
      notifier.clearAlertState();
      if (enabled) historyReady = history.initialize();
    }
  });

  // Alert transitions and quota history are account-wide, so neither is reset
  // on session/model changes. The user can toggle warnings to reset alerts.
  pi.on("session_start", (_event, ctx) => {
    startSession();
    evaluateFromStoreOrRefresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    evaluateFromStoreOrRefresh(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    evaluateFromStoreOrRefresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    evaluateFromStoreOrRefresh(ctx);
  });

  pi.on("session_before_switch", async () => {
    await history.flush();
  });

  pi.on("session_shutdown", async () => {
    invalidateSession();
    await history.flush();
  });

  pi.events.on(SYNTHETIC_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, {
      feature: "quotaWarnings",
    });
  });
}

export default activateQuotaWarnings;
