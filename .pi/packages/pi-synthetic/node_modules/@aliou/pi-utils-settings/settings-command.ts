/**
 * Settings command registration helper.
 *
 * Creates a /{name}:settings command with tabs for enabled scopes
 * and optional extra top-level tabs.
 * Changes are tracked in memory. Ctrl+S saves scope drafts,
 * Esc exits without saving.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  SectionedSettings,
  type SettingsSection,
} from "./components/sectioned-settings";
import type { ConfigStore, Scope } from "./config-loader";
import { getNestedValue, setNestedValue } from "./helpers";
import { getSettingsTheme, type SettingsTheme } from "./theme";

/** Display labels for each scope */
const SCOPE_LABELS: Record<Scope, string> = {
  global: "Global",
  local: "Local",
  memory: "Memory",
};

const ALL_SCOPE_IDS: Scope[] = ["global", "local", "memory"];

export interface ExtraSettingsTabContext<
  TConfig extends object,
  TResolved extends object,
> {
  resolved: TResolved;
  setDraftForScope: (scope: Scope, config: TConfig) => void;
  getDraftForScope: (scope: Scope) => TConfig | null;
  getRawForScope: (scope: Scope) => TConfig | null;
  enabledScopes: Scope[];
  theme: SettingsTheme;
}

export interface ExtraSettingsTab<
  TConfig extends object,
  TResolved extends object,
> {
  /** Unique tab id. Must not collide with scope ids (global/local/memory). */
  id: string;
  /** Tab label shown in top tab row. */
  label: string;
  /** Build sections for this extra tab. */
  buildSections: (
    ctx: ExtraSettingsTabContext<TConfig, TResolved>,
  ) => SettingsSection[];
}

interface ScopeTab {
  kind: "scope";
  id: Scope;
  label: string;
}

interface ExtraTab {
  kind: "extra";
  id: string;
  label: string;
}

type SettingsTab = ScopeTab | ExtraTab;

export interface SettingsCommandOptions<
  TConfig extends object,
  TResolved extends object,
> {
  /** Command name, e.g. "toolchain:settings" */
  commandName: string;
  /** Command description for the command palette. */
  commandDescription?: string;
  /** Title shown at the top of the settings UI. */
  title: string;
  /** Config store (ConfigLoader or custom implementation). */
  configStore: ConfigStore<TConfig, TResolved>;
  /**
   * Build the sections for scope tabs.
   * Called on initial render, tab switch, and after saving.
   *
   * Use ctx.setDraft in submenu onSave callbacks to store changes
   * in the draft. Use ctx.theme when you need styling helpers that
   * work for both SettingsListTheme and full Theme consumers.
   * All changes (toggles, enums, submenus) are only persisted to disk
   * on Ctrl+S.
   *
   * For memory scope, tabConfig is null when no overrides exist yet.
   * Use resolved values as display values in that case.
   */
  buildSections: (
    tabConfig: TConfig | null,
    resolved: TResolved,
    ctx: {
      setDraft: (config: TConfig) => void;
      scope: Scope;
      isInherited: (path: string) => boolean;
      theme: SettingsTheme;
    },
  ) => SettingsSection[];
  /** Optional extra tabs rendered after scope tabs. */
  extraTabs?: ExtraSettingsTab<TConfig, TResolved>[];
  /**
   * Custom change handler. Receives the setting ID, new display value,
   * and a clone of the current tab config. Return the updated config,
   * or null to skip the change.
   *
   * If not provided, the default handler stores the raw string value as-is
   * via dotted path. Use this to convert display values (e.g., "on"/"off")
   * to storage types (booleans, numbers, etc.). Return null to fall through
   * to the default string storage.
   */
  onSettingChange?: (
    id: string,
    newValue: string,
    config: TConfig,
  ) => TConfig | null;
  /**
   * Called after save succeeds. Use this to reload runtime state
   * that was captured at extension init time.
   */
  onSave?: (ctx: ExtensionCommandContext) => void | Promise<void>;
}

/** Default change handler: stores raw strings as-is via dotted path. */
export function defaultChangeHandler<TConfig extends object>(
  id: string,
  newValue: string,
  config: TConfig,
): TConfig {
  const updated = structuredClone(config);
  setNestedValue(updated, id, newValue);
  return updated;
}

/**
 * Find whether an item in the given sections has a submenu.
 * Used to distinguish value cycling (track draft) from submenu close (refresh only).
 */
function isSubmenuItem(sections: SettingsSection[], id: string): boolean {
  for (const section of sections) {
    for (const item of section.items) {
      if (item.id === id && item.submenu) return true;
    }
  }
  return false;
}

export function registerSettingsCommand<
  TConfig extends object,
  TResolved extends object,
>(pi: ExtensionAPI, options: SettingsCommandOptions<TConfig, TResolved>): void {
  const {
    commandName,
    title,
    configStore,
    buildSections,
    onSettingChange,
    onSave,
  } = options;
  const description =
    options.commandDescription ??
    `Configure ${commandName.split(":")[0]} settings`;
  const extensionLabel = commandName.split(":")[0] ?? title;

  const extraTabs = options.extraTabs ?? [];
  const allScopeIds = new Set<Scope>(ALL_SCOPE_IDS);
  const seenExtraIds = new Set<string>();
  for (const tab of extraTabs) {
    if (allScopeIds.has(tab.id as Scope)) {
      throw new Error(
        `[settings] extraTabs id "${tab.id}" collides with reserved scope id`,
      );
    }
    if (seenExtraIds.has(tab.id)) {
      throw new Error(`[settings] Duplicate extraTabs id "${tab.id}"`);
    }
    seenExtraIds.add(tab.id);
  }

  pi.registerCommand(commandName, {
    description,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const enabledScopes = configStore.getEnabledScopes();
      const scopeTabs: ScopeTab[] = enabledScopes.map((scope) => ({
        kind: "scope",
        id: scope,
        label: SCOPE_LABELS[scope],
      }));
      const extraUiTabs: ExtraTab[] = extraTabs.map((tab) => ({
        kind: "extra",
        id: tab.id,
        label: tab.label,
      }));
      const allTabs: SettingsTab[] = [...scopeTabs, ...extraUiTabs];
      const extraTabsById = new Map(extraTabs.map((tab) => [tab.id, tab]));

      if (allTabs.length === 0) {
        ctx.ui.notify("No tabs configured", "error");
        return;
      }

      // Default to first scope with existing config, else first scope, else first extra tab.
      let activeTabId: string =
        enabledScopes.find((s) => configStore.hasConfig(s)) ??
        enabledScopes[0] ??
        allTabs[0]?.id ??
        "";

      const enabledScopeIds = new Set<Scope>(enabledScopes);

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let settings: SectionedSettings | null = null;
        let currentSections: SettingsSection[] = [];
        const settingsTheme = getSettingsTheme(theme);

        // Per-scope draft configs. null = no changes from disk/memory.
        const drafts: Partial<Record<Scope, TConfig | null>> = {};
        for (const scope of enabledScopes) {
          drafts[scope] = null;
        }

        // --- Helpers ---

        function isScopeTabId(tabId: string): tabId is Scope {
          return enabledScopeIds.has(tabId as Scope);
        }

        /** Get the effective config for a scope (draft or stored). */
        function getScopeTabConfig(scope: Scope): TConfig | null {
          return drafts[scope] ?? configStore.getRawConfig(scope);
        }

        /**
         * For memory scope: check if a path has a value in memory config.
         * If not, it's inherited from lower-priority scopes.
         */
        function isInherited(scope: Scope, path: string): boolean {
          if (scope !== "memory") return false;
          const memoryConfig =
            drafts.memory ?? configStore.getRawConfig("memory");
          if (!memoryConfig) return true; // No memory config = all inherited
          return getNestedValue(memoryConfig, path) === undefined;
        }

        function setDraftForScope(scope: Scope, config: TConfig): void {
          if (!enabledScopeIds.has(scope)) {
            throw new Error(`[settings] Scope "${scope}" is not enabled`);
          }
          drafts[scope] = config;
        }

        function getDraftForScope(scope: Scope): TConfig | null {
          if (!enabledScopeIds.has(scope)) return null;
          return drafts[scope] ?? null;
        }

        function getRawForScope(scope: Scope): TConfig | null {
          if (!enabledScopeIds.has(scope)) return null;
          return configStore.getRawConfig(scope);
        }

        function isDirty(): boolean {
          return enabledScopes.some((scope) => drafts[scope] !== null);
        }

        function getSectionsForTab(tabId: string): SettingsSection[] {
          const resolved = configStore.getConfig();

          if (isScopeTabId(tabId)) {
            const tabConfig = getScopeTabConfig(tabId);
            currentSections = buildSections(tabConfig, resolved, {
              setDraft: (config) => {
                setDraftForScope(tabId, config);
              },
              scope: tabId,
              isInherited: (path) => isInherited(tabId, path),
              theme: settingsTheme,
            });
            return currentSections;
          }

          const extraTab = extraTabsById.get(tabId);
          if (!extraTab) {
            currentSections = [];
            return currentSections;
          }

          currentSections = extraTab.buildSections({
            resolved,
            setDraftForScope,
            getDraftForScope,
            getRawForScope,
            enabledScopes,
            theme: settingsTheme,
          });
          return currentSections;
        }

        function refresh(): void {
          settings?.updateSections(getSectionsForTab(activeTabId));
          tui.requestRender();
        }

        function buildSettingsComponent(tabId: string): SectionedSettings {
          return new SectionedSettings(
            getSectionsForTab(tabId),
            15,
            settingsTheme,
            (id, newValue) => {
              if (isScopeTabId(tabId)) {
                handleScopeChange(tabId, id, newValue);
                return;
              }
              handleExtraTabChange(id);
            },
            () => done(undefined),
            { enableSearch: true, hideHint: true },
          );
        }

        // --- Change handlers (in-memory only) ---

        function handleScopeChange(
          scope: Scope,
          id: string,
          newValue: string,
        ): void {
          // Submenu items handle their own saving.
          if (isSubmenuItem(currentSections, id)) {
            refresh();
            return;
          }

          // For memory scope with no existing config, start from merged config
          let current = getScopeTabConfig(scope);
          if (scope === "memory" && current === null) {
            current = configStore.getConfig() as unknown as TConfig;
          }

          const handler = onSettingChange ?? defaultChangeHandler;
          const updated = handler(
            id,
            newValue,
            structuredClone(current ?? ({} as TConfig)),
          );
          if (!updated) return;

          // Store in draft, don't write to disk yet.
          drafts[scope] = updated;
          refresh();
        }

        function handleExtraTabChange(id: string): void {
          // Extra tabs are not scope-bound. Keep current save semantics:
          // only explicit setDraftForScope(...) mutations are tracked/saved.
          if (isSubmenuItem(currentSections, id)) {
            refresh();
            return;
          }
          refresh();
        }

        // --- Save handler (Ctrl+S) ---

        async function save(): Promise<void> {
          let saved = false;

          for (const scope of enabledScopes) {
            const draft = drafts[scope];
            if (!draft) continue;

            try {
              await configStore.save(scope, draft);
              drafts[scope] = null;
              saved = true;
            } catch (error) {
              ctx.ui.notify(
                `Failed to save ${SCOPE_LABELS[scope]}: ${error}`,
                "error",
              );
            }
          }

          if (saved) {
            ctx.ui.notify(`${extensionLabel}: saved`, "info");
            if (onSave) await onSave(ctx);
            // Rebuild with fresh data.
            settings = buildSettingsComponent(activeTabId);
          }

          tui.requestRender();
        }

        // --- Tab rendering ---

        function renderTabs(_contentWidth: number): string {
          if (allTabs.length <= 1) {
            return "";
          }

          const tabLabels = allTabs.map((tab) => {
            const dirtyMark =
              tab.kind === "scope" && drafts[tab.id] ? " *" : "";
            const fullLabel = ` ${tab.label}${dirtyMark} `;

            if (tab.id === activeTabId) {
              return theme.bg("selectedBg", theme.fg("accent", fullLabel));
            }
            return theme.fg("dim", fullLabel);
          });

          return tabLabels.join("  ");
        }

        function padLine(content: string, contentWidth: number): string {
          const len = visibleWidth(content);
          const padding = Math.max(0, contentWidth - len);
          return (
            theme.fg("border", "│") +
            truncateToWidth(content, contentWidth) +
            " ".repeat(padding) +
            theme.fg("border", "│")
          );
        }

        function handleTabSwitch(data: string): boolean {
          if (allTabs.length <= 1) return false;

          if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            const currentIndex = allTabs.findIndex(
              (tab) => tab.id === activeTabId,
            );
            const direction = matchesKey(data, Key.shift("tab")) ? -1 : 1;
            const nextIndex =
              (currentIndex + direction + allTabs.length) % allTabs.length;
            activeTabId = allTabs[nextIndex]?.id ?? activeTabId;
            settings = buildSettingsComponent(activeTabId);
            tui.requestRender();
            return true;
          }
          return false;
        }

        // --- Init ---

        settings = buildSettingsComponent(activeTabId);

        return {
          render(width: number) {
            const lines: string[] = [];
            const contentWidth = Math.max(1, width - 2);

            // Top border with title
            const titleText = ` ${title} `;
            const titleLen = visibleWidth(titleText);
            const topRuleLen = Math.max(1, width - titleLen - 3);
            lines.push(
              theme.fg("border", "╭─") +
                theme.fg("accent", theme.bold(titleText)) +
                theme.fg("border", "─".repeat(topRuleLen)) +
                theme.fg("border", "╮"),
            );

            // Tabs
            const tabs = renderTabs(contentWidth);
            if (tabs) {
              lines.push(padLine(tabs, contentWidth));
            }
            lines.push(padLine("", contentWidth));

            // Settings content
            const innerLines = settings?.render(contentWidth) ?? [];
            for (const line of innerLines) {
              lines.push(padLine(line, contentWidth));
            }

            // Separator
            lines.push(
              theme.fg("border", "├") +
                theme.fg("border", "─".repeat(contentWidth)) +
                theme.fg("border", "┤"),
            );

            // Controls
            const parts = ["Enter/Space change"];
            if (allTabs.length > 1) {
              parts.push("Tab/Shift+Tab tab");
            }
            parts.push("Ctrl+S save", "Esc close");
            const controlsText = theme.fg("dim", ` ${parts.join(" · ")}`);
            lines.push(padLine(controlsText, contentWidth));

            // Bottom border
            lines.push(
              theme.fg("border", "╰") +
                theme.fg("border", "─".repeat(contentWidth)) +
                theme.fg("border", "╯"),
            );

            return lines;
          },
          invalidate() {
            settings?.invalidate?.();
          },
          handleInput(data: string) {
            const hasActiveSubmenu = settings?.hasActiveSubmenu() ?? false;

            // Ctrl+S: save all dirty scope tabs, unless a submenu is open.
            if (matchesKey(data, Key.ctrl("s")) && !hasActiveSubmenu) {
              if (isDirty()) void save();
              return;
            }

            if (!hasActiveSubmenu && handleTabSwitch(data)) return;
            settings?.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
