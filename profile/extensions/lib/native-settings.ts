import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type Component,
  type SettingItem,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { PreferencesExtraSection, PreferencesSectionChange } from "./agent-preferences.ts";
import { isStaleContextError } from "./lifecycle.ts";
import { isFunction, isString, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

export const NATIVE_SETTINGS_SECTION_ID = "pi";

const MODEL_ROW_ID = "piModel";
const SCOPED_MODELS_ROW_ID = "piScopedModels";

export const THINKING_ROW_ID = "thinking";

export interface NativeSettingsFocus {
  section: string;
  focusId: string;
  openSubmenu: boolean;
}

export const MODEL_PICKER_FOCUS: NativeSettingsFocus = {
  section: "model",
  focusId: MODEL_ROW_ID,
  openSubmenu: true,
};

export const EFFORT_PICKER_FOCUS: NativeSettingsFocus = {
  section: "model",
  focusId: THINKING_ROW_ID,
  openSubmenu: true,
};

const PI_ROW_LABELS = new Map<string, string>([["thinking", "Reasoning effort"]]);

export const TERMINAL_SECTION_ID = "terminal";
export const SESSION_SECTION_ID = "session";
export const MODEL_SECTION_ID = "model";
export const TOOLS_SECTION_ID = "tools";

export const PI_MODEL_ROW_ID = MODEL_ROW_ID;
export const PI_SCOPED_MODELS_ROW_ID = SCOPED_MODELS_ROW_ID;

const NATIVE_SETTINGS_BRIDGE = Symbol.for("choco-pi.native-settings-bridge");

export interface NativeSettingsHost {
  showSettingsSelector: () => void;
  showSelector: (create: (done: () => void) => RuntimeValue) => void;
}

type SelectorFactory = (done: () => void) => RuntimeValue;

interface NativeSettingsBridge {
  original: (this: NativeSettingsHost) => void;
  originalModelCommand?: (this: NativeSettingsHost, searchTerm?: string) => Promise<void>;
  open?: (host: NativeSettingsHost, focus?: NativeSettingsFocus) => void;
  host?: NativeSettingsHost;
}

function bridgeStore(): Record<PropertyKey, RuntimeValue> {
  return reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
}

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

export function hostThinkingLevel(host: NativeSettingsHost): string | undefined {
  let level: RuntimeValue;
  try {
    level = propertyOf(propertyOf(host, "session"), "thinkingLevel");
  } catch {
    return undefined;
  }
  return isString(level) ? level : undefined;
}

function openOrFallback(
  bridge: NativeSettingsBridge,
  open: NonNullable<NativeSettingsBridge["open"]>,
  host: NativeSettingsHost,
  focus: NativeSettingsFocus | undefined,
  fallback: () => void,
): void {
  try {
    open(host, focus);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
    if (bridge.open === open) bridge.open = undefined;
    fallback();
  }
}

export function installNativeSettingsBridge(
  open: (host: NativeSettingsHost, focus?: NativeSettingsFocus) => void,
  options: { inChildLoad?: boolean } = {},
): void {
  if (options.inChildLoad === true) return;
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
    const current = bridge.open;
    if (current) openOrFallback(bridge, current, this, undefined, () => bridge.original.call(this));
    else bridge.original.call(this);
  };

  const modelCommand = prototype["handleModelCommand"];
  if (isFunction(modelCommand)) {
    bridge.originalModelCommand =
      reinterpretHostValue<NonNullable<NativeSettingsBridge["originalModelCommand"]>>(modelCommand);
    prototype["handleModelCommand"] = async function patchedHandleModelCommand(
      this: NativeSettingsHost,
      searchTerm?: string,
    ): Promise<void> {
      bridge.host = this;
      const current = bridge.open;
      if (searchTerm === undefined && current) {
        let fellBack = false;
        openOrFallback(bridge, current, this, MODEL_PICKER_FOCUS, () => {
          fellBack = true;
        });
        if (!fellBack) return;
      }
      await bridge.originalModelCommand?.call(this, searchTerm);
    };
  }

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

export function openNativeSettingsMenu(host: NativeSettingsHost): void {
  readBridge()?.original.call(host);
}

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

function unavailablePicker(done: (value?: string) => void): Component {
  return {
    render: () => ["", "  The model selector is unavailable in this session.", ""],
    invalidate: () => {},
    handleInput: () => done(),
  };
}

const BOX_DRAWING_ONLY = /^[\u2500-\u257F\s]+$/;

function isRuleLine(line: string): boolean {
  const text = stripTerminalSequences(line);
  return text.trim().length > 0 && BOX_DRAWING_ONLY.test(text);
}

function withoutOuterRules(component: Component): Component {
  let dropped = { top: 0, total: 0 };
  return {
    render: (width: number) => {
      const lines = component.render(width);
      const first = isRuleLine(lines[0] ?? "") ? 1 : 0;
      const last = lines.length > first && isRuleLine(lines.at(-1) ?? "") ? 1 : 0;
      dropped = { top: first, total: first + last };
      return lines.slice(first, lines.length - last);
    },
    invalidate: () => component.invalidate?.(),
    handleInput: (data: string) => component.handleInput?.(data),
    handleMouse: (event: TuiMouseEvent) =>
      component.handleMouse?.({
        ...event,
        y: event.y + dropped.top,
        height: event.height + dropped.total,
      }),
  };
}

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
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(component);
  if ("focused" in record) record["focused"] = true;
  return withoutOuterRules(reinterpretHostValue<Component>(component));
}

function scopedModelsSummary(host: NativeSettingsHost): string {
  const scoped = propertyOf(propertyOf(host, "session"), "scopedModels");
  const count = Array.isArray(scoped) ? scoped.length : 0;
  return count === 0 ? "all models" : `${count} selected`;
}

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

function relabelSubmenu(component: Component, from: string, to: string): Component {
  const pattern = new RegExp(from.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return {
    render: (width: number) => component.render(width).map((line) => line.replace(pattern, to)),
    invalidate: () => component.invalidate?.(),
    handleInput: (data: string) => component.handleInput?.(data),
    handleMouse: (event: TuiMouseEvent) => component.handleMouse?.(event),
  };
}

function relabeled(row: SettingItem): SettingItem {
  const label = PI_ROW_LABELS.get(row.id);
  if (label === undefined) return row;
  const submenu = row.submenu;
  const renamed: SettingItem = { ...row, label };
  if (submenu !== undefined) {
    renamed.submenu = (currentValue, done) =>
      relabelSubmenu(submenu(currentValue, done), row.label, label);
  }
  return renamed;
}

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
      ...rows.items.map(relabeled),
    ];
  };
  const handleChange = (id: string, newValue: string): PreferencesSectionChange => {
    if (id === MODEL_ROW_ID || id === SCOPED_MODELS_ROW_ID || id === THINKING_ROW_ID) {
      return { kind: "update" };
    }
    if (!onChange) return { kind: "update" };
    onChange(id, newValue);
    return { kind: "update" };
  };

  return [
    {
      id: NATIVE_SETTINGS_SECTION_ID,
      label: "Pi",
      buildItems: (): SettingItem[] => {
        const rows = readRows();
        return rows.length === 0 ? [unavailableRow()] : rows;
      },
      handleChange,
    },
  ];
}
