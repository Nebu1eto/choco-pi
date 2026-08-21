import { isString, type RuntimeValue } from "./lib/runtime-values.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";
import {
  AGENT_OUTCOME_PREFIX,
  getPreferencesProvider,
  readAgentPreferences,
  type PreferencesExtraSection,
  type PreferencesPanelHandle,
  type PreferencesProvider,
} from "./lib/agent-preferences.ts";
import {
  agentPreferencesCompletions,
  buildAgentPreferencesSection,
  resolveAgentPreferencesArgs,
  runAgentPreferencesOutcome,
} from "./lib/agent-preferences-dialog.ts";
import {
  buildCodexPreferencesSections,
  CODEX_OUTCOME_PREFIX,
  getCodexPreferencesProvider,
} from "./lib/codex-preferences.ts";
import {
  buildNativeSettingsSections,
  createHostCommandContext,
  installNativeSettingsBridge,
  openNativeSettingsMenu,
  type NativeSettingsHost,
} from "./lib/native-settings.ts";
import { formatStatus, summarizeStatusRows } from "./session-status.ts";
import { usageReport } from "./provider-usage.ts";

export type StatusTabId = "status" | "usage" | "preferences";
export type TextTabId = "status" | "usage";

export const STATUS_TABS: ReadonlyArray<{ id: StatusTabId; title: string }> = [
  { id: "status", title: "Status" },
  { id: "usage", title: "Usage" },
  { id: "preferences", title: "Preferences" },
];

/** How often an open Usage tab re-queries the providers. */
export const USAGE_REFRESH_MS = 3 * 60_000;

/** Tabs whose body comes from a remote provider and therefore goes stale while the view stays open. */
const AUTO_REFRESH_TABS: ReadonlySet<TextTabId> = new Set<TextTabId>(["usage"]);

export type TabController = {
  /** Switch to a tab, repaint the last body, and re-query it. */
  activate: (id: TextTabId) => void;
  /** Stop the refresh timer. */
  dispose: () => void;
};

/**
 * Keeps the visible tab body current: every activation re-queries the tab, and
 * an auto-refreshing tab is re-queried again every `intervalMs` while it stays
 * open. A cached body is painted immediately so a refetch never blanks the view,
 * and a failed background refresh keeps the last good body instead of replacing it.
 */
export function createTabController(options: {
  load: (id: TextTabId) => Promise<string>;
  paint: (body: string, view: { preserveScroll: boolean }) => void;
  loading: string;
  failure: (id: TextTabId, message: string) => string;
  intervalMs?: number;
}): TabController {
  const cache = new Map<TextTabId, string>();
  const intervalMs = options.intervalMs ?? USAGE_REFRESH_MS;
  let active: TextTabId | undefined;
  let token = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const query = (id: TextTabId, background: boolean): void => {
    const current = ++token;
    options
      .load(id)
      .then((body) => {
        cache.set(id, body);
        if (current === token && active === id) options.paint(body, { preserveScroll: background });
      })
      .catch((error: RuntimeValue) => {
        if (current !== token || active !== id || cache.has(id)) return;
        const message = error instanceof Error ? error.message : String(error);
        options.paint(options.failure(id, message), { preserveScroll: background });
      });
  };
  const restartTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = setInterval(() => {
      if (active !== undefined && AUTO_REFRESH_TABS.has(active)) query(active, true);
    }, intervalMs);
    timer.unref?.();
  };
  return {
    activate: (id: TextTabId) => {
      active = id;
      options.paint(cache.get(id) ?? options.loading, { preserveScroll: false });
      restartTimer();
      query(id, false);
    },
    dispose: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      token++;
    },
  };
}

export function tabBody(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  id: TextTabId,
  styled: boolean,
): Promise<string> {
  const style = styled ? ctx.ui.theme : undefined;
  if (id === "usage") {
    return usageReport(ctx).then((report) => (style ? style.fg("text", report) : report));
  }
  return Promise.resolve(formatStatus(summarizeStatusRows(ctx, thinkingLevel), style));
}

type PreferencesFocus = { section?: string; focusId?: string };

const PREFERENCES_USAGE =
  "Usage: /preferences [editor|messages|statusline|viewport-indicators] [enable|disable|toggle], /preferences [messages|user-messages|working-line|agent], /preferences [language <name>|style <name>], or /preferences format <template>";

/**
 * Every section the Preferences tab hosts on top of the panel's own choco-ui
 * sections. Most contribute rows to an existing section; the ones that own a
 * tab appear in this order, after the choco-ui tabs: Terminal, Session, Model,
 * Tools, Agent. The agent section goes last so the Codex adapter rows that
 * merge into it sit at the end of the strip.
 *
 * Pi's rows come before the Codex ones in every shared section: they read as
 * the section's own settings, which leaves the Codex heading as the only
 * marker a merged block needs.
 */
function buildPreferencesExtraSections(ctx: ExtensionCommandContext): PreferencesExtraSection[] {
  return [
    ...buildNativeSettingsSections(),
    ...buildCodexPreferencesSections(ctx),
    buildAgentPreferencesSection(ctx),
  ];
}

/**
 * Sections rendered inside another one, source to target. User messages and the
 * footer describe the same screen furniture as Appearance, and the segment and
 * git rows only configure that footer, so all four read better as headed blocks
 * of one tab than as four tabs.
 */
const PREFERENCES_SECTION_MERGES = {
  userMessages: "appearance",
  footer: "appearance",
  extensions: "appearance",
} satisfies Record<string, string>;

/** Tab order; sections left out keep their natural position after these. */
const PREFERENCES_SECTION_ORDER = [
  "model",
  "agent",
  "session",
  "appearance",
  "editor",
  "terminal",
  "tools",
];

/** Non-TUI surface for /preferences: a text summary of the agent preferences. */
function preferencesSummary(ctx: ExtensionCommandContext): void {
  try {
    const preferences = readAgentPreferences();
    ctx.ui.notify(
      [
        `Agent language: ${preferences.language ?? "match user"}`,
        `Agent style: ${preferences.style ?? "default"}`,
        "Run /preferences in the interactive TUI to change preferences.",
      ].join("\n"),
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not read agent preferences: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

/**
 * One pass of the Status/Usage/Preferences dialog. Resolves `undefined` when
 * the dialog is done; any other string is a panel outcome the caller runs
 * before reopening the dialog on the Preferences tab.
 */
async function showTabOnce(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialFocus: PreferencesFocus,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    if (initial === "preferences") {
      preferencesSummary(ctx);
      return undefined;
    }
    const body = await tabBody(ctx, thinkingLevel, initial, false);
    ctx.ui.notify(ctx.ui.theme.fg("text", body), "info");
    return undefined;
  }
  const provider = getPreferencesProvider();
  if (initial === "preferences" && !provider) {
    ctx.ui.notify("The choco-pi-ui package is not loaded; Preferences is unavailable.", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let active = initial;
    let panel: PreferencesPanelHandle | undefined;
    let rememberedSection: string | undefined = initialFocus.section;
    let rememberedFocusId: string | undefined = initialFocus.focusId;

    const text = new Text("", 0, 0);
    const component = new Box(1, 1, (value) => theme.fg("border", value));
    component.addChild(text);
    const scrollView = new ScrollView(component, {
      primary: true,
      scrollbar: "auto",
      scrollbarStyle: (value) => theme.fg("dim", value),
    });

    const header = (): string =>
      STATUS_TABS.map((tab) => {
        const label = `  ${tab.title}  `;
        return tab.id === active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
      }).join(theme.fg("dim", "·"));
    const textHint = (): string =>
      theme.fg("dim", "Tab switches tabs · ↑/↓ scrolls · 1/2/3 jumps · Enter/Esc closes");
    // An open submenu holds Tab and the digits, so the hint must not promise them.
    const panelHint = (): string =>
      theme.fg(
        "dim",
        panel?.hasOpenSubmenu?.()
          ? "Esc goes back"
          : "Tab switches tabs · 1/2/3 jumps · Esc closes",
      );

    const paint = (body: string, view: { preserveScroll: boolean }): void => {
      text.setText(`${header()}\n\n${body}\n\n${textHint()}`);
      if (!view.preserveScroll) scrollView.scrollToStart();
      tui.requestRender();
    };

    const controller = createTabController({
      load: (id) => tabBody(ctx, thinkingLevel, id, true),
      paint,
      loading: theme.fg("dim", "Loading…"),
      failure: (id, message) => theme.fg("error", `Failed to load the ${id} tab: ${message}`),
    });

    const finish = (outcome?: string): void => {
      panel?.dispose();
      panel = undefined;
      controller.dispose();
      done(outcome);
    };

    const closePanel = (): void => {
      if (!panel) return;
      rememberedSection = panel.getActiveSection();
      rememberedFocusId = undefined;
      panel.dispose();
      panel = undefined;
    };

    const openPanel = (): void => {
      if (panel || !provider) return;
      const panelOptions: Parameters<PreferencesProvider["createPanel"]>[0] = {
        ctx,
        tui,
        theme,
        extraSections: buildPreferencesExtraSections(ctx),
        mergeSections: PREFERENCES_SECTION_MERGES,
        sectionOrder: PREFERENCES_SECTION_ORDER,
        onOutcome: (outcome) => {
          finish(outcome === "close" ? undefined : outcome);
        },
      };
      if (rememberedSection !== undefined) panelOptions.initialSection = rememberedSection;
      if (rememberedFocusId !== undefined) panelOptions.initialFocusId = rememberedFocusId;
      panel = provider.createPanel(panelOptions);
      rememberedFocusId = undefined;
    };

    const activate = (id: StatusTabId): void => {
      if (active === id) return;
      if (active === "preferences") closePanel();
      active = id;
      if (id === "preferences") openPanel();
      else controller.activate(id);
      tui.requestRender();
    };

    const switchTab = (delta: -1 | 1): void => {
      const index = STATUS_TABS.findIndex((tab) => tab.id === active);
      const next = STATUS_TABS[(index + delta + STATUS_TABS.length) % STATUS_TABS.length];
      activate(next.id);
    };

    const jumpToTab = (index: number): void => {
      const tab = STATUS_TABS[index];
      if (tab) activate(tab.id);
    };

    if (initial === "preferences") openPanel();
    else controller.activate(initial);

    return {
      render: (width: number) => {
        if (active === "preferences") {
          const rows = [header(), ""];
          if (panel) rows.push(...panel.render(width));
          else
            rows.push(
              theme.fg("dim", "The choco-pi-ui package is not loaded; Preferences is unavailable."),
            );
          rows.push("", panelHint());
          return rows;
        }
        return scrollView.render(width);
      },
      invalidate: () => {
        scrollView.invalidate();
        panel?.invalidate();
      },
      dispose: () => {
        panel?.dispose();
        controller.dispose();
      },
      handleInput: (data: string) => {
        // A panel submenu, such as the model picker, needs every key it can
        // get: no tab switching or digit jumps while one is open.
        if (active === "preferences" && panel?.hasOpenSubmenu?.()) {
          panel.handleInput(data);
          return;
        }
        if (data === "1" || data === "2" || data === "3") {
          jumpToTab(Number(data) - 1);
          return;
        }
        // Tab owns tab switching everywhere, so the panel keeps ←/→ for its
        // own sections and never sees these two keys.
        if (matchesKey(data, "tab")) {
          switchTab(1);
          return;
        }
        if (matchesKey(data, "shift+tab")) {
          switchTab(-1);
          return;
        }
        if (active === "preferences") {
          if (panel) {
            panel.handleInput(data);
            return;
          }
          if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
            finish(undefined);
          }
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          finish(undefined);
        } else if (matchesKey(data, "up")) {
          scrollView.scrollBy(-1);
          tui.requestRender();
        } else if (matchesKey(data, "down")) {
          scrollView.scrollBy(1);
          tui.requestRender();
        } else if (matchesKey(data, "pageUp")) {
          scrollView.scrollBy(-Math.max(1, scrollView.viewportHeight - 1));
          tui.requestRender();
        } else if (matchesKey(data, "pageDown")) {
          scrollView.scrollBy(Math.max(1, scrollView.viewportHeight - 1));
          tui.requestRender();
        }
      },
    };
  });
}

async function showTab(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialFocus: PreferencesFocus = {},
): Promise<void> {
  let focus = initialFocus;
  let startTab = initial;
  for (;;) {
    const outcome = await showTabOnce(ctx, thinkingLevel, startTab, focus);
    focus = {};
    if (outcome === undefined) return;
    startTab = "preferences";
    if (outcome.startsWith(AGENT_OUTCOME_PREFIX)) {
      focus = await runAgentPreferencesOutcome(outcome, ctx);
      continue;
    }
    if (outcome.startsWith(CODEX_OUTCOME_PREFIX)) {
      const codex = getCodexPreferencesProvider();
      if (!codex) return;
      const handled = await codex.runOutcome(outcome, ctx);
      if (handled === undefined) return;
      focus = handled;
      continue;
    }
    const provider = getPreferencesProvider();
    if (!provider) return;
    const handled = await provider.runOutcome(outcome, ctx);
    if (handled === undefined) return;
    focus = handled;
  }
}

export default function statusCommands(pi: ExtensionAPI): void {
  pi.registerCommand("status", {
    description: "Show session, model, context, MCP, and environment status (Status/Usage tabs)",
    handler: async (_args, ctx) => showTab(ctx, pi.getThinkingLevel(), "status"),
  });
  const usageCommand = {
    description:
      "Show connected Claude Code, OpenAI Codex, and Synthetic usage (Status/Usage tabs)",
    handler: async (_args: string, ctx: ExtensionCommandContext) =>
      showTab(ctx, pi.getThinkingLevel(), "usage"),
  };
  pi.registerCommand("usage", usageCommand);
  pi.registerCommand("quota", usageCommand);

  const preferencesCommand = {
    description: "Adjust choco-ui and agent preferences (Status/Usage/Preferences tabs)",
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

  // Pi dispatches `/settings` itself, before extension commands, so the only way
  // to make it open this dialog is to take over the menu it would have shown.
  installNativeSettingsBridge((host: NativeSettingsHost) => {
    const hostCtx = createHostCommandContext(host);
    // Without the panel package the dialog has no Preferences tab to show, so
    // `/settings` keeps opening Pi's own menu instead of reporting nothing.
    if (hostCtx === undefined || !getPreferencesProvider()) {
      openNativeSettingsMenu(host);
      return;
    }
    // SAFETY: the host builds this context for its own command dispatch.
    const ctx = hostCtx as ExtensionCommandContext;
    void showTab(ctx, pi.getThinkingLevel(), "preferences").catch((error: RuntimeValue) => {
      ctx.ui.notify(
        `Could not open settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    });
  });
}
