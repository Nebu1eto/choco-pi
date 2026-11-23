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
  // A host layout places every row by id, which needs every source built;
  // the legacy layout builds only the sections the shown tab names.
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
  // Tabs are fixed for the panel's lifetime; an empty host tab is left out.
  const visibleSections = initialPlacement
    ? initialPlacement.tabs
        .filter((tab) => tab.groups.some((group) => group.rows.length > 0))
        .map((tab) => tab.id)
    : layoutSpecs.map((spec) => spec.id);
  const tabLabels = new Map(
    (initialPlacement?.tabs ?? layoutSpecs).map((tab) => [tab.id, tab.label]),
  );
  const labelOf = (section: string): string => tabLabels.get(section) ?? section;
  /** The tab holding the first placed row that matches, among the visible tabs. */
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
  // A submenu owns every key while it is open, so the panel's own section
  // shortcuts and the host's tab shortcuts have to stand down.
  let submenuOpen = false;
  // While the query is defined the panel lists matching rows from every
  // section and the typed keys go to its filter field instead of the section
  // shortcuts.
  let searchQuery: string | undefined;
  let settingsList: SettingsList;
  // Section-view navigation: the shown rows, which of them are headings, and
  // the selected row. The panel moves the selection itself so headings are
  // never focused.
  let navItems: SettingItem[] = [];
  let navHeaders = new Set<string>();
  let navSelectedId: string | undefined;
  // Sources with rows on the shown tab; they decide which preview renders.
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
  /**
   * Builds the row list the panel currently shows: one section's rows with an
   * Esc that closes the panel, or every section's matching rows with a search
   * field and an Esc that only leaves the search.
   */
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
  /** Whether a section-view row can hold the selection; headings cannot. */
  const selectable = (item: SettingItem | undefined): item is SettingItem =>
    item !== undefined && !navHeaders.has(item.id);
  /** Moves the section-view selection one selectable row, wrapping like the list does. */
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
  /**
   * Page Up/Down in the section view, as the list moves them but landing on
   * the nearest row that can hold the selection, so a heading is never
   * focused and the panel's record of the selection stays the list's.
   */
  const pageSelection = (data: string): boolean => {
    const current = Math.max(
      0,
      navItems.findIndex((item) => item.id === navSelectedId),
    );
    const target = getSelectPageIndex(getKeybindings(), data, current, navItems.length, LIST_ROWS);
    if (target === undefined) return false;
    const step = target < current ? -1 : 1;
    // On a heading, keep going the way the key moves, then try the other way.
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
  /** Which section's live preview the shown tab carries, if any. */
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

  /** The search field SettingsList keeps private, read to preserve an active query. */
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

  /** Rows of every section, plus the host section each contributed row belongs to. */
  interface SearchItems {
    items: SettingItem[];
    owners: Map<string, PreferencesExtraSection>;
  }

  /**
   * Every changeable row from every visible section, labeled with the section
   * it lives on, so a search result named like another tab's row still says
   * where it lives. Display-only rows such as source headers cannot be
   * changed, so they cannot be found either.
   */
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
    // Restores the query after a change rebuilt the list and lights the
    // cursor, which the field only draws while it believes it holds focus.
    if (internals.searchInput !== undefined) {
      internals.searchInput.focused = true;
      internals.searchInput.setValue(query);
      internals.applyFilter(query);
    }
    // The filter resets the selection; a change keeps the row it changed.
    if (focusId !== undefined) list.selectItem(focusId);
    return list;
  };

  const enterSearch = (): void => {
    stopPreview();
    searchQuery = "";
    settingsList = makeSearchList();
    tui.requestRender();
  };

  /** Shows one section's rows, leaving any search; ←/→ and a click on the strip land here. */
  const showSection = (section: string): void => {
    stopPreview();
    searchQuery = undefined;
    activeSection = section;
    settingsList = makeSettingsList();
    startPreview();
    tui.requestRender();
  };

  /** Rebuilds the shown list after a change, keeping the active search's filter and section. */
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
    // Activating the focused row is what opens its submenu; the list owns that
    // step, so replay the key rather than reaching into it.
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
  /**
   * Where the last frame drew the section strip and the settings list, for
   * the mouse: rows from the panel's top, and the width it was laid out at.
   */
  let shownFrame: { width: number; listTop: number; listRows: number } | undefined;
  const tabsRow = 1;
  /** The settings list's answer to a mouse event over it, without its focus request. */
  const forwardToList = (event: TuiMouseEvent, row: number): TuiMouseEventResult | undefined =>
    keepHostFocus(
      settingsList.handleMouse({
        ...event,
        y: row,
        height: shownFrame?.listRows ?? 0,
      }),
    );
  /**
   * The section-view item drawn on list row `row`. The list is told the
   * panel's selection first, so it lays the window out exactly as computed.
   */
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
        // The search shows no section preview; its live rows are the result list.
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
      // While the search is up, every key types into the filter field or acts
      // on the result list; Esc only leaves the search, it never closes.
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
      // The panel owns section-view selection so a heading is never focused.
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
      // A press must be taken for its click to follow; Pi starts a text
      // selection on any press nothing takes.
      if (event.y === tabsRow) {
        // An open submenu owns the panel, as it does every key.
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
      // A submenu and the search list keep their own state; they take the event.
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
        // A heading never holds the selection, so a press on one is left to Pi.
        const item = itemAtRow(row);
        if (!selectable(item)) return undefined;
        const result = forwardToList(event, row);
        if (result === undefined) return undefined;
        navSelectedId = item.id;
        return result;
      }
      // The list changes the row its press selected, as Enter would.
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

/**
 * Publishes the preferences panel on the global registry so the choco-pi
 * profile can host it as the Preferences tab of its Status/Usage dialog and
 * register the `/preferences` command. The package registers no command
 * itself; without the profile host the panel is simply unused.
 *
 * A subagent child never publishes it: the slot is process-global and the
 * callbacks drive this activation's lifecycle and editor, so a child would
 * leave the main session's panel operating on a disposed child UI.
 */
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
