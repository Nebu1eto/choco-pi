import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { formatUsageReport, readProviderUsages, resetCodexUsage } from "../../provider-usage.ts";
import { summarizeMcpServers } from "../../session-status.ts";
import { runAgentPreferencesOutcome } from "../agent-preferences-dialog.ts";
import {
  AGENT_OUTCOME_PREFIX,
  getPreferencesProvider,
  type PreferencesPanelHandle,
  type PreferencesProvider,
} from "../agent-preferences.ts";
import { CODEX_OUTCOME_PREFIX, getCodexPreferencesProvider } from "../codex-preferences.ts";
import { CodexResetError } from "../codex-resets.ts";
import { buildContextReport } from "../context-report.ts";
import { rethrowUnlessStaleContext } from "../lifecycle.ts";
import { PREFERENCES_HIDDEN_ROWS, PREFERENCES_LAYOUT } from "../preferences-layout.ts";
import { isString } from "../runtime-values.ts";
import { DEFAULT_PERIOD, DEFAULT_SCOPE, nextPeriod, toggleScope } from "../stats/aggregate.ts";
import { DEFAULT_STATS_SECTION, statsSectionAt, stepStatsSection } from "../stats/format.ts";
import {
  layoutStats,
  loadStatsSnapshot,
  peekStatsSnapshot,
  registryModelNames,
  registryPriceLookup,
  statsBody,
  statsVariant,
  type StatsSnapshot,
} from "../stats/report.ts";
import { usageReportFrame } from "../usage-report.ts";
import {
  getToolInventory,
  registerDialogClose,
  registeredMcpNames,
  rememberPromptOptions,
  statsRoots,
} from "./host-state.ts";
import {
  buildPreferencesExtraSections,
  preferencesSummary,
  type PreferencesFocus,
} from "./preferences.ts";
import {
  buildStatusReport,
  contextBody,
  loadTabBody,
  reportThenNotify,
  statsDataKey,
  statsViewOf,
  statusBody,
  type StatsTabView,
} from "./reports.ts";
import {
  clampScrollTop,
  createTabController,
  isExpandableTab,
  STATUS_TABS,
  statusTabAt,
  statsViewportRows,
  TAB_PADDING,
  TEXT_PADDING,
  type StatusTabId,
  type TabBody,
  type TabLoad,
  type TextTabId,
} from "./tabs.ts";

async function showNonTuiTab(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialExpanded: boolean,
): Promise<undefined> {
  if (initial === "preferences") {
    preferencesSummary(ctx);
    return undefined;
  }
  if (initial === "status") {
    const cwd = ctx.cwd;
    const names = registeredMcpNames();
    const owner = ctx.sessionManager;
    const currentSessionId = owner.getSessionId.bind(owner);
    const sessionId = currentSessionId();
    const label = await summarizeMcpServers(cwd, names);
    if (currentSessionId() !== sessionId) return undefined;
    rememberPromptOptions(ctx, sessionId);
    const body = statusBody(ctx, thinkingLevel, undefined, initialExpanded, label);
    reportThenNotify(ctx, () => buildStatusReport(ctx, thinkingLevel, label), body);
    return undefined;
  }
  if (initial === "stats") {
    const owner = ctx.sessionManager;
    const currentSessionId = owner.getSessionId.bind(owner);
    const sessionId = currentSessionId();
    const view = statsViewOf("");
    const body = await statsBody({
      cwd: ctx.cwd,
      roots: statsRoots(),
      view: { period: view.period, scope: view.scope, expanded: initialExpanded },
      priceLookup: registryPriceLookup(ctx.modelRegistry),
      modelNames: registryModelNames(ctx.modelRegistry),
    });
    if (currentSessionId() !== sessionId) return undefined;
    ctx.ui.notify(body, "info");
    return undefined;
  }
  if (initial === "context") {
    rememberPromptOptions(ctx, ctx.sessionManager.getSessionId());
    const inventory = getToolInventory();
    const body = contextBody(ctx, initialExpanded, false);
    reportThenNotify(
      ctx,
      inventory
        ? () => buildContextReport(inventory, ctx, ctx.getSystemPromptOptions())
        : undefined,
      body,
    );
    return undefined;
  }
  const owner = ctx.sessionManager;
  const currentSessionId = owner.getSessionId.bind(owner);
  const sessionId = currentSessionId();
  const report = await readProviderUsages(ctx);
  if (currentSessionId() !== sessionId) return undefined;
  reportThenNotify(ctx, () => usageReportFrame(sessionId, report), formatUsageReport(report));
  return undefined;
}

function createStatsLoader(
  ctx: ExtensionCommandContext,
): (tabExpanded: boolean, variant: string) => TabLoad {
  let statsShown: { key: string; snapshot: StatsSnapshot } | undefined;
  let statsRequest = 0;
  return (tabExpanded: boolean, variant: string): TabLoad => {
    const request = ++statsRequest;
    const view = statsViewOf(variant);
    const key = statsDataKey(view);
    const layout = {
      expanded: tabExpanded,
      section: view.section,
      style: ctx.ui.theme,
      modelNames: registryModelNames(ctx.modelRegistry),
    };
    if (statsShown?.key === key) return layoutStats(statsShown.snapshot, layout);
    const options = {
      cwd: ctx.cwd,
      roots: statsRoots(),
      period: view.period,
      scope: view.scope,
      priceLookup: registryPriceLookup(ctx.modelRegistry),
    };
    const ready = peekStatsSnapshot(options);
    if (ready !== undefined) {
      statsShown = { key, snapshot: ready };
      return layoutStats(ready, layout);
    }
    return loadStatsSnapshot(options).then((snapshot) => {
      if (request === statsRequest) statsShown = { key, snapshot };
      return layoutStats(snapshot, layout);
    });
  };
}

function tabDigit(data: string): number | undefined {
  const index = Number(data) - 1;
  return data.length === 1 && Number.isInteger(index) && STATUS_TABS[index] !== undefined
    ? index
    : undefined;
}

async function showTabOnce(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialFocus: PreferencesFocus,
  initialExpanded: boolean,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    return showNonTuiTab(ctx, thinkingLevel, initial, initialExpanded);
  }
  const provider = getPreferencesProvider();
  if (initial === "preferences" && !provider) {
    ctx.ui.notify("The choco-pi-ui package is not loaded; Preferences is unavailable.", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let active = initial;
    let expanded = initialExpanded;
    let statsView: StatsTabView = {
      period: DEFAULT_PERIOD,
      scope: DEFAULT_SCOPE,
      section: DEFAULT_STATS_SECTION,
    };
    const variantOf = (id: TextTabId): string => (id === "stats" ? statsVariant(statsView) : "");
    const loadStats = createStatsLoader(ctx);
    let panel: PreferencesPanelHandle | undefined;
    let rememberedSection: string | undefined = initialFocus.section;
    let rememberedFocusId: string | undefined = initialFocus.focusId;
    let rememberedOpenSubmenu = initialFocus.openSubmenu === true;

    const headerText = new Text("", 0, 0);
    const bodyText = new Text("", 0, 0);
    const hintText = new Text("", 0, 0);
    const shownText = new Map<Text, string>();
    const setText = (target: Text, value: string): void => {
      if (shownText.get(target) === value) return;
      shownText.set(target, value);
      target.setText(value);
    };
    let painted: TabBody = "";
    let paintedWidth = -1;
    let statsTop = 0;
    let statsWindow: { top: number; height: number; total: number } | undefined;
    const windowed = (lines: readonly string[], chromeRows: number): readonly string[] => {
      statsWindow = undefined;
      if (active !== "stats") return lines;
      const height = statsViewportRows(tui.terminal.rows, chromeRows);
      if (lines.length <= height)
        return [...lines, ...Array<string>(height - lines.length).fill("")];
      statsTop = clampScrollTop(statsTop, lines.length, height);
      statsWindow = { top: statsTop, height, total: lines.length };
      return lines.slice(statsTop, statsTop + height);
    };
    const scrollStats = (delta: number): void => {
      const window = statsWindow;
      if (!window) return;
      statsTop = clampScrollTop(statsTop + delta, window.total, window.height);
      tui.requestRender();
    };
    let textFrame:
      | { header: readonly string[]; bodyTop: number; body: readonly string[] }
      | undefined;

    const header = (): string =>
      STATUS_TABS.map((tab) => {
        const padding = " ".repeat(TAB_PADDING);
        const label = `${padding}${tab.title}${padding}`;
        return tab.id === active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
      }).join(theme.fg("dim", "·"));
    const digitHint = STATUS_TABS.map((_tab, index) => index + 1).join("/");
    const textHint = (window: typeof statsWindow): string => {
      const parts = ["Tab switches tabs", "↑/↓ scrolls", `${digitHint} jumps`];
      if (active === "stats" && window) {
        const { top, height, total } = window;
        parts[1] = `↑/↓ scrolls (${top + 1}–${top + height}/${total})`;
      }
      if (active === "usage") parts.push("r uses a saved ChatGPT reset (openai-codex login)");
      if (active === "stats")
        parts.push("←/→ switches section", "r cycles period", "p toggles scope");
      if (isExpandableTab(active)) parts.push(expanded ? "Ctrl+O collapses" : "Ctrl+O expands");
      parts.push("Enter/Esc closes");
      return theme.fg("dim", parts.join(" · "));
    };
    const panelHint = (): string => {
      let hint = `Tab switches tabs · ${digitHint} jumps · Esc closes`;
      if (panel?.hasOpenSubmenu?.()) hint = "Esc goes back";
      else if (panel?.hasActiveSearch?.())
        hint = "Type to filter · Enter/Space changes · Esc stops search";
      return theme.fg("dim", hint);
    };

    const bodyView: Component = {
      render: (width) => {
        if (!isString(painted) && width !== paintedWidth) {
          paintedWidth = width;
          bodyText.setText(painted(width));
        }
        const lines = bodyText.render(width);
        setText(headerText, header());
        const headerRows = headerText.render(width);
        setText(hintText, textHint({ top: lines.length - 1, height: 1, total: lines.length }));
        const body = windowed(lines, headerRows.length + hintText.render(width).length);
        setText(hintText, textHint(statsWindow));
        textFrame = { header: headerRows, bodyTop: headerRows.length + 1, body };
        const blank = " ".repeat(width);
        return [...headerRows, blank, ...body, blank, ...hintText.render(width)];
      },
      invalidate: () => {
        headerText.invalidate();
        bodyText.invalidate();
        hintText.invalidate();
      },
    };
    const component = new Box(TEXT_PADDING, TEXT_PADDING, (value) => theme.fg("border", value));
    component.addChild(bodyView);
    const scrollView = new ScrollView(component, {
      primary: true,
      scrollbar: "auto",
      scrollbarTrackStyle: (value) => theme.fg("dim", value),
      scrollbarThumbStyle: (value) => theme.fg("text", value),
    });

    const paint = (body: TabBody, view: { preserveScroll: boolean }): void => {
      painted = body;
      paintedWidth = -1;
      if (isString(body)) bodyText.setText(body);
      if (!view.preserveScroll) {
        scrollView.scrollToStart();
        statsTop = 0;
      }
      tui.requestRender();
    };

    const controller = createTabController({
      load: (id, view, variant) =>
        id === "stats"
          ? loadStats(view, variant)
          : loadTabBody(ctx, thinkingLevel, id, view, variant),
      paint,
      loading: () => theme.fg("dim", "Loading…"),
      failure: (id, message) => theme.fg("error", `Failed to load the ${id} tab: ${message}`),
    });

    let finished = false;
    let unregisterClose = (): void => {};
    const finish = (outcome?: string): void => {
      if (finished) return;
      finished = true;
      unregisterClose();
      panel?.dispose();
      panel = undefined;
      controller.dispose();
      done(outcome);
    };
    unregisterClose = registerDialogClose(() => finish());

    const closePanel = (): void => {
      if (!panel) return;
      rememberedSection = panel.getActiveSection();
      rememberedFocusId = undefined;
      rememberedOpenSubmenu = false;
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
        layout: PREFERENCES_LAYOUT,
        hiddenRows: PREFERENCES_HIDDEN_ROWS,
        onOutcome: (outcome) => {
          finish(outcome === "close" ? undefined : outcome);
        },
      };
      if (rememberedSection !== undefined) panelOptions.initialSection = rememberedSection;
      if (rememberedFocusId !== undefined) panelOptions.initialFocusId = rememberedFocusId;
      if (rememberedOpenSubmenu) panelOptions.openInitialSubmenu = true;
      rememberedOpenSubmenu = false;
      panel = provider.createPanel(panelOptions);
      rememberedFocusId = undefined;
    };

    const activate = (id: StatusTabId): void => {
      if (active === id) return;
      if (active === "preferences") closePanel();
      active = id;
      if (id === "preferences") openPanel();
      else controller.activate(id, expanded, variantOf(id));
      tui.requestRender();
    };

    const changeStatsView = (next: StatsTabView): void => {
      statsView = next;
      controller.activate("stats", expanded, variantOf("stats"));
      tui.requestRender();
    };

    const toggleExpanded = (): void => {
      if (!isExpandableTab(active) || active === "preferences") return;
      expanded = !expanded;
      controller.activate(active, expanded, variantOf(active));
      tui.requestRender();
    };

    const switchTab = (delta: -1 | 1): void => {
      const index = STATUS_TABS.findIndex((tab) => tab.id === active);
      const next = STATUS_TABS[(index + delta + STATUS_TABS.length) % STATUS_TABS.length];
      activate(next.id);
    };

    if (initial === "preferences") openPanel();
    else controller.activate(initial, expanded, variantOf(initial));

    return {
      render: (width: number) => {
        if (active === "preferences") {
          const rows = [truncateToWidth(header(), width), ""];
          if (panel) rows.push(...panel.render(width));
          else
            rows.push(
              truncateToWidth(
                theme.fg(
                  "dim",
                  "The choco-pi-ui package is not loaded; Preferences is unavailable.",
                ),
                width,
              ),
            );
          rows.push("", truncateToWidth(panelHint(), width));
          return rows;
        }
        return scrollView.render(width);
      },
      invalidate: () => {
        controller.invalidate();
        scrollView.invalidate();
        panel?.invalidate();
      },
      dispose: () => {
        panel?.dispose();
        controller.dispose();
      },
      handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
        if (finished) return undefined;
        const leftPress = event.button === "left" && event.type === "press";
        const leftClick = event.button === "left" && event.type === "click";
        const clickTo = (act: () => void): TuiMouseEventResult | undefined => {
          if (leftClick) act();
          return leftPress || leftClick ? { handled: true, render: leftClick } : undefined;
        };
        const tabAt = (row: string, x: number): TuiMouseEventResult | undefined => {
          const tab = statusTabAt(row, x);
          if (tab === undefined || panel?.hasOpenSubmenu?.()) return undefined;
          return clickTo(() => activate(tab));
        };
        if (active === "preferences") {
          if (event.y === 0) return tabAt(header(), event.x);
          return panel?.handleMouse?.({ ...event, y: event.y - 2 });
        }
        const frame = textFrame;
        if (frame === undefined) return undefined;
        if (active === "stats" && event.type === "wheel") {
          if (statsWindow === undefined || !event.wheelDelta) return undefined;
          scrollStats(event.wheelDelta);
          return { handled: true };
        }
        const x = event.x - TEXT_PADDING;
        const y = event.y - TEXT_PADDING;
        const headerRow = frame.header[y];
        if (headerRow !== undefined) return tabAt(headerRow, x);
        const bodyRow = frame.body[y - frame.bodyTop];
        if (active !== "stats" || bodyRow === undefined) return undefined;
        const section = statsSectionAt(bodyRow, x);
        if (section === undefined) return undefined;
        return clickTo(() => {
          if (section !== statsView.section) changeStatsView({ ...statsView, section });
        });
      },
      handleInput: (data: string) => {
        if (finished) return;
        if (active === "usage" && data === "r") {
          finish("usage:reset-codex");
          return;
        }
        if (active === "stats" && data === "r") {
          changeStatsView({ ...statsView, period: nextPeriod(statsView.period) });
          return;
        }
        if (active === "stats" && data === "p") {
          changeStatsView({ ...statsView, scope: toggleScope(statsView.scope) });
          return;
        }
        if (active === "stats" && (matchesKey(data, "left") || matchesKey(data, "right"))) {
          changeStatsView({
            ...statsView,
            section: stepStatsSection(statsView.section, matchesKey(data, "left") ? -1 : 1),
          });
          return;
        }
        if (active === "preferences" && (panel?.hasOpenSubmenu?.() || panel?.hasActiveSearch?.())) {
          panel.handleInput(data);
          return;
        }
        const digit = tabDigit(data);
        if (digit !== undefined) {
          const tab = STATUS_TABS[digit];
          if (tab) activate(tab.id);
          return;
        }
        if (matchesKey(data, "tab")) {
          switchTab(1);
          return;
        }
        if (matchesKey(data, "shift+tab")) {
          switchTab(-1);
          return;
        }
        if (matchesKey(data, "ctrl+o")) {
          toggleExpanded();
          return;
        }
        if (active === "preferences") {
          if (panel) {
            panel.handleInput(data);
            return;
          }
          if (matchesKey(data, "enter") || matchesKey(data, "escape")) finish(undefined);
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          finish(undefined);
        } else if (active === "stats") {
          const page = Math.max(1, (statsWindow?.height ?? 1) - 1);
          if (matchesKey(data, "up")) scrollStats(-1);
          else if (matchesKey(data, "down")) scrollStats(1);
          else if (matchesKey(data, "pageUp")) scrollStats(-page);
          else if (matchesKey(data, "pageDown")) scrollStats(page);
          else if (matchesKey(data, "home")) scrollStats(-Infinity);
          else if (matchesKey(data, "end")) scrollStats(Infinity);
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

export async function showTab(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialFocus: PreferencesFocus = {},
  initialExpanded = false,
): Promise<void> {
  let focus = initialFocus;
  let startTab = initial;
  let current = true;
  const unregister = registerDialogClose(() => {
    current = false;
  });
  try {
    for (;;) {
      const outcome = await showTabOnce(ctx, thinkingLevel, startTab, focus, initialExpanded);
      if (!current) return;
      focus = {};
      if (outcome === undefined) return;
      if (outcome === "usage:reset-codex") {
        try {
          const message = await resetCodexUsage(ctx, () => current);
          if (!current) return;
          if (message) ctx.ui.notify(message, "info");
        } catch (error) {
          if (!current) return;
          if (error instanceof CodexResetError) ctx.ui.notify(error.message, "error");
          else {
            rethrowUnlessStaleContext(error);
            return;
          }
        }
        startTab = "usage";
        continue;
      }
      startTab = "preferences";
      if (outcome.startsWith(AGENT_OUTCOME_PREFIX)) {
        focus = await runAgentPreferencesOutcome(outcome, ctx);
        if (!current) return;
        continue;
      }
      if (outcome.startsWith(CODEX_OUTCOME_PREFIX)) {
        const codex = getCodexPreferencesProvider();
        if (!codex) return;
        const handled = await codex.runOutcome(outcome, ctx);
        if (!current) return;
        if (handled === undefined) return;
        focus = handled;
        continue;
      }
      const provider = getPreferencesProvider();
      if (!provider) return;
      const handled = await provider.runOutcome(outcome, ctx);
      if (!current) return;
      if (handled === undefined) return;
      focus = handled;
    }
  } finally {
    unregister();
  }
}
