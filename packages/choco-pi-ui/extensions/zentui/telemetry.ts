import { type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type BoundaryValue, isBoolean, isCallable } from "./runtime-values";

export type FooterTelemetry = {
  subscription?: boolean;
  autoCompaction?: boolean;
};

type SettingsManagerLike = {
  drainErrors?: () => BoundaryValue[];
  getCompactionEnabled?: () => BoundaryValue;
};

type SettingsManagerFactory = {
  create?: (
    cwd: string,
    agentDir?: string,
    options?: { projectTrusted?: boolean },
  ) => SettingsManagerLike;
};

export type TelemetryCapabilities = {
  settingsManager?: SettingsManagerFactory;
};

function resolveSubscription(ctx: ExtensionContext): boolean | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  if (model.provider === "kimi-coding") return true;

  try {
    // SAFETY: the preceding runtime guard validates the members used through this structural view.
    const registry = ctx.modelRegistry as {
      isUsingOAuth?: (candidate: typeof model) => BoundaryValue;
    };
    if (!isCallable(registry?.isUsingOAuth)) return undefined;
    const result = registry.isUsingOAuth(model);
    return isBoolean(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function resolveAutoCompaction(
  ctx: ExtensionContext,
  factory: SettingsManagerFactory | undefined,
): boolean | undefined {
  try {
    const isProjectTrusted =
      // SAFETY: the preceding runtime guard validates the members used through this structural view.
      (
        ctx as ExtensionContext & {
          isProjectTrusted?: () => BoundaryValue;
        }
      ).isProjectTrusted;
    if (!isCallable(factory?.create) || !isCallable(isProjectTrusted)) {
      return undefined;
    }
    const trusted = isProjectTrusted.call(ctx);
    if (!isBoolean(trusted)) return undefined;
    const settings = factory.create(ctx.cwd, undefined, { projectTrusted: trusted });
    if (!isCallable(settings?.drainErrors) || !isCallable(settings.getCompactionEnabled)) {
      return undefined;
    }
    if (settings.drainErrors().length > 0) return undefined;
    const enabled = settings.getCompactionEnabled();
    return isBoolean(enabled) ? enabled : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve optional Pi telemetry without depending on private session or TUI fields. */
export function resolveFooterTelemetry(
  ctx: ExtensionContext,
  capabilities: TelemetryCapabilities = {},
): FooterTelemetry {
  const settingsManager = capabilities.settingsManager ?? SettingsManager;
  return {
    subscription: resolveSubscription(ctx),
    autoCompaction: resolveAutoCompaction(ctx, settingsManager),
  };
}
