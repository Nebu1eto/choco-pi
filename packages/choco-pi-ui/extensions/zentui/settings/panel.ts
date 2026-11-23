import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  getSelectPageIndex,
  matchesKey,
  type SettingItem,
  SettingsList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { inSubagentChildLoad } from "../child-load.ts";
import {
  renderEditorSettingsPreview,
  renderUserMessageSettingsPreview,
  SETTINGS_PREVIEW_MAX_WIDTH,
} from "../settings-previews.ts";
import { EDITOR_BORDER_STYLE, renderChromeBorder } from "../style.ts";
import {
  buildWorkingLinePreviewFrames,
  remapWorkingLineTextTick,
  type WorkingLineFrames,
} from "../working-line.ts";
import { handleZentuiSettingChange } from "./change-handler.ts";
import {
  createSettingsAppliers,
  resolveZentuiPreferencesArgs,
  runZentuiPreferencesOutcome,
  zentuiPreferencesCompletions,
} from "./direct-commands.ts";
import {
  formatSectionTabs,
  keepHostFocus,
  legacyLayout,
  LIST_ROWS,
  nextSection,
  type Placement,
  placeRows,
  previousSection,
  rowSources,
  sectionAtColumn,
  type SectionMerges,
  tabItems,
  visibleListRange,
  withSectionFooter,
} from "./layout.ts";
import {
  type ApplyResult,
  type PreferencesExtraSection,
  type SettingsCommandDeps,
  type ZentuiPreferencesPanelHandle,
  type ZentuiPreferencesPanelOptions,
} from "./types.ts";
export function createZentuiPreferencesComponent(
  deps: SettingsCommandDeps,
  options: ZentuiPreferencesPanelOptions,
): ZentuiPreferencesPanelHandle {
  const { ctx, tui, theme, onOutcome } = options;
  const { setEditor, setMessages, setFooter } = createSettingsAppliers(deps);
  const extraSections = options.extraSections ?? [];
  const sectionMerges: SectionMerges = options.mergeSections ?? {};
  const layoutMode = options.layout !== undefined;
  const layoutSpecs =
    options.layout ?? legacyLayout(extraSections, sectionMerges, options.sectionOrder);
  const hiddenRows = new Set(options.hiddenRows ?? []);
  const placeTabs = (only?: string): Placement =>
    placeRows(
      layoutMode || only === undefined
        ? layoutSpecs
        : layoutSpecs.filter((spec) => spec.id === only),
      rowSources(deps.getConfig(), deps.getActiveExtensionStatuses(), extraSections),
      hiddenRows,
      layoutMode,
    );
  const initialPlacement = layoutMode ? placeTabs() : undefined;
  const visibleSections = initialPlacement
    ? initialPlacement.tabs
        .filter((tab) => tab.groups.some((group) => group.rows.length > 0))
        .map((tab) => tab.id)
    : layoutSpecs.map((spec) => spec.id);
  const tabLabels = new Map(
    (initialPlacement?.tabs ?? layoutSpecs).map((tab) => [tab.id, tab.label]),
  );
  const labelOf = (section: string): string => tabLabels.get(section) ?? section;
  const tabHolding = (matches: (id: string) => boolean): string | undefined =>
    initialPlacement?.tabs.find(
      (tab) =>
        visibleSections.includes(tab.id) &&
        tab.groups.some((group) => group.rows.some((row) => matches(row.id))),
    )?.id;
  const resolveInitialSection = (): string => {
    const focusId = options.initialFocusId;
    const requested = options.initialSection;
    const focused = focusId === undefined ? undefined : tabHolding((id) => id === focusId);
    if (focused !== undefined) return focused;
    if (requested !== undefined && visibleSections.includes(requested)) return requested;
    const hosting =
      requested === undefined
        ? undefined
        : tabHolding((id) => initialPlacement?.rowSource.get(id) === requested);
    return hosting ?? visibleSections[0] ?? "appearance";
  };
  const initialSection = resolveInitialSection();
  const listTheme = deps.settingsListTheme ?? getSettingsListTheme();
  let activeSection = initialSection;
  let submenuOpen = false;
  let searchQuery: string | undefined;
  let settingsList: SettingsList;
  let navItems: SettingItem[] = [];
  let navHeaders = new Set<string>();
  let navSelectedId: string | undefined;
  let activeSources = new Set<string>();
  let preview: WorkingLineFrames | undefined;
  let previewFrameIndex = 0;
  let cancelPreview = () => {};
  const stopPreview = (reset = true) => {
    cancelPreview();
    cancelPreview = () => {};
    if (reset) {
      preview = undefined;
      previewFrameIndex = 0;
    }
  };
  const startPreview = () => {
    const previous = preview;
    const previousState = previous?.frameStates[previewFrameIndex];
    stopPreview(false);
    if (previewSource() !== "workingLine") return;
    try {
      const config = deps.getConfig();
      const spinnerTick = previousState?.spinnerTick ?? 0;
      let textTick = previousState?.textTick ?? 0;
      let generated = buildWorkingLinePreviewFrames(
        config.components.workingLine,
        config.colors,
        theme,
        spinnerTick,
        textTick,
      );
      if (previous && previousState) {
        textTick = remapWorkingLineTextTick(
          previous.textAnimation,
          previous.textWidth,
          previousState.textTick,
          generated.textAnimation,
          generated.textWidth,
          previous.textOrigin,
          generated.textOrigin,
        );
        generated = buildWorkingLinePreviewFrames(
          config.components.workingLine,
          config.colors,
          theme,
          spinnerTick,
          textTick,
        );
      }
      preview = generated;
      previewFrameIndex = 0;
      const advance = () => {
        if (previewSource() !== "workingLine" || !preview || preview.frames.length === 0) return;
        previewFrameIndex = (previewFrameIndex + 1) % preview.frames.length;
        tui.requestRender();
        cancelPreview = deps.sessionLifecycle.defer(advance, preview.intervalMs);
      };
      cancelPreview = deps.sessionLifecycle.defer(advance, generated.intervalMs);
    } catch {
      stopPreview();
    }
  };
  const finishSettings = (result: string) => {
    stopPreview();
    onOutcome(result);
  };
  const notifyChange = (label: string, value: string, result?: ApplyResult) => {
    deps.requestRender();
    ctx.ui.notify(
      `${label}: ${value}${result && !result.applied ? ` (${result.reason ?? "reload Pi to apply this change"})` : ""}`,
      "info",
    );
    startPreview();
    tui.requestRender();
  };
  const notifyWorkingLineChange = (
    label: string,
    value: string,
    result: ApplyResult,
    previewChanged = true,
  ) => {
    ctx.ui.notify(
      `${label}: ${value}${result.applied ? "" : ` (${result.reason ?? "reload Pi to apply this change"})`}`,
      "info",
    );
    if (previewChanged) startPreview();
    tui.requestRender();
  };
  const makeListForItems = (
    items: SettingItem[],
    owners: Map<string, PreferencesExtraSection>,
    onCancel: () => void,
    enableSearch: boolean,
  ): SettingsList => {
    const list = new SettingsList(
      items.map((item) =>
        item.submenu === undefined
          ? item
          : {
              ...item,
              submenu: (currentValue: string, close: (selectedValue?: string) => void) => {
                submenuOpen = true;
                // SAFETY: the branch above establishes that this row has a submenu.
                return (item.submenu as NonNullable<SettingItem["submenu"]>)(
                  currentValue,
                  (selectedValue) => {
                    submenuOpen = false;
                    close(selectedValue);
                  },
                );
              },
            },
      ),
      LIST_ROWS,
      listTheme,
      (id, newValue) => {
        handleZentuiSettingChange(
          {
            ctx,
            deps,
            tui,
            owners,
            setEditor,
            setMessages,
            setFooter,
            finishSettings,
            notifyChange,
            notifyWorkingLineChange,
            stopPreview,
            updateValue: (itemId, value) => settingsList.updateValue(itemId, value),
            rebuildList: (focusId) => {
              settingsList = rebuildCurrentList(focusId);
            },
          },
          id,
          newValue,
        );
      },
      onCancel,
      enableSearch ? { enableSearch: true } : undefined,
    );
    return list;
  };
  const selectable = (item: SettingItem | undefined): item is SettingItem =>
    item !== undefined && !navHeaders.has(item.id);
  const moveSelection = (step: 1 | -1): void => {
    const count = navItems.length;
    if (count === 0) return;
    const current = navItems.findIndex((item) => item.id === navSelectedId);
    for (let offset = 1; offset <= count; offset += 1) {
      const candidate = navItems[(((current + step * offset) % count) + count) % count];
      if (!selectable(candidate)) continue;
      navSelectedId = candidate.id;
      settingsList.selectItem(candidate.id);
      return;
    }
  };
  const pageSelection = (data: string): boolean => {
    const current = Math.max(
      0,
      navItems.findIndex((item) => item.id === navSelectedId),
    );
    const target = getSelectPageIndex(getKeybindings(), data, current, navItems.length, LIST_ROWS);
    if (target === undefined) return false;
    const step = target < current ? -1 : 1;
    for (const direction of [step, -step]) {
      for (let index = target; index >= 0 && index < navItems.length; index += direction) {
        const item = navItems[index];
        if (!selectable(item)) continue;
        navSelectedId = item.id;
        settingsList.selectItem(item.id);
        return true;
      }
    }
    return true;
  };
  const previewSource = (): "editor" | "userMessages" | "workingLine" | undefined => {
    if (searchQuery !== undefined) return undefined;
    if (activeSources.has("editor")) return "editor";
    if (activeSources.has("userMessages")) return "userMessages";
    if (activeSources.has("workingLine")) return "workingLine";
    return undefined;
  };
  const makeSettingsList = (focusId?: string): SettingsList => {
    const placement = placeTabs(activeSection);
    const tab = placement.tabs.find((candidate) => candidate.id === activeSection);
    const { items, headers } = tabItems(tab, theme);
    navItems = items;
    navHeaders = headers;
    activeSources = new Set(
      items.flatMap((item) => {
        const source = placement.rowSource.get(item.id);
        return source === undefined ? [] : [source];
      }),
    );
    const list = makeListForItems(items, placement.owners, () => finishSettings("close"), false);
    const focused = items.find((item) => item.id === focusId);
    const initial = selectable(focused) ? focused : items.find(selectable);
    navSelectedId = initial?.id;
    if (initial !== undefined) list.selectItem(initial.id);
    return list;
  };

  interface SettingsListSearchInternals {
    searchInput?: {
      focused: boolean;
      getValue(): string;
      setValue(value: string): void;
    };
    applyFilter(query: string): void;
  }

  const searchInternals = (list: SettingsList): SettingsListSearchInternals => {
    // SAFETY: the panel constructs this list with enableSearch, so these members are present.
    return list as SettingsList & SettingsListSearchInternals;
  };

  interface SearchItems {
    items: SettingItem[];
    owners: Map<string, PreferencesExtraSection>;
  }

  const collectSearchItems = (): SearchItems => {
    const items: SettingItem[] = [];
    const placement = placeTabs();
    for (const section of visibleSections) {
      const tab = placement.tabs.find((candidate) => candidate.id === section);
      for (const group of tab?.groups ?? []) {
        for (const item of group.rows) {
          if (item.values === undefined && item.submenu === undefined) continue;
          items.push({ ...item, label: `${labelOf(section)}: ${item.label}` });
        }
      }
    }
    return { items, owners: placement.owners };
  };

  const exitSearch = (): void => {
    searchQuery = undefined;
    settingsList = makeSettingsList();
    startPreview();
    tui.requestRender();
  };

  const makeSearchList = (focusId?: string): SettingsList => {
    const { items, owners } = collectSearchItems();
    // SAFETY: searchQuery is defined whenever a search list is built.
    const query = searchQuery ?? "";
    const list = makeListForItems(items, owners, exitSearch, true);
    const internals = searchInternals(list);
    if (internals.searchInput !== undefined) {
      internals.searchInput.focused = true;
      internals.searchInput.setValue(query);
      internals.applyFilter(query);
    }
    if (focusId !== undefined) list.selectItem(focusId);
    return list;
  };

  const enterSearch = (): void => {
    stopPreview();
    searchQuery = "";
    settingsList = makeSearchList();
    tui.requestRender();
  };

  const showSection = (section: string): void => {
    stopPreview();
    searchQuery = undefined;
    activeSection = section;
    settingsList = makeSettingsList();
    startPreview();
    tui.requestRender();
  };

  const rebuildCurrentList = (focusId?: string): SettingsList => {
    settingsList = searchQuery === undefined ? makeSettingsList(focusId) : makeSearchList(focusId);
    return settingsList;
  };

  settingsList = makeSettingsList(options.initialFocusId);
  if (
    options.initialFocusId !== undefined &&
    navSelectedId === options.initialFocusId &&
    options.openInitialSubmenu
  ) {
    settingsList.handleInput("\r");
  }
  startPreview();
  const renderPreviewRows = (previewWidth: number): string[] => {
    if (previewWidth <= 0) return [];
    const source = previewSource();
    if (source === "editor")
      return renderEditorSettingsPreview(deps.getConfig(), theme, previewWidth);
    if (source === "userMessages")
      return renderUserMessageSettingsPreview(deps.getConfig(), theme, previewWidth);
    if (source === "workingLine" && preview && preview.frames.length > 0)
      return [
        truncateToWidth(
          preview.frames[previewFrameIndex] ?? preview.frames[0],
          Math.min(SETTINGS_PREVIEW_MAX_WIDTH, previewWidth),
          "",
        ),
      ];
    return [];
  };
  let shownFrame: { width: number; listTop: number; listRows: number } | undefined;
  const tabsRow = 1;
  const forwardToList = (event: TuiMouseEvent, row: number): TuiMouseEventResult | undefined =>
    keepHostFocus(
      settingsList.handleMouse({
        ...event,
        y: row,
        height: shownFrame?.listRows ?? 0,
      }),
    );
  const itemAtRow = (row: number): SettingItem | undefined => {
    if (navSelectedId === undefined) return undefined;
    settingsList.selectItem(navSelectedId);
    const selected = navItems.findIndex((item) => item.id === navSelectedId);
    const { start, end } = visibleListRange(selected, navItems.length);
    const index = start + row;
    return index < end ? navItems[index] : undefined;
  };
  return {
    render(width: number) {
      const border = renderChromeBorder(
        theme,
        deps.getConfig().components.selectorBorders.colorSource,
        EDITOR_BORDER_STYLE,
        "─".repeat(Math.max(0, width)),
      );
      if (searchQuery !== undefined) {
        const searchRows = withSectionFooter(settingsList.render(width), theme, "search").map(
          (line) => truncateToWidth(line, width, ""),
        );
        shownFrame = { width, listTop: 3, listRows: searchRows.length };
        return [
          truncateToWidth(border, width, ""),
          truncateToWidth(
            formatSectionTabs(activeSection, labelOf, theme, width, visibleSections),
            width,
            "",
          ),
          truncateToWidth(border, width, ""),
          ...searchRows,
          truncateToWidth(border, width, ""),
        ];
      }
      const settingsRows = withSectionFooter(settingsList.render(width), theme).map((line) =>
        truncateToWidth(line, width, ""),
      );
      const previewRows = renderPreviewRows(Math.max(0, width - 4));
      while (previewRows.length > 0 && visibleWidth(previewRows.at(-1) ?? "") === 0)
        previewRows.pop();
      const indentedPreviewRows = previewRows.map((line) =>
        truncateToWidth(`  ${line}`, width, ""),
      );
      const bodyRows = indentedPreviewRows.some((line) => visibleWidth(line) > 0)
        ? ["", ...indentedPreviewRows, "", ...settingsRows]
        : settingsRows;
      shownFrame = {
        width,
        listTop: 3 + bodyRows.length - settingsRows.length,
        listRows: settingsRows.length,
      };
      return [
        truncateToWidth(border, width, ""),
        truncateToWidth(
          formatSectionTabs(activeSection, labelOf, theme, width, visibleSections),
          width,
          "",
        ),
        truncateToWidth(border, width, ""),
        ...bodyRows,
        truncateToWidth(border, width, ""),
      ];
    },
    invalidate() {
      settingsList.invalidate();
    },
    handleInput(data: string) {
      if (searchQuery !== undefined && !submenuOpen) {
        if (matchesKey(data, "escape")) {
          exitSearch();
          return;
        }
        settingsList.handleInput(data);
        searchQuery = searchInternals(settingsList).searchInput?.getValue() ?? searchQuery;
        tui.requestRender();
        return;
      }
      if (!submenuOpen && data === "/") {
        enterSearch();
        return;
      }
      if (!submenuOpen) {
        const keybindings = getKeybindings();
        let step: 1 | -1 | undefined;
        if (keybindings.matches(data, "tui.select.up")) step = -1;
        else if (keybindings.matches(data, "tui.select.down")) step = 1;
        if (step !== undefined) {
          moveSelection(step);
          tui.requestRender();
          return;
        }
        if (searchQuery === undefined && pageSelection(data)) {
          tui.requestRender();
          return;
        }
      }
      if (!submenuOpen && matchesKey(data, "right")) {
        showSection(nextSection(activeSection, visibleSections));
        return;
      }
      if (!submenuOpen && matchesKey(data, "left")) {
        showSection(previousSection(activeSection, visibleSections));
        return;
      }
      settingsList.handleInput(data);
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      const frame = shownFrame;
      if (frame === undefined) return undefined;
      const leftPress = event.button === "left" && event.type === "press";
      const leftClick = event.button === "left" && event.type === "click";
      if (event.y === tabsRow) {
        if (submenuOpen || (!leftPress && !leftClick)) return undefined;
        const section = sectionAtColumn(
          event.x,
          activeSection,
          labelOf,
          frame.width,
          visibleSections,
        );
        if (section === undefined) return undefined;
        if (leftClick && (section !== activeSection || searchQuery !== undefined))
          showSection(section);
        return { handled: true, render: leftClick };
      }
      const row = event.y - frame.listTop;
      if (row < 0 || row >= frame.listRows) return undefined;
      if (submenuOpen || searchQuery !== undefined) {
        const result = forwardToList(event, row);
        if (searchQuery !== undefined && !submenuOpen)
          searchQuery = searchInternals(settingsList).searchInput?.getValue() ?? searchQuery;
        return result;
      }
      if (event.type === "wheel") {
        const delta = event.wheelDelta ?? 0;
        if (delta === 0) return undefined;
        moveSelection(delta < 0 ? -1 : 1);
        return { handled: true };
      }
      if (leftPress) {
        const item = itemAtRow(row);
        if (!selectable(item)) return undefined;
        const result = forwardToList(event, row);
        if (result === undefined) return undefined;
        navSelectedId = item.id;
        return result;
      }
      if (leftClick) return forwardToList(event, row);
      return undefined;
    },
    dispose() {
      stopPreview();
    },
    getActiveSection() {
      return activeSection;
    },
    hasOpenSubmenu() {
      return submenuOpen;
    },
    hasActiveSearch() {
      return searchQuery !== undefined;
    },
  };
}

export const ZENTUI_PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.preferences-provider");

export function registerZentuiPreferencesProvider(deps: SettingsCommandDeps): void {
  if (inSubagentChildLoad()) return;
  Object.defineProperty(globalThis, ZENTUI_PREFERENCES_PROVIDER_SYMBOL, {
    configurable: true,
    writable: true,
    value: {
      createPanel: (options: ZentuiPreferencesPanelOptions) =>
        createZentuiPreferencesComponent(deps, options),
      runOutcome: (outcome: string, ctx: ExtensionCommandContext) =>
        runZentuiPreferencesOutcome(outcome, deps, ctx),
      resolveArgs: (args: string, ctx: ExtensionCommandContext) =>
        Promise.resolve(resolveZentuiPreferencesArgs(args, deps, ctx)),
      completions: (prefix: string) => zentuiPreferencesCompletions(prefix),
    },
  });
}
