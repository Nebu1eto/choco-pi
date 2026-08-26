import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { PreferencesExtraSection, PreferencesSectionChange } from "./agent-preferences.ts";
import { isFunction, isString, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

export const NATIVE_SETTINGS_SECTION_ID = "pi";

const MODEL_ROW_ID = "piModel";
const SCOPED_MODELS_ROW_ID = "piScopedModels";

/** The Pi row that carries the reasoning effort picker. */
export const THINKING_ROW_ID = "thinking";

/** Where a command asks the settings dialog to open. */
export interface NativeSettingsFocus {
  section: string;
  focusId: string;
  openSubmenu: boolean;
}

/** The Model tab row holding Pi's model picker. */
export const MODEL_PICKER_FOCUS: NativeSettingsFocus = {
  section: "model",
  focusId: MODEL_ROW_ID,
  openSubmenu: true,
};

/** The Model tab row holding Pi's reasoning effort picker. */
export const EFFORT_PICKER_FOCUS: NativeSettingsFocus = {
  section: "model",
  focusId: THINKING_ROW_ID,
  openSubmenu: true,
};

/**
 * Labels that read better in this panel than in Pi's own settings menu, where
 * the surrounding rows give more context.
 */
const PI_ROW_LABELS = new Map<string, string>([["thinking", "Reasoning effort"]]);

/** Sections the profile adds for settings that no built-in choco-ui section covers. */
export const TERMINAL_SECTION_ID = "terminal";
export const SESSION_SECTION_ID = "session";
export const MODEL_SECTION_ID = "model";
export const TOOLS_SECTION_ID = "tools";

/**
 * Where each of Pi's settings rows belongs, by topic rather than by the order
 * Pi happens to build them in. A row Pi adds in a later version is unlisted and
 * falls back to its own section, so an upgrade never drops a setting.
 */
const PI_ROW_LAYOUT: ReadonlyArray<{ section: string; rows: readonly string[] }> = [
  {
    section: "appearance",
    rows: [
      "theme",
      "mermaid-rendering",
      "hide-thinking",
      "cache-miss-notices",
      "show-images",
      "image-width-cells",
      "auto-resize-images",
    ],
  },
  {
    section: "editor",
    rows: ["editor-padding", "autocomplete-max-visible", "double-escape-action"],
  },
  { section: "userMessages", rows: ["output-padding"] },
  {
    section: TERMINAL_SECTION_ID,
    rows: [
      "tui-mode",
      "fullscreen-exit-output",
      "fullscreen-scrollbar",
      "terminal-progress",
      "clear-on-shrink",
      "show-hardware-cursor",
    ],
  },
  {
    section: SESSION_SECTION_ID,
    rows: [
      "autocompact",
      "steering-mode",
      "follow-up-mode",
      "tree-filter-mode",
      "block-images",
      "default-project-trust",
      "quiet-startup",
      "collapse-changelog",
      "install-telemetry",
      "warnings",
    ],
  },
  {
    section: MODEL_SECTION_ID,
    rows: [
      MODEL_ROW_ID,
      SCOPED_MODELS_ROW_ID,
      "thinking",
      "model-thinking",
      "transport",
      "http-idle-timeout",
    ],
  },
  { section: TOOLS_SECTION_ID, rows: ["skill-commands"] },
];

/** Sections this module owns a tab for, in tab order. */
const PI_OWNED_SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: TERMINAL_SECTION_ID, label: "Terminal" },
  { id: SESSION_SECTION_ID, label: "Session" },
  { id: MODEL_SECTION_ID, label: "Model" },
  { id: TOOLS_SECTION_ID, label: "Tools" },
];

/**
 * Bridge state lives on `globalThis` rather than in module scope because
 * `/reload` re-imports this module while the already-patched prototype keeps
 * running; a module-scoped closure would then serve a stale extension runner.
 */
const NATIVE_SETTINGS_BRIDGE = Symbol.for("choco-pi.native-settings-bridge");

/** Structural view of the interactive mode; the fields this bridge reaches for are stable host internals. */
export interface NativeSettingsHost {
  showSettingsSelector: () => void;
  showSelector: (create: (done: () => void) => RuntimeValue) => void;
}

type SelectorFactory = (done: () => void) => RuntimeValue;

interface NativeSettingsBridge {
  /** Pi's own `showSettingsSelector`, kept so the native menu stays reachable as a fallback. */
  original: (this: NativeSettingsHost) => void;
  /** Pi's own `/model` handler, kept for the argument form this bridge leaves alone. */
  originalModelCommand?: (this: NativeSettingsHost, searchTerm?: string) => Promise<void>;
  /** Opens the unified dialog. Replaced on every extension load. */
  open?: (host: NativeSettingsHost, focus?: NativeSettingsFocus) => void;
  /** Most recent interactive mode instance seen by the patched methods. */
  host?: NativeSettingsHost;
}

function bridgeStore(): Record<PropertyKey, RuntimeValue> {
  return reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
}

/** Reads one property from a host value, treating anything nullish as absent. */
function propertyOf(value: RuntimeValue, key: string): RuntimeValue {
  if (value === undefined || value === null) return undefined;
  return reinterpretHostValue<Record<string, RuntimeValue>>(value)[key];
}

function readBridge(): NativeSettingsBridge | undefined {
  const candidate = bridgeStore()[NATIVE_SETTINGS_BRIDGE];
  if (candidate === undefined || candidate === null) return undefined;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return isFunction(record["original"])
    ? reinterpretHostValue<NativeSettingsBridge>(candidate)
    : undefined;
}

/**
 * Routes Pi's built-in `/settings` to the unified dialog and remembers the live
 * interactive mode so the Pi section can read the real settings rows.
 *
 * Pi dispatches `/settings` before extension commands and hides extension
 * commands that collide with a built-in name, so an extension command called
 * `settings` can never run. Taking over `showSettingsSelector` is the only way
 * to make `/settings` open something else.
 */
export function installNativeSettingsBridge(
  open: (host: NativeSettingsHost, focus?: NativeSettingsFocus) => void,
): void {
  const prototype = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(
    InteractiveMode.prototype,
  );
  const existing = readBridge();
  if (existing) {
    existing.open = open;
    return;
  }
  const original = prototype["showSettingsSelector"];
  if (!isFunction(original)) return;

  const bridge: NativeSettingsBridge = {
    original: reinterpretHostValue<NativeSettingsBridge["original"]>(original),
    open,
  };
  Object.defineProperty(globalThis, NATIVE_SETTINGS_BRIDGE, {
    configurable: true,
    writable: true,
    value: bridge,
  });

  prototype["showSettingsSelector"] = function patchedShowSettingsSelector(
    this: NativeSettingsHost,
  ): void {
    bridge.host = this;
    if (bridge.open) bridge.open(this);
    else bridge.original.call(this);
  };

  // `/model` without a pattern used to replace the editor with the picker. It
  // opens the dialog on the row that holds the same picker instead, while
  // `/model <pattern>` keeps Pi's matching and its pre-filtered selector.
  const modelCommand = prototype["handleModelCommand"];
  if (isFunction(modelCommand)) {
    bridge.originalModelCommand =
      reinterpretHostValue<NonNullable<NativeSettingsBridge["originalModelCommand"]>>(modelCommand);
    prototype["handleModelCommand"] = async function patchedHandleModelCommand(
      this: NativeSettingsHost,
      searchTerm?: string,
    ): Promise<void> {
      bridge.host = this;
      if (searchTerm === undefined && bridge.open) {
        bridge.open(this, MODEL_PICKER_FOCUS);
        return;
      }
      await bridge.originalModelCommand?.call(this, searchTerm);
    };
  }

  // Runs once at startup and again after every /reload, so the host is known
  // before the user ever opens the dialog through /preferences.
  const setupAutocompleteProvider = prototype["setupAutocompleteProvider"];
  if (isFunction(setupAutocompleteProvider)) {
    const inner =
      reinterpretHostValue<(this: NativeSettingsHost, ...args: RuntimeValue[]) => RuntimeValue>(
        setupAutocompleteProvider,
      );
    prototype["setupAutocompleteProvider"] = function patchedSetupAutocompleteProvider(
      this: NativeSettingsHost,
      ...args: RuntimeValue[]
    ): RuntimeValue {
      bridge.host = this;
      return inner.apply(this, args);
    };
  }
}

/** Opens Pi's own settings menu; used when the unified dialog is unavailable. */
export function openNativeSettingsMenu(host: NativeSettingsHost): void {
  readBridge()?.original.call(host);
}

/**
 * Builds a command context bound to the host's live session, so the bridge can
 * open a dialog that normally receives one from an extension command dispatch.
 */
export function createHostCommandContext(host: NativeSettingsHost): RuntimeValue | undefined {
  const runner = propertyOf(propertyOf(host, "session"), "extensionRunner");
  const create = propertyOf(runner, "createCommandContext");
  if (!isFunction(create)) return undefined;
  try {
    return reinterpretHostValue<() => RuntimeValue>(create).call(runner);
  } catch {
    return undefined;
  }
}

interface NativeSettingsRows {
  items: SettingItem[];
  onChange: (id: string, newValue: string) => void;
}

/**
 * Runs a host method that would replace the editor with a selector, and returns
 * what it built instead of showing it. Pi assembles its selectors inside those
 * methods, wired to its own callbacks, so collecting from `showSelector` is the
 * only way to reuse one without rebuilding it — and a rebuilt copy would drift
 * from Pi with every release.
 */
function captureHostSelector(
  host: NativeSettingsHost,
  invoke: () => void,
  done: () => void,
): RuntimeValue {
  let captured: RuntimeValue;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(host);
  const hadOwnShowSelector = Object.prototype.hasOwnProperty.call(host, "showSelector");
  const previousShowSelector = record["showSelector"];
  record["showSelector"] = (create: SelectorFactory): void => {
    captured = create(done);
  };
  try {
    invoke();
  } catch {
    return undefined;
  } finally {
    if (hadOwnShowSelector) record["showSelector"] = previousShowSelector;
    else delete record["showSelector"];
  }
  return captured;
}

/**
 * Builds Pi's real settings rows and hands back the list plus its change
 * handler, so every runtime effect (theme switching, chat rebuilds, transport
 * changes) stays in Pi's own callbacks.
 */
function captureNativeSettingsRows(host: NativeSettingsHost): NativeSettingsRows | undefined {
  const bridge = readBridge();
  if (!bridge) return undefined;
  const captured = captureHostSelector(
    host,
    () => bridge.original.call(host),
    () => {},
  );
  const component = propertyOf(captured, "component");
  const getSettingsList = propertyOf(component, "getSettingsList");
  if (!isFunction(getSettingsList)) return undefined;
  let list: RuntimeValue;
  try {
    list = reinterpretHostValue<() => RuntimeValue>(getSettingsList).call(component);
  } catch {
    return undefined;
  }
  const items = propertyOf(list, "items");
  const onChange = propertyOf(list, "onChange");
  if (!Array.isArray(items) || !isFunction(onChange)) return undefined;
  return {
    items: reinterpretHostValue<SettingItem[]>(items),
    onChange: reinterpretHostValue<NativeSettingsRows["onChange"]>(onChange),
  };
}

function unavailableRow(): SettingItem {
  return {
    id: "piSettingsUnavailable",
    label: "Pi settings",
    description: "Pi's own settings rows could not be read in this session.",
    currentValue: "unavailable",
  };
}

function currentModelId(host: NativeSettingsHost): string | undefined {
  const id = propertyOf(propertyOf(propertyOf(host, "session"), "model"), "id");
  return isString(id) ? id : undefined;
}

function currentThinkingLevel(host: NativeSettingsHost): string | undefined {
  const session = propertyOf(host, "session");
  const level = propertyOf(session, "thinkingLevel");
  return isString(level) ? level : undefined;
}

/** Shown in place of the picker when Pi's model selector cannot be collected. */
function unavailablePicker(done: (value?: string) => void): Component {
  return {
    render: () => ["", "  The model selector is unavailable in this session.", ""],
    invalidate: () => {},
    handleInput: () => done(),
  };
}

const BOX_DRAWING_ONLY = /^[\u2500-\u257F\s]+$/;

/** A rule Pi drew around a selector, as opposed to a blank or a content line. */
function isRuleLine(line: string): boolean {
  const text = stripTerminalSequences(line);
  return text.trim().length > 0 && BOX_DRAWING_ONLY.test(text);
}

/**
 * Drops the rules Pi draws around a selector meant to replace the editor. The
 * panel already frames its own body, so an embedded selector would otherwise
 * double the line above and below it.
 */
function withoutOuterRules(component: Component): Component {
  return {
    render: (width: number) => {
      const lines = component.render(width);
      const first = isRuleLine(lines[0] ?? "") ? 1 : 0;
      const last = lines.length > first && isRuleLine(lines.at(-1) ?? "") ? 1 : 0;
      return lines.slice(first, lines.length - last);
    },
    invalidate: () => component.invalidate?.(),
    handleInput: (data: string) => component.handleInput?.(data),
  };
}

/**
 * One of Pi's editor-replacing selectors, rendered inside the settings list
 * instead. Every such selector applies its own change and then calls the
 * collected `done`, so this only disposes it and reports the row's new value.
 */
function embeddedHostPicker(
  host: NativeSettingsHost,
  method: string,
  done: (value?: string) => void,
  readValue: () => string | undefined,
): Component {
  let created: RuntimeValue;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    const dispose = propertyOf(created, "dispose");
    if (isFunction(dispose)) reinterpretHostValue<() => void>(dispose).call(created);
    done(readValue());
  };
  const show = propertyOf(host, method);
  if (!isFunction(show)) return unavailablePicker(done);
  created = captureHostSelector(
    host,
    () => reinterpretHostValue<(this: NativeSettingsHost) => void>(show).call(host),
    finish,
  );
  const component = propertyOf(created, "component");
  if (component === undefined || component === null) return unavailablePicker(done);
  // The list forwards input by hand, but the search field only draws its cursor
  // while it believes it holds focus.
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(component);
  if ("focused" in record) record["focused"] = true;
  return withoutOuterRules(reinterpretHostValue<Component>(component));
}

/** How many models Ctrl+P cycles through, as the scoped-models row shows it. */
function scopedModelsSummary(host: NativeSettingsHost): string {
  const scoped = propertyOf(propertyOf(host, "session"), "scopedModels");
  const count = Array.isArray(scoped) ? scoped.length : 0;
  return count === 0 ? "all models" : `${count} selected`;
}

/**
 * The row that picks the session model. Pi builds no such row for its settings
 * menu, because `/model` covers it there.
 */
function modelRow(host: NativeSettingsHost): SettingItem {
  return {
    id: MODEL_ROW_ID,
    label: "Model",
    description: "Model for this session; the picker opens in place.",
    currentValue: currentModelId(host) ?? "select…",
    submenu: (_currentValue, done) =>
      embeddedHostPicker(host, "showModelSelector", done, () => currentModelId(host)),
  };
}

/** Restores the session reasoning picker that Pi no longer includes in its settings rows. */
function thinkingRow(host: NativeSettingsHost): SettingItem {
  return {
    id: THINKING_ROW_ID,
    label: "Reasoning effort",
    description: "Reasoning effort for this session; the picker can also save the global default.",
    currentValue: currentThinkingLevel(host) ?? "select…",
    submenu: (_currentValue, done) =>
      embeddedHostPicker(host, "showThinkingSelector", done, () => currentThinkingLevel(host)),
  };
}

/**
 * The row that scopes the Ctrl+P cycle, carrying what `/scoped-models` opened.
 */
function scopedModelsRow(host: NativeSettingsHost): SettingItem {
  return {
    id: SCOPED_MODELS_ROW_ID,
    label: "Scoped models",
    description: "Models Ctrl+P cycles through; the picker opens in place.",
    currentValue: scopedModelsSummary(host),
    submenu: (_currentValue, done) =>
      embeddedHostPicker(host, "showModelsSelector", done, () => scopedModelsSummary(host)),
  };
}

/**
 * Applies a row's rename to the submenu it opens. Pi titles those submenus from
 * its own wording, so a renamed row would otherwise open a panel still carrying
 * the old name. Only the renamed rows are wrapped, and a title Pi rewords later
 * simply stops matching.
 */
function relabelSubmenu(component: Component, from: string, to: string): Component {
  const pattern = new RegExp(from.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return {
    render: (width: number) => component.render(width).map((line) => line.replace(pattern, to)),
    invalidate: () => component.invalidate?.(),
    handleInput: (data: string) => component.handleInput?.(data),
  };
}

function sectionRows(rows: SettingItem[], section: string): SettingItem[] {
  const wanted = PI_ROW_LAYOUT.find((entry) => entry.section === section)?.rows ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const placed: SettingItem[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) continue;
    const label = PI_ROW_LABELS.get(row.id);
    if (label === undefined) {
      placed.push(row);
      continue;
    }
    const submenu = row.submenu;
    const renamed: SettingItem = { ...row, label };
    if (submenu !== undefined) {
      renamed.submenu = (currentValue, done) =>
        relabelSubmenu(submenu(currentValue, done), row.label, label);
    }
    placed.push(renamed);
  }
  return placed;
}

/** Rows Pi built that no layout entry claims; they keep their own tab. */
function unclaimedRows(rows: SettingItem[]): SettingItem[] {
  const claimed = new Set(PI_ROW_LAYOUT.flatMap((entry) => entry.rows));
  return rows.filter((row) => !claimed.has(row.id));
}

/**
 * Spreads Pi's settings rows over the preferences panel by topic: some merge
 * into choco-ui sections, the rest own the Terminal, Session, Model, and Tools
 * tabs. Returns an empty list when no interactive mode is available (non-TUI
 * runs), and a single fallback tab when Pi's rows could not be read.
 */
export function buildNativeSettingsSections(): PreferencesExtraSection[] {
  const host = readBridge()?.host;
  if (!host) return [];

  let onChange: NativeSettingsRows["onChange"] | undefined;
  const readRows = (): SettingItem[] => {
    const rows = captureNativeSettingsRows(host);
    onChange = rows?.onChange;
    if (!rows) return [];
    const nativeThinkingRow = rows.items.some((row) => row.id === THINKING_ROW_ID);
    return [
      modelRow(host),
      scopedModelsRow(host),
      ...(nativeThinkingRow ? [] : [thinkingRow(host)]),
      ...rows.items,
    ];
  };
  const handleChange = (id: string, newValue: string): PreferencesSectionChange => {
    // These pickers already applied their change; the row only has to redraw.
    if (id === MODEL_ROW_ID || id === SCOPED_MODELS_ROW_ID || id === THINKING_ROW_ID) {
      return { kind: "update" };
    }
    if (!onChange) return { kind: "update" };
    onChange(id, newValue);
    // A refused TUI mode switch only updates Pi's own detached list, so the
    // row has to be re-read to stay truthful.
    return id === "tui-mode" ? { kind: "rebuild" } : { kind: "update" };
  };

  const merged = PI_ROW_LAYOUT.filter(
    (entry) => !PI_OWNED_SECTIONS.some((owned) => owned.id === entry.section),
  ).map(({ section }) => ({
    id: `${NATIVE_SETTINGS_SECTION_ID}:${section}`,
    label: "Pi",
    mergeInto: section,
    buildItems: (): SettingItem[] => sectionRows(readRows(), section),
    handleChange,
  }));

  const owned = PI_OWNED_SECTIONS.map(({ id, label }) => ({
    id,
    label,
    buildItems: (): SettingItem[] => sectionRows(readRows(), id),
    handleChange,
  }));

  const fallback: PreferencesExtraSection = {
    id: NATIVE_SETTINGS_SECTION_ID,
    label: "Pi",
    buildItems: (): SettingItem[] => {
      const rows = readRows();
      if (rows.length === 0) return [unavailableRow()];
      return unclaimedRows(rows);
    },
    handleChange,
  };

  const fallbackRows = fallback.buildItems();
  return [...merged, ...owned, ...(fallbackRows.length > 0 ? [fallback] : [])];
}
