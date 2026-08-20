import {
  type ExtensionContext,
  getSettingsListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { CodexConversionConfigScope } from "../../adapter/activation/config-store.ts";
import type { ExecutionMode } from "../../adapter/activation/execution-mode.ts";
import { handleAboutTabInput, renderAboutTab } from "./about-tab.ts";
import { openCodexConfigInExternalEditor } from "./config-editor.ts";
import { buildConfigSettings, type ConfigSetting } from "./config-items.ts";
import { SETTINGS_TABS, type SettingsTab } from "./tabs.ts";
import { createUsageTab, type UsageTabOptions } from "./usage-tab.ts";

export interface CodexSettingsScreenOptions extends UsageTabOptions {
  initialConfig: CodexConversionConfig;
  onChange: (nextConfig: CodexConversionConfig) => boolean;
  onProjectCacheKeepalive: (enabled: boolean) => CodexConversionConfig | undefined;
  initialTab?: SettingsTab | undefined;
  configScope: {
    current: () => CodexConversionConfigScope;
    canUseFolder: boolean;
    path: () => string;
    reload: () => CodexConversionConfig;
    set: (scope: CodexConversionConfigScope) => CodexConversionConfig | undefined;
  };
}

export async function openCodexSettingsScreen(
  ctx: ExtensionContext,
  options: CodexSettingsScreenOptions,
): Promise<void> {
  let draft = options.initialConfig;
  let activeTab: SettingsTab = options.initialTab ?? "adapter";

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const usageTab = createUsageTab(ctx, options, () => tui.requestRender());
    let settingsList: SettingsList;

    const runEditConfig = async () => {
      if (!options.onChange(draft)) {
        ctx.ui.notify("Could not save settings before opening editor", "warning");
        return;
      }
      const result = await openCodexConfigInExternalEditor(
        options.configScope.path(),
        options.configScope.current() === "folder",
        () => tui.stop(),
        () => tui.start(),
        (full) => tui.requestRender(full),
      );
      if (!result.ok) {
        ctx.ui.notify(result.error, "warning");
        return;
      }
      draft = options.configScope.reload();
      options.onChange(draft);
      settingsList = createSettingsList();
      tui.requestRender(true);
    };

    const createSettingsList = () => {
      let list: SettingsList;
      const buildSettings = (): ConfigSetting[] => [
        {
          item: {
            id: "configScope",
            label: "Settings",
            currentValue: options.configScope.current() === "folder" ? "Project" : "Defaults",
            values: options.configScope.canUseFolder ? ["Defaults", "Project"] : ["Defaults"],
          },
        },
        ...(activeTab === "adapter"
          ? [
              {
                item: {
                  id: "executionMode",
                  label: "Execution mode",
                  currentValue: draft.executionMode,
                  values: ["normal", "code"],
                },
                update: (value: string, current: CodexConversionConfig) => ({
                  ...current,
                  executionMode: value as ExecutionMode,
                }),
              },
            ]
          : []),
        ...buildConfigSettings(activeTab, draft, theme, options.configScope.path()),
      ];
      list = new SettingsList(
        buildSettings().map(({ item }) => item),
        8,
        getSettingsListTheme(),
        (id, value) => {
          const definition = buildSettings().find(({ item }) => item.id === id);
          if (definition?.action === "edit-config") {
            void runEditConfig();
            return;
          }
          if (definition?.action === "project-cache-keepalive") {
            const nextDraft = options.onProjectCacheKeepalive(value === "on");
            if (nextDraft) {
              draft = nextDraft;
              for (const { item } of buildSettings()) list.updateValue(item.id, item.currentValue);
            } else {
              list.updateValue(id, definition.item.currentValue);
            }
            tui.requestRender();
            return;
          }
          if (id === "configScope") {
            const previousValue =
              options.configScope.current() === "folder" ? "Project" : "Defaults";
            const nextDraft = options.configScope.set(value === "Project" ? "folder" : "global");
            if (nextDraft) {
              draft = nextDraft;
              settingsList = createSettingsList();
            } else {
              list.updateValue(id, previousValue);
            }
            tui.requestRender(true);
            return;
          }
          if (!definition?.update) return;
          const previousValue = definition.item.currentValue;
          const nextDraft = definition.update(value, draft);
          if (options.onChange(nextDraft)) {
            draft = nextDraft;
            for (const { item } of buildSettings()) list.updateValue(item.id, item.currentValue);
          } else {
            list.updateValue(id, previousValue);
          }
          tui.requestRender();
        },
        () => done(undefined),
      );
      return list;
    };

    const activateTab = (tab: SettingsTab) => {
      activeTab = tab;
      settingsList = createSettingsList();
      if (activeTab === "usage") usageTab.ensureLoaded();
      tui.requestRender();
    };

    settingsList = createSettingsList();
    if (activeTab === "usage") usageTab.ensureLoaded();

    return {
      render: (width: number) => {
        const hasSettingsList = activeTab !== "usage" && activeTab !== "about";
        let settingsLines = hasSettingsList ? settingsList.render(width) : [];
        if (hasSettingsList)
          settingsLines = withConfigScopeDetails(
            settingsLines,
            theme,
            options.configScope.current(),
          );
        return [
          rule(width, theme, "accent"),
          formatTabs(activeTab, theme),
          rule(width, theme, "borderMuted"),
          ...(activeTab === "usage" ? usageTab.render(theme) : []),
          ...(activeTab === "about" ? renderAboutTab(theme) : []),
          "",
          ...(hasSettingsList
            ? withSettingsFooter(settingsLines, theme)
            : [theme.fg("dim", formatFooter(activeTab))]),
          rule(width, theme, "accent"),
        ].map((line) => truncateToWidth(line, width, ""));
      },
      invalidate: () => settingsList.invalidate(),
      handleInput: (data: string) => {
        if (data === "\t") {
          const currentIndex = SETTINGS_TABS.findIndex(({ id }) => id === activeTab);
          activateTab(SETTINGS_TABS[(currentIndex + 1) % SETTINGS_TABS.length]?.id ?? "adapter");
          return;
        }
        if (activeTab === "about" && handleAboutTabInput(data, ctx)) return;
        if (activeTab === "usage" && usageTab.handleInput(data)) return;
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

function rule(width: number, theme: Theme, color: "accent" | "borderMuted"): string {
  return theme.fg(color, "─".repeat(Math.max(0, width)));
}

function formatTabs(activeTab: SettingsTab, theme: Theme): string {
  return `  ${SETTINGS_TABS.map(({ id, label }) => (id === activeTab ? theme.bold(label) : theme.fg("dim", label))).join(`  ${theme.fg("dim", "/")}  `)}`;
}

function formatFooter(activeTab: SettingsTab): string {
  if (activeTab === "usage") return "  Tab to switch sections · R to refresh · Ctrl+R to use reset";
  if (activeTab === "about")
    return "  Tab to switch sections · G/C/D/I to open links · Esc to close";
  return "  Tab to switch sections · Esc to close";
}

function withSettingsFooter(lines: string[], theme: Theme): string[] {
  const next = [...lines];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.includes("Enter/Space")) {
      next[index] = theme.fg(
        "dim",
        "  Enter/Space to change · Esc to close · Tab to switch sections",
      );
      break;
    }
  }
  return next;
}

function withConfigScopeDetails(
  lines: string[],
  theme: Theme,
  scope: CodexConversionConfigScope,
): string[] {
  const next = [...lines];
  const scopeIndex = next.findIndex((line) => line.includes("Settings"));
  if (scopeIndex < 0) return next;
  const detail =
    scope === "folder"
      ? "Changes here update this project only and leave global defaults unchanged."
      : "Changes here update global defaults. Projects with their own .pi/choco-pi-codex.json keep their settings.";
  next.splice(scopeIndex + 1, 0, theme.fg("dim", `  ${detail}`));
  return next;
}
