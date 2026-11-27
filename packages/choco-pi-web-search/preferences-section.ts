import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Focusable,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { modelPickerSubmenu } from "../choco-pi-ui/extensions/zentui/model-picker.ts";
import {
  BUILTIN_SEARCH_PROVIDER_FAMILIES,
  formatSearchRouteTarget,
  parseSearchRouteTarget,
  type SearchScope,
} from "./index.ts";
import {
  getAttemptTimeoutSeconds,
  getConfiguredPriorityEntries,
  getConfiguredSummaryModel,
  isSummaryEnabled,
  loadConfigForExtensionInit,
  saveConfig,
  type WebSearchConfig,
} from "./extension-config.ts";

export const WEB_SEARCH_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.web-search-preferences-provider",
);

export type WebSearchSettingsChange = { kind: "update" } | { kind: "rebuild" };

export interface WebSearchPreferencesSection {
  id: "webSearch";
  label: "Web Search";
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => WebSearchSettingsChange;
}

export interface WebSearchPreferencesProvider {
  buildSections: (ctx: ExtensionContext) => WebSearchPreferencesSection[];
}

export interface WebSearchModelChoice {
  provider: string;
  id: string;
}

export interface WebSearchPreferencesState {
  priority: string[];
  summaryEnabled: boolean;
  summaryModel: string;
  attemptTimeoutSeconds: number;
  allowBilledApiFallback: boolean;
}

export interface WebSearchPreferencesOptions {
  state: WebSearchPreferencesState;
  priorityChoices: readonly string[];
  summaryModelChoices: readonly WebSearchModelChoice[];
  save?: (updates: Partial<WebSearchConfig>, removeKeys?: readonly string[]) => Promise<void>;
  ctx?: { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "notify"> };
  isActive?: () => boolean;
}

const SEARCH_MODEL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "google",
  "google-antigravity",
  "xai",
]);

const PRIORITY_RESET_TOKEN = "__AUTO__";
const SUMMARY_MODEL_AUTO = "auto";
const MIN_ATTEMPT_TIMEOUT_SECONDS = 5;
const MAX_ATTEMPT_TIMEOUT_SECONDS = 120;

let writeQueue: Promise<void> = Promise.resolve();
let writeError: string | undefined;

export function surfaceWebSearchWriteError(
  ctx: Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
): void {
  if (!writeError || !ctx.hasUI) return;
  const message = writeError;
  writeError = undefined;
  ctx.ui.notify(message, "warning");
}

export async function waitForWebSearchPreferenceWrites(): Promise<void> {
  await writeQueue;
}

export function readWebSearchPreferencesState(
  config: WebSearchConfig = loadConfigForExtensionInit(),
): WebSearchPreferencesState {
  return {
    priority: getConfiguredPriorityEntries(config),
    summaryEnabled: isSummaryEnabled(config),
    summaryModel: getConfiguredSummaryModel(config) ?? SUMMARY_MODEL_AUTO,
    attemptTimeoutSeconds: getAttemptTimeoutSeconds(config),
    allowBilledApiFallback: config.allowBilledApiFallback === true,
  };
}

export function buildPriorityChoices(
  scope: SearchScope | undefined,
  availableModels: readonly WebSearchModelChoice[],
  currentPriority: readonly string[],
): string[] {
  const choices: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const parsed = parseSearchRouteTarget(value);
    if (!parsed) return;
    const formatted = formatSearchRouteTarget(parsed);
    const key = formatted.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    choices.push(formatted);
  };

  for (const entry of currentPriority) add(entry);
  for (const family of BUILTIN_SEARCH_PROVIDER_FAMILIES) add(family);
  add("openai-codex");
  for (const adapter of scope?.adapters.values() ?? []) add(adapter.family);

  const sortedModels = [...availableModels]
    .filter((model) => SEARCH_MODEL_PROVIDERS.has(model.provider.toLowerCase()))
    .sort((left, right) =>
      left.provider === right.provider
        ? left.id.localeCompare(right.id)
        : left.provider.localeCompare(right.provider),
    );
  for (const model of sortedModels) {
    const prefix =
      model.provider.toLowerCase() === "google-antigravity" ? "google" : model.provider;
    add(`${prefix}/${model.id}`);
  }
  return choices;
}

export function formatPrioritySummary(entries: readonly string[]): string {
  if (entries.length === 0) return "auto";
  const joined = entries.join(" -> ");
  return joined.length > 56 ? `${joined.slice(0, 53)}...` : joined;
}

function parsePriorityValue(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === PRIORITY_RESET_TOKEN || trimmed.toLowerCase() === "auto") {
    return [];
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    const parsed = parseSearchRouteTarget(candidate);
    if (!parsed) return undefined;
    const formatted = formatSearchRouteTarget(parsed);
    const key = formatted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(formatted);
  }
  return entries;
}

class PriorityPickerPanel extends Container implements Focusable {
  private input = new Input({ prompt: "Add provider or provider/model: " });
  private list: SelectList;
  private onPick: (value: string) => void;
  private onCancel: () => void;

  constructor(choices: readonly string[], onPick: (value: string) => void, onCancel: () => void) {
    super();
    this.onPick = onPick;
    this.onCancel = onCancel;
    const theme = getSelectListTheme();
    const items = choices.map((value) => ({ value, label: value }));
    this.list = new SelectList(items, 8, {
      ...theme,
      noMatch: () => theme.noMatch("  Press Enter to use typed provider/model"),
    });
    this.list.onSelect = (item) => this.onPick(item.value);
    this.list.onCancel = () => this.onCancel();
    this.input.focused = true;
    this.addChild(this.input);
    this.addChild(this.list);
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      this.list.handleInput(data);
      return;
    }
    if (keys.matches(data, "tui.select.confirm")) {
      const selected = this.list.getSelectedItem();
      if (selected) {
        this.onPick(selected.value);
        return;
      }
      const typed = this.input.getValue().trim();
      if (typed && parseSearchRouteTarget(typed)) {
        this.onPick(typed);
      }
      return;
    }
    const previous = this.input.getValue();
    this.input.handleInput(data);
    const filter = this.input.getValue();
    if (filter !== previous) this.list.setFilter(filter);
  }
}

class PriorityEditorSubmenu extends Container implements Focusable {
  private entries: string[];
  private readonly allChoices: readonly string[];
  private readonly finish: (value?: string) => void;
  private selectedIndex = 0;
  private picker: PriorityPickerPanel | null = null;
  private _focused = true;
  private dirty = false;

  constructor(
    initialEntries: readonly string[],
    allChoices: readonly string[],
    done: (value?: string) => void,
  ) {
    super();
    this.entries = [...initialEntries];
    this.allChoices = allChoices;
    let settled = false;
    this.finish = (value?: string) => {
      if (settled) return;
      settled = true;
      done(value);
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.picker) this.picker.focused = value;
  }

  private totalRows(): number {
    return this.entries.length + 1;
  }

  private clampIndex(): void {
    const max = Math.max(0, this.totalRows() - 1);
    if (this.selectedIndex > max) this.selectedIndex = max;
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  private openPicker(): void {
    const existing = new Set(this.entries.map((entry) => entry.toLowerCase()));
    const remaining = this.allChoices.filter((choice) => !existing.has(choice.toLowerCase()));
    this.picker = new PriorityPickerPanel(
      remaining,
      (picked) => {
        const parsed = parseSearchRouteTarget(picked);
        if (parsed) {
          const formatted = formatSearchRouteTarget(parsed);
          if (!this.entries.some((entry) => entry.toLowerCase() === formatted.toLowerCase())) {
            this.entries.push(formatted);
            this.selectedIndex = this.entries.length - 1;
            this.dirty = true;
          }
        }
        this.picker = null;
      },
      () => {
        this.picker = null;
      },
    );
  }

  private moveSelected(delta: -1 | 1): void {
    if (this.selectedIndex >= this.entries.length) return;
    const target = this.selectedIndex + delta;
    if (target < 0 || target >= this.entries.length) return;
    const current = this.entries[this.selectedIndex];
    const swap = this.entries[target];
    if (current === undefined || swap === undefined) return;
    this.entries[this.selectedIndex] = swap;
    this.entries[target] = current;
    this.selectedIndex = target;
    this.dirty = true;
  }

  private removeSelected(): void {
    if (this.selectedIndex >= this.entries.length) return;
    this.entries.splice(this.selectedIndex, 1);
    this.dirty = true;
    this.clampIndex();
  }

  override render(width: number): string[] {
    if (this.picker) {
      return [
        truncateToWidth("Add search provider or provider/model (Esc to go back)", width),
        ...this.picker.render(width),
      ];
    }
    const lines: string[] = [
      truncateToWidth("Web search priority order (auto-fallback top to bottom):", width),
    ];
    if (this.entries.length === 0) {
      lines.push(truncateToWidth("  (auto: default provider order)", width));
    } else {
      for (let i = 0; i < this.entries.length; i++) {
        const prefix = i === this.selectedIndex ? "> " : "  ";
        lines.push(truncateToWidth(`${prefix}${i + 1}. ${this.entries[i]}`, width));
      }
    }
    const addPrefix = this.selectedIndex === this.entries.length ? "> " : "  ";
    lines.push(truncateToWidth(`${addPrefix}+ Add provider or provider/model`, width));
    lines.push(
      truncateToWidth(
        "  Keys: a/Enter add · u/d or [/] reorder · x/Backspace remove · r reset auto · Esc save",
        width,
      ),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (this.picker) {
      this.picker.handleInput(data);
      return;
    }
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      if (this.dirty) {
        this.finish(this.entries.length === 0 ? PRIORITY_RESET_TOKEN : this.entries.join(", "));
      } else {
        this.finish();
      }
      return;
    }
    if (matchesKey(data, "shift+up") || data === "u" || data === "U" || data === "[") {
      this.moveSelected(-1);
      return;
    }
    if (matchesKey(data, "shift+down") || data === "d" || data === "D" || data === "]") {
      this.moveSelected(1);
      return;
    }
    if (keys.matches(data, "tui.select.up")) {
      this.selectedIndex = (this.selectedIndex - 1 + this.totalRows()) % this.totalRows();
      return;
    }
    if (keys.matches(data, "tui.select.down")) {
      this.selectedIndex = (this.selectedIndex + 1) % this.totalRows();
      return;
    }
    if (data === "a" || data === "A") {
      this.openPicker();
      return;
    }
    if (keys.matches(data, "tui.select.confirm")) {
      if (this.selectedIndex === this.entries.length) {
        this.openPicker();
      } else {
        this.finish(this.entries.length === 0 ? PRIORITY_RESET_TOKEN : this.entries.join(", "));
      }
      return;
    }
    if (
      data === "x" ||
      data === "X" ||
      matchesKey(data, "backspace") ||
      matchesKey(data, "delete")
    ) {
      this.removeSelected();
      return;
    }
    if (data === "r" || data === "R") {
      if (this.entries.length > 0) {
        this.entries = [];
        this.selectedIndex = 0;
        this.dirty = true;
      }
    }
  }
}

function buildSummaryModelSubmenu(
  choices: readonly WebSearchModelChoice[],
  current: string,
): NonNullable<SettingItem["submenu"]> {
  const basePicker = modelPickerSubmenu({
    choices: [{ provider: "auto", id: "default" }, ...choices],
    onPick: () => {},
  });
  return (_currentValue, done) => {
    const normalizedCurrent = current === SUMMARY_MODEL_AUTO ? "auto/default" : current;
    const component = basePicker(normalizedCurrent, (picked) => {
      if (picked === undefined) {
        done();
        return;
      }
      done(picked === "auto/default" ? SUMMARY_MODEL_AUTO : picked);
    });
    return component;
  };
}

export function buildWebSearchPreferencesSection(
  options: WebSearchPreferencesOptions,
): WebSearchPreferencesSection {
  const persist = options.save ?? saveConfig;
  let state: WebSearchPreferencesState = {
    ...options.state,
    priority: [...options.state.priority],
  };

  const commit = (
    next: WebSearchPreferencesState,
    updates: Partial<WebSearchConfig>,
    removeKeys?: readonly string[],
  ): WebSearchSettingsChange => {
    const previous = { ...state, priority: [...state.priority] };
    state = next;
    options.state.priority = [...next.priority];
    options.state.summaryEnabled = next.summaryEnabled;
    options.state.summaryModel = next.summaryModel;
    options.state.attemptTimeoutSeconds = next.attemptTimeoutSeconds;
    options.state.allowBilledApiFallback = next.allowBilledApiFallback;
    writeQueue = writeQueue
      .then(() => persist(updates, removeKeys))
      .catch((error) => {
        writeError = `Could not save web search settings: ${error instanceof Error ? error.message : String(error)}`;
        state = previous;
        options.state.priority = [...previous.priority];
        options.state.summaryEnabled = previous.summaryEnabled;
        options.state.summaryModel = previous.summaryModel;
        options.state.attemptTimeoutSeconds = previous.attemptTimeoutSeconds;
        options.state.allowBilledApiFallback = previous.allowBilledApiFallback;
        if ((!options.isActive || options.isActive()) && options.ctx?.hasUI) {
          surfaceWebSearchWriteError(options.ctx);
        }
      });
    return { kind: "rebuild" };
  };

  return {
    id: "webSearch",
    label: "Web Search",
    buildItems: () => {
      const priorityItem: SettingItem = {
        id: "webSearch.priority",
        label: "Search priority",
        description:
          "Ordered providers or provider/model entries tried top-to-bottom with automatic fallback.",
        currentValue: formatPrioritySummary(state.priority),
        submenu: (_current, done) =>
          new PriorityEditorSubmenu(state.priority, options.priorityChoices, done),
      };
      const summaryItem: SettingItem = {
        id: "webSearch.summary",
        label: "Summarize results",
        description:
          "Return a concise summary by default; full raw results stay stored for get_search_content.",
        currentValue: state.summaryEnabled ? "on" : "off",
        values: ["off", "on"],
      };
      const summaryModelItem: SettingItem = {
        id: "webSearch.summaryModel",
        label: "Summary model",
        description: "Model used to summarize web_search results (auto picks a fast model).",
        currentValue: state.summaryModel,
        submenu: buildSummaryModelSubmenu(options.summaryModelChoices, state.summaryModel),
      };
      const timeoutItem: SettingItem = {
        id: "webSearch.attemptTimeoutSeconds",
        label: "Attempt timeout (s)",
        description: `Per-provider timeout in seconds (${MIN_ATTEMPT_TIMEOUT_SECONDS}-${MAX_ATTEMPT_TIMEOUT_SECONDS}) before falling back.`,
        currentValue: String(state.attemptTimeoutSeconds),
        submenu: (current, done) => {
          const input = new Input({
            prompt: `Timeout (${MIN_ATTEMPT_TIMEOUT_SECONDS}-${MAX_ATTEMPT_TIMEOUT_SECONDS}s): `,
          });
          input.setValue(current);
          input.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!/^\d+$/.test(trimmed)) return;
            const seconds = Number(trimmed);
            if (
              Number.isSafeInteger(seconds) &&
              seconds >= MIN_ATTEMPT_TIMEOUT_SECONDS &&
              seconds <= MAX_ATTEMPT_TIMEOUT_SECONDS
            ) {
              done(String(seconds));
            }
          };
          input.onEscape = () => done();
          return input;
        },
      };
      const billedFallbackItem: SettingItem = {
        id: "webSearch.allowBilledApiFallback",
        label: "Billed API fallback (auto)",
        description:
          "In unconfigured auto mode, allow falling back from a subscription to a billed API.",
        currentValue: state.allowBilledApiFallback ? "on" : "off",
        values: ["off", "on"],
      };
      return [priorityItem, summaryItem, summaryModelItem, timeoutItem, billedFallbackItem];
    },
    handleChange: (id, newValue) => {
      if (id === "webSearch.priority") {
        const parsed = parsePriorityValue(newValue);
        if (parsed === undefined) {
          if (options.ctx?.hasUI) options.ctx.ui.notify("Invalid web search priority", "warning");
          return { kind: "rebuild" };
        }
        const next = { ...state, priority: parsed };
        if (parsed.length === 0) {
          return commit(next, {}, ["priority", "searchRouting"]);
        }
        return commit(next, { priority: parsed }, ["searchRouting"]);
      }
      if (id === "webSearch.summary") {
        if (newValue !== "on" && newValue !== "off") return { kind: "rebuild" };
        const enabled = newValue === "on";
        const next = { ...state, summaryEnabled: enabled };
        return commit(next, { summary: { enabled } }, ["workflow"]);
      }
      if (id === "webSearch.summaryModel") {
        const trimmed = newValue.trim();
        if (!trimmed || trimmed === SUMMARY_MODEL_AUTO) {
          const next = { ...state, summaryModel: SUMMARY_MODEL_AUTO };
          return commit(next, {}, ["summaryModel"]);
        }
        const next = { ...state, summaryModel: trimmed };
        return commit(next, { summaryModel: trimmed });
      }
      if (id === "webSearch.attemptTimeoutSeconds") {
        if (!/^\d+$/.test(newValue.trim())) return { kind: "rebuild" };
        const seconds = Number(newValue.trim());
        if (
          !Number.isSafeInteger(seconds) ||
          seconds < MIN_ATTEMPT_TIMEOUT_SECONDS ||
          seconds > MAX_ATTEMPT_TIMEOUT_SECONDS
        ) {
          return { kind: "rebuild" };
        }
        const next = { ...state, attemptTimeoutSeconds: seconds };
        return commit(next, { attemptTimeoutMs: seconds * 1000 });
      }
      if (id === "webSearch.allowBilledApiFallback") {
        if (newValue !== "on" && newValue !== "off") return { kind: "rebuild" };
        const allowed = newValue === "on";
        const next = { ...state, allowBilledApiFallback: allowed };
        return commit(next, { allowBilledApiFallback: allowed });
      }
      return { kind: "rebuild" };
    },
  };
}

export function registerWebSearchPreferencesProvider(
  scope: SearchScope,
  isActive: () => boolean,
): (() => void) | undefined {
  const registered = () =>
    Object.getOwnPropertyDescriptor(globalThis, WEB_SEARCH_PREFERENCES_PROVIDER_SYMBOL)?.value;
  if (registered() !== undefined) return undefined;
  const provider: WebSearchPreferencesProvider = {
    buildSections: (ctx) => {
      if (!isActive()) return [];
      surfaceWebSearchWriteError(ctx);
      const state = readWebSearchPreferencesState();
      let availableModels: WebSearchModelChoice[] = [];
      try {
        availableModels = ctx.modelRegistry
          .getAvailable()
          .map((model) => ({ provider: model.provider, id: model.id }));
      } catch {
        availableModels = [];
      }
      const priorityChoices = buildPriorityChoices(scope, availableModels, state.priority);
      return [
        buildWebSearchPreferencesSection({
          state,
          priorityChoices,
          summaryModelChoices: availableModels,
          ctx,
          isActive,
        }),
      ];
    },
  };
  Object.defineProperty(globalThis, WEB_SEARCH_PREFERENCES_PROVIDER_SYMBOL, {
    configurable: true,
    writable: true,
    value: provider,
  });
  return () => {
    if (registered() === provider) {
      Reflect.deleteProperty(globalThis, WEB_SEARCH_PREFERENCES_PROVIDER_SYMBOL);
    }
  };
}
