import {
  InteractiveMode,
  type AgentSession,
  type CacheWarmingMode,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  agentPreferencesCompletions,
  resolveAgentPreferencesArgs,
} from "./lib/agent-preferences-dialog.ts";
import { getPreferencesProvider } from "./lib/agent-preferences.ts";
import { createProcessSources } from "./lib/host-bridge/sources.ts";
import { isStaleContextError } from "./lib/lifecycle.ts";
import {
  createHostCommandContext,
  hostThinkingLevel,
  installNativeSettingsBridge,
  openNativeSettingsMenu,
  type NativeSettingsFocus,
  type NativeSettingsHost,
} from "./lib/native-settings.ts";
import { isString, reinterpretHostValue, type RuntimeValue } from "./lib/runtime-values.ts";
import { showTab } from "./lib/status-commands/dialog.ts";
import {
  closeOpenDialogs,
  setCacheWarmingSource,
  setToolInventory,
} from "./lib/status-commands/host-state.ts";
import {
  PREFERENCES_USAGE,
  preferencesSummary,
  type PreferencesFocus,
} from "./lib/status-commands/preferences.ts";
import { registerReportAutoPublish } from "./lib/status-commands/reports.ts";
import type { TextTabId } from "./lib/status-commands/tabs.ts";

export {
  clampScrollTop,
  createTabController,
  isExpandableTab,
  renderTabBody,
  STATS_VIEWPORT_ROWS,
  STATUS_TABS,
  statusTabAt,
  statsViewportRows,
  USAGE_REFRESH_MS,
  type StatusTabId,
  type TabBody,
  type TabController,
  type TextTabId,
} from "./lib/status-commands/tabs.ts";
export {
  buildStatusReport,
  registerReportAutoPublish,
  REPORT_DEBOUNCE_MS,
  statusBody,
  tabBody,
  USAGE_REPORT_INTERVAL_MS,
  type ReportAutoPublishOptions,
} from "./lib/status-commands/reports.ts";

export default function statusCommands(pi: ExtensionAPI): void {
  const sources = createProcessSources();
  if (!sources.inChildLoad()) setToolInventory(pi);
  registerReportAutoPublish(pi, {
    host: process.env.CHOCO_PI_HOST,
    inChildLoad: sources.inChildLoad(),
    isChildSession: (sessionId) => sources.isChildSession(sessionId),
  });
  pi.on("session_start", closeOpenDialogs);
  pi.on("session_shutdown", closeOpenDialogs);
  pi.registerCommand("status", {
    description:
      "Show session info, cost, model, context, MCP, and environment (Status/Context/Usage/Statistics tabs)",
    handler: async (_args, ctx) => showTab(ctx, pi.getThinkingLevel(), "status"),
  });
  overrideSessionCommand();
  const usageCommand = {
    description:
      "Show connected Claude, ChatGPT, Google, Grok, and Synthetic usage (Status/Context/Usage/Statistics tabs)",
    handler: async (_args: string, ctx: ExtensionCommandContext) =>
      showTab(ctx, pi.getThinkingLevel(), "usage"),
  };
  pi.registerCommand("usage", usageCommand);
  pi.registerCommand("quota", usageCommand);

  const preferencesCommand = {
    description: "Adjust choco-ui and agent preferences (Preferences tab of /status)",
    getArgumentCompletions: (prefix: string) => {
      const agent = agentPreferencesCompletions(prefix);
      if (agent.length > 0) return agent;
      const fromPanel = getPreferencesProvider()?.completions(prefix);
      return Array.isArray(fromPanel) && fromPanel.length > 0 ? fromPanel : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const text = isString(args) ? args : "";
      if (ctx.mode !== "tui") {
        preferencesSummary(ctx);
        return;
      }
      let focus: PreferencesFocus = {};
      const agentResolution = resolveAgentPreferencesArgs(text, ctx);
      if (agentResolution) {
        if (!agentResolution.open) return;
        if (agentResolution.section !== undefined) focus.section = agentResolution.section;
        if (agentResolution.focusId !== undefined) focus.focusId = agentResolution.focusId;
      } else {
        const provider = getPreferencesProvider();
        if (!provider) {
          ctx.ui.notify(
            text.trim()
              ? PREFERENCES_USAGE
              : "The choco-pi-ui package is not loaded; Preferences is unavailable.",
            "warning",
          );
          return;
        }
        const resolved = await provider.resolveArgs(text, ctx);
        if (resolved === undefined) {
          ctx.ui.notify(PREFERENCES_USAGE, "warning");
          return;
        }
        if (!resolved.open) return;
        if (resolved.section !== undefined) focus.section = resolved.section;
        if (resolved.focusId !== undefined) focus.focusId = resolved.focusId;
      }
      await showTab(ctx, pi.getThinkingLevel(), "preferences", focus);
    },
  };
  pi.registerCommand("preferences", preferencesCommand);
  pi.registerCommand("pref", preferencesCommand);

  installNativeSettingsBridge(
    (host: NativeSettingsHost, focus?: NativeSettingsFocus) => {
      const hostCtx = createHostCommandContext(host);
      const thinkingLevel = hostThinkingLevel(host);
      if (hostCtx === undefined || thinkingLevel === undefined || !getPreferencesProvider()) {
        openNativeSettingsMenu(host);
        return;
      }
      // SAFETY: the host builds this context for its own command dispatch.
      const ctx = hostCtx as ExtensionCommandContext;
      void showTab(ctx, thinkingLevel, "preferences", focus ?? {}).catch((error: RuntimeValue) => {
        if (isStaleContextError(error)) return;
        ctx.ui.notify(
          `Could not open settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
    },
    { inChildLoad: sources.inChildLoad() },
  );
}

type SessionCommandHost = {
  handleSessionCommand: () => void;
  run: () => Promise<void>;
  session: Pick<AgentSession, "cacheWarmingStatus"> & {
    prompt: (text: string) => Promise<void>;
  };
  settingsManager: { getCacheWarmingMode(): CacheWarmingMode };
  __chocoPiSessionCommandApplied?: boolean;
};

function overrideSessionCommand(): void {
  const prototype = reinterpretHostValue<SessionCommandHost>(InteractiveMode.prototype);
  if (prototype.__chocoPiSessionCommandApplied) return;
  const run = prototype.run;
  prototype.run = function captureStatusHost(this: SessionCommandHost): Promise<void> {
    // SAFETY: `run` is InteractiveMode's public entry point (interactive-mode.d.ts), and
    setCacheWarmingSource(this);
    return run.call(this);
  };
  prototype.handleSessionCommand = function openStatusDialog(this: SessionCommandHost) {
    setCacheWarmingSource(this);
    void this.session.prompt("/status");
  };
  prototype.__chocoPiSessionCommandApplied = true;
}

export async function openPreferencesPicker(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  focus: NativeSettingsFocus,
): Promise<boolean> {
  if (ctx.mode !== "tui" || !getPreferencesProvider()) return false;
  await showTab(ctx, thinkingLevel, "preferences", focus);
  return true;
}

export async function openStatusTab(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  tab: TextTabId,
  expanded = false,
): Promise<void> {
  await showTab(ctx, thinkingLevel, tab, {}, expanded);
}
