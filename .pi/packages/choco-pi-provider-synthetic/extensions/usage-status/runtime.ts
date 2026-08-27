import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  SYNTHETIC_CONFIG_UPDATED_EVENT,
  SYNTHETIC_EXTENSIONS_REGISTER_EVENT,
  SYNTHETIC_EXTENSIONS_REQUEST_EVENT,
  SyntheticConfigUpdatedPayloadSchema,
} from "../../src/config-events.ts";
import { ensureSyntheticConfig, publishSyntheticConfig } from "../../src/config-state.ts";
import type { QuotasResponse, SyntheticQuotasSnapshotPayload } from "../../src/types/quotas.ts";
import { formatResetTime } from "../../src/utils/quotas.ts";
import {
  assessWindow,
  getSeverityColor,
  type RiskSeverity,
  toWindows,
} from "../../src/utils/quotas-severity.ts";
import { readQuotas, requestQuotas } from "../_shared/quota-events.ts";

const EXTENSION_ID = "synthetic-usage";

export interface UsageStatusDependencies {
  ensureConfig: typeof ensureSyntheticConfig;
  publishConfig: typeof publishSyntheticConfig;
  read: typeof readQuotas;
  request: typeof requestQuotas;
}

const DEFAULT_DEPENDENCIES: UsageStatusDependencies = {
  ensureConfig: ensureSyntheticConfig,
  publishConfig: publishSyntheticConfig,
  read: readQuotas,
  request: requestQuotas,
};

type WindowStatus = {
  label: string;
  usedPercent: number;
  severity: RiskSeverity;
  resetsAt: string | null;
  limited: boolean;
};

function parseSnapshot(quotas: QuotasResponse): WindowStatus[] {
  const windows = toWindows(quotas);
  return windows.map((w) => {
    const assessment = assessWindow(w);
    return {
      label: w.label,
      usedPercent: w.usedPercent,
      severity: assessment.severity,
      resetsAt: w.resetsAt.toISOString(),
      limited: w.limited ?? false,
    };
  });
}

const SHORT_LABELS = new Map<string, string>([
  ["Credits / week", "week"],
  ["Requests / 5h", "5h"],
  ["Search / hour", "search"],
  ["Free Tool Calls / day", "tools"],
]);

function formatStatus(ctx: ExtensionContext, windows: WindowStatus[]): string {
  const theme = ctx.ui.theme;
  const parts: string[] = [];

  for (const w of windows) {
    const short = SHORT_LABELS.get(w.label) ?? w.label;
    const remaining = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
    const color = getSeverityColor(w.severity);
    const pctText = theme.fg(color, `${remaining}%`);
    const reset = w.resetsAt ? theme.fg("dim", ` (\u21ba${formatResetTime(w.resetsAt)})`) : "";
    const limitTag = w.limited ? theme.fg("error", " [limited]") : "";
    parts.push(`${theme.fg("dim", `${short}:`)}${pctText}${reset}${limitTag}`);
  }

  return parts.join(" ");
}

export async function activateUsageStatus(
  pi: ExtensionAPI,
  dependencies: UsageStatusDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  let enabled = (await dependencies.ensureConfig()).usageStatus;
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

  function renderSnapshot(
    ctx: ExtensionContext,
    snapshot: SyntheticQuotasSnapshotPayload | undefined,
  ): void {
    if (!ctx.hasUI) return;
    if (!snapshot) {
      ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg("dim", "loading usage..."));
      return;
    }

    const windows = parseSnapshot(snapshot.quotas);
    if (windows.length === 0) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      return;
    }

    ctx.ui.setStatus(EXTENSION_ID, formatStatus(ctx, windows));
  }

  function clearStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(EXTENSION_ID, undefined);
  }

  function renderFromStoreOrRefresh(ctx: ExtensionContext, capturedGeneration: number): void {
    if (!isCurrent(capturedGeneration)) return;
    if (!enabled || ctx.model?.provider !== "synthetic") {
      clearStatus(ctx);
      return;
    }
    dependencies.read(pi, (snapshot) => {
      if (!isCurrent(capturedGeneration)) return;
      if (snapshot) {
        renderSnapshot(ctx, snapshot);
      } else {
        renderSnapshot(ctx, undefined); // show loading
        dependencies.request(pi, (refreshed) => {
          if (!isCurrent(capturedGeneration)) return;
          renderSnapshot(ctx, refreshed);
        });
      }
    });
  }

  pi.events.on(SYNTHETIC_CONFIG_UPDATED_EVENT, (data) => {
    if (!Value.Check(SyntheticConfigUpdatedPayloadSchema, data)) return;
    enabled = data.config.usageStatus;
    dependencies.publishConfig(data.config);
  });

  pi.on("session_start", (_event, ctx) => {
    renderFromStoreOrRefresh(ctx, startSession());
  });

  pi.on("model_select", (_event, ctx) => {
    if (activeGeneration !== undefined) renderFromStoreOrRefresh(ctx, activeGeneration);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (activeGeneration !== undefined) renderFromStoreOrRefresh(ctx, activeGeneration);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (activeGeneration !== undefined) renderFromStoreOrRefresh(ctx, activeGeneration);
  });

  pi.on("session_before_switch", (_event, ctx) => {
    clearStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    invalidateSession();
    clearStatus(ctx);
  });

  pi.events.on(SYNTHETIC_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, {
      feature: "usageStatus",
    });
  });
}

export default activateUsageStatus;
