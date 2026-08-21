import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { PreferencesExtraSection, PreferencesSectionChange } from "./agent-preferences.ts";
import { isFunction, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

export const NATIVE_SETTINGS_SECTION_ID = "pi";

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
 * Builds the Pi section of the preferences panel from Pi's own settings rows,
 * or `undefined` when no interactive mode is available (non-TUI runs).
 */
export function buildNativeSettingsSection(): PreferencesExtraSection | undefined {
  const host = readBridge()?.host;
  if (!host) return undefined;
  let onChange: NativeSettingsRows["onChange"] | undefined;
  return {
    id: NATIVE_SETTINGS_SECTION_ID,
    label: "Pi",
    buildItems(): SettingItem[] {
      const rows = captureNativeSettingsRows(host);
      onChange = rows?.onChange;
      return rows ? rows.items : [unavailableRow()];
    },
    handleChange(id, newValue): PreferencesSectionChange {
      if (!onChange) return { kind: "update" };
      onChange(id, newValue);
      // A refused TUI mode switch only updates Pi's own detached list, so the
      // row has to be re-read to stay truthful.
      return id === "tui-mode" ? { kind: "rebuild" } : { kind: "update" };
    },
  };
}
