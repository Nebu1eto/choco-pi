import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { PreferencesExtraSection, PreferencesSectionChange } from "./agent-preferences.ts";
import { isFunction, isString, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

export const NATIVE_SETTINGS_SECTION_ID = "pi";

/** Outcome strings the Pi sections emit use this prefix. */
export const NATIVE_OUTCOME_PREFIX = "pi:";
export const NATIVE_MODEL_OUTCOME = `${NATIVE_OUTCOME_PREFIX}model`;

const MODEL_ROW_ID = "piModel";

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
    rows: [MODEL_ROW_ID, "thinking", "transport", "http-idle-timeout"],
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
  /** Opens the unified dialog. Replaced on every extension load. */
  open?: (host: NativeSettingsHost) => void;
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
export function installNativeSettingsBridge(open: (host: NativeSettingsHost) => void): void {
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
 * Builds Pi's real settings rows and hands back the list plus its change
 * handler. Pi builds both inside `showSettingsSelector`, so the only way to
 * obtain them is to run that method with `showSelector` swapped for a collector.
 * Reusing them keeps every runtime effect (theme switching, chat rebuilds,
 * transport changes) in Pi's own callbacks instead of a copy that would drift.
 */
function captureNativeSettingsRows(host: NativeSettingsHost): NativeSettingsRows | undefined {
  const bridge = readBridge();
  if (!bridge) return undefined;

  let captured: RuntimeValue;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(host);
  const hadOwnShowSelector = Object.prototype.hasOwnProperty.call(host, "showSelector");
  const previousShowSelector = record["showSelector"];
  record["showSelector"] = (create: SelectorFactory): void => {
    captured = create(() => {});
  };
  try {
    bridge.original.call(host);
  } catch {
    return undefined;
  } finally {
    if (hadOwnShowSelector) record["showSelector"] = previousShowSelector;
    else delete record["showSelector"];
  }

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

/**
 * The row that hands off to Pi's own model selector. Pi builds no such row for
 * its settings menu, because `/model` covers it there.
 */
function modelRow(host: NativeSettingsHost): SettingItem {
  const model = propertyOf(propertyOf(host, "session"), "model");
  const id = propertyOf(model, "id");
  return {
    id: MODEL_ROW_ID,
    label: "Model",
    description: "Opens the model selector; the panel closes while you choose.",
    currentValue: isString(id) ? id : "select…",
    values: ["select…"],
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
    placed.push(label === undefined ? row : { ...row, label });
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
    return rows ? [modelRow(host), ...rows.items] : [];
  };
  const handleChange = (id: string, newValue: string): PreferencesSectionChange => {
    if (id === MODEL_ROW_ID) return { kind: "outcome", outcome: NATIVE_MODEL_OUTCOME };
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

/**
 * Runs a follow-up flow for a Pi row while the dialog is closed. Opening the
 * model selector deliberately reports no focus: the selector takes over the
 * editor, so reopening the dialog on top of it would hide it.
 */
export function runNativeSettingsOutcome(outcome: string): boolean {
  if (outcome !== NATIVE_MODEL_OUTCOME) return false;
  const host = readBridge()?.host;
  const show = propertyOf(host, "showModelSelector");
  if (!host || !isFunction(show)) return false;
  reinterpretHostValue<(this: NativeSettingsHost) => void>(show).call(host);
  return true;
}
