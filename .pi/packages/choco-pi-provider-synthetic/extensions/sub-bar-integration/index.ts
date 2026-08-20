import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  configLoader,
  SYNTHETIC_CONFIG_UPDATED_EVENT,
  SYNTHETIC_EXTENSIONS_REGISTER_EVENT,
  SYNTHETIC_EXTENSIONS_REQUEST_EVENT,
  type SyntheticConfigUpdatedPayload,
} from "../../src/config";
import {
  type QuotasResponse,
  SYNTHETIC_QUOTAS_UPDATED_EVENT,
  type SyntheticQuotasUpdatedPayload,
} from "../../src/types/quotas";
import { formatResetTime } from "../../src/utils/quotas";
import {
  type QuotaWindow,
  safePercent,
  toWindows,
} from "../../src/utils/quotas-severity";
import { requestQuotas } from "../_shared/quota-events";

interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string;
  resetAt?: string;
}

interface UsageSnapshot {
  provider: string;
  displayName: string;
  windows: RateWindow[];
  lastSuccessAt?: number;
}

const SUB_BAR_LABELS: Record<string, string> = {
  weeklyTokenLimit: "Credits",
  rollingFiveHourLimit: "5h",
  "search.hourly": "Search",
  freeToolCalls: "Tools",
};

function toUsageSnapshot(quotas: QuotasResponse): UsageSnapshot {
  const windows = toWindows(quotas);

  // toWindows omits the legacy subscription-only 5h window; preserve it so
  // subscription responses still show a 5h usage bar.
  if (
    !quotas.rollingFiveHourLimit &&
    quotas.subscription?.limit &&
    quotas.subscription.limit > 0 &&
    !windows.some((w) => w.id === "rollingFiveHourLimit")
  ) {
    windows.push({
      id: "rollingFiveHourLimit",
      label: "Requests / 5h",
      usedPercent: safePercent(
        quotas.subscription.requests,
        quotas.subscription.limit,
      ),
      resetsAt: new Date(quotas.subscription.renewsAt),
      windowSeconds: 5 * 60 * 60,
      usedValue: quotas.subscription.requests,
      limitValue: quotas.subscription.limit,
      showPace: false,
    } satisfies QuotaWindow);
  }

  return {
    provider: "synthetic",
    displayName: "Synthetic",
    windows: windows.map((w) => ({
      label: SUB_BAR_LABELS[w.id] ?? w.label,
      usedPercent: Math.round(Math.max(0, Math.min(100, w.usedPercent))),
      resetDescription: formatResetTime(w.resetsAt.toISOString()),
      resetAt: w.resetsAt.toISOString(),
    })),
    lastSuccessAt: Date.now(),
  };
}

export function registerSubBarIntegration(pi: ExtensionAPI): void {
  let subCoreReady = false;
  let currentProvider: string | undefined;
  let enabled = configLoader.getConfig().subBarIntegration;

  function isSynthetic(): boolean {
    return enabled && currentProvider === "synthetic";
  }

  function emitUsage(quotas: QuotasResponse): void {
    pi.events.emit("sub-core:update-current", {
      state: {
        provider: "synthetic",
        usage: toUsageSnapshot(quotas),
      },
    });
  }

  // Receive quota updates from the provider extension
  pi.events.on(SYNTHETIC_QUOTAS_UPDATED_EVENT, (data: unknown) => {
    if (!isSynthetic() || !subCoreReady) return;
    const { quotas } = data as SyntheticQuotasUpdatedPayload;
    emitUsage(quotas);
  });

  pi.events.on(SYNTHETIC_CONFIG_UPDATED_EVENT, (data: unknown) => {
    enabled = (data as SyntheticConfigUpdatedPayload).config.subBarIntegration;

    if (!enabled) return;

    if (subCoreReady && currentProvider === "synthetic") {
      requestQuotas(pi);
    }
  });

  pi.events.on("sub-core:ready", () => {
    subCoreReady = true;
  });

  pi.on("session_start", async (_event, ctx) => {
    currentProvider = ctx.model?.provider;
  });

  pi.on("model_select", async (_event, ctx) => {
    currentProvider = ctx.model?.provider;

    if (subCoreReady && isSynthetic()) {
      requestQuotas(pi);
    }
  });

  pi.on("session_before_switch", (_event, ctx) => {
    currentProvider = ctx.model?.provider;
  });

  pi.on("session_shutdown", () => {
    currentProvider = undefined;
  });
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  registerSubBarIntegration(pi);

  pi.events.on(SYNTHETIC_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, {
      feature: "subBarIntegration",
    });
  });
}
