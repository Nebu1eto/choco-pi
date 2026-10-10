import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FuzzyMentionEditor } from "../packages/choco-pi-ui/extensions/fuzzy-mention/editor.ts";
import { IgnoreAwareFileCache } from "../packages/choco-pi-ui/extensions/fuzzy-mention/file-cache.ts";
import { rethrowUnlessStaleContext } from "./lib/lifecycle.ts";
import {
  createPromptSuggestionController,
  renderGhostSuggestion,
  type PromptSuggestionController,
  type PromptSuggestionSlot,
} from "./lib/prompt-suggestion.ts";
import {
  isBoolean,
  isJsonRecord,
  isNumber,
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "./lib/runtime-values.ts";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type EditorComponent } from "@earendil-works/pi-tui";

interface EditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

// Pi 0.84.1 has no public cursor/paste snapshot API. Keep this adapter aligned
// with its pinned Editor implementation so stash can preserve both precisely.
interface EditorInternals extends EditorComponent {
  state: EditorState;
  pastes: Map<number, string>;
  pasteCounter: number;
  undoStack: { clear(): void };
  historyIndex: number;
  historyDraft: EditorState | null;
  scrollOffset: number;
  preferredVisualCol: number | null;
  snappedFromCursorCol: number | null;
  lastAction: unknown;
  isShowingAutocomplete?(): boolean;
}

export interface PromptStash {
  state: EditorState;
  pastes: Map<number, string>;
  pasteCounter: number;
}

/** Where the stash lives. The default store is process-wide so a draft survives editor rebuilds and `/reload`. */
export interface PromptStashStore {
  get(): PromptStash | undefined;
  set(value: PromptStash | undefined): void;
}

type StashRestoreTarget = {
  generation: number;
  restore: () => boolean;
};

/** Routes an `input` event to the most recently decorated editor of the current session generation. */
export interface PromptStashController {
  readonly generation: number;
  advance(): number;
  isCurrent(generation: number): boolean;
  register(target: StashRestoreTarget): void;
  restore(): boolean;
}

export type PromptStashBinding = {
  store: PromptStashStore;
  controller: PromptStashController;
  generation: number;
};

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type PromptEditorState = {
  onStashChange: (stashed: boolean) => void;
  binding?: PromptStashBinding;
  suggestion?: PromptSuggestionSlot;
};

type PromptEditorFactory = EditorFactory & {
  [factoryState]?: PromptEditorState;
  [symbol: symbol]: RuntimeValue;
};

type EditorFactoryUi = {
  getEditorComponent(): EditorFactory | undefined;
  setEditorComponent(factory: EditorFactory): void;
};

type EditorInstallOptions = {
  intervalMs?: number;
  maxAttempts?: number;
  schedule?: (callback: () => void, delayMs: number) => void;
};

const factoryState = Symbol.for("choco-pi.prompt-editor.factory");
const decoratedEditor = Symbol.for("choco-pi.prompt-editor.instance");
const zentuiEditorFactory = Symbol.for("pi-zentui.editor-factory");
const stashStoreKey = Symbol.for("choco-pi.prompt-editor.stash");
export const FUZZY_FILE_MENTIONS_SETTING = "fuzzyFileMentions";

type DecoratedEditor = EditorInternals & { [decoratedEditor]?: true };

type StashRecord = { stash?: RuntimeValue };

function propertyOf(value: RuntimeValue, key: string): RuntimeValue {
  if (value === undefined || value === null) return undefined;
  return reinterpretHostValue<Record<string, RuntimeValue>>(value)[key];
}

function isIndex(value: RuntimeValue): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a stash read from process-global state. A reloaded module may be
 * newer or older code than the one that wrote it, so nothing is trusted.
 */
export function readPromptStash(value: RuntimeValue): PromptStash | undefined {
  if (!isJsonRecord(value)) return undefined;
  const state = propertyOf(value, "state");
  const rawLines = propertyOf(state, "lines");
  const cursorLine = propertyOf(state, "cursorLine");
  const cursorCol = propertyOf(state, "cursorCol");
  const rawPastes = propertyOf(value, "pastes");
  const pasteCounter = propertyOf(value, "pasteCounter");
  if (!Array.isArray(rawLines) || !isIndex(cursorLine) || !isIndex(cursorCol)) return undefined;
  if (!isIndex(pasteCounter) || !(rawPastes instanceof Map)) return undefined;

  const lines: string[] = [];
  for (const line of reinterpretHostValue<RuntimeValue[]>(rawLines)) {
    if (!isString(line)) return undefined;
    lines.push(line);
  }
  const cursorText = lines[cursorLine];
  if (cursorText === undefined || cursorCol > cursorText.length) return undefined;

  const pastes = new Map<number, string>();
  for (const [id, text] of reinterpretHostValue<Map<RuntimeValue, RuntimeValue>>(rawPastes)) {
    if (!isIndex(id) || !isString(text)) return undefined;
    pastes.set(id, text);
  }
  return { state: { lines, cursorLine, cursorCol }, pastes, pasteCounter };
}

function globalStashRecord(): StashRecord {
  const existing =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[stashStoreKey];
  if (isJsonRecord(existing)) return reinterpretHostValue<StashRecord>(existing);
  const record: StashRecord = {};
  Object.defineProperty(globalThis, stashStoreKey, {
    configurable: true,
    writable: true,
    value: record,
  });
  return record;
}

/** Process-lifetime stash; cleared only when a draft is restored. */
export const globalPromptStashStore: PromptStashStore = {
  get: () => readPromptStash(globalStashRecord().stash),
  set: (value) => {
    globalStashRecord().stash = value;
  },
};

export function createPromptStashController(): PromptStashController {
  let generation = 0;
  let target: StashRestoreTarget | undefined;
  return {
    get generation() {
      return generation;
    },
    advance() {
      generation += 1;
      target = undefined;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    register(next) {
      if (next.generation === generation) target = next;
    },
    restore() {
      const current = target;
      if (!current || current.generation !== generation) return false;
      return current.restore();
    },
  };
}

export function decoratePromptEditor(
  editor: EditorComponent,
  onStashChange: (stashed: boolean) => void,
  requestRender: () => void,
  binding?: PromptStashBinding,
  suggestion?: PromptSuggestionSlot,
): EditorComponent {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const target = editor as DecoratedEditor;
  if (target[decoratedEditor]) return editor;

  const store = binding?.store ?? globalPromptStashStore;
  const handleInput = editor.handleInput.bind(editor);
  const render = editor.render.bind(editor);

  // A suggestion shows only in an empty editor with no autocomplete menu open.
  const visibleSuggestion = (): string | undefined => {
    const text = suggestion?.text;
    if (text === undefined || target.getText() !== "") return undefined;
    return target.isShowingAutocomplete?.() ? undefined : text;
  };

  const restoreStash = (): boolean => {
    const restored = store.get();
    if (!restored) return false;

    target.state = restored.state;
    target.pastes = restored.pastes;
    target.pasteCounter = restored.pasteCounter;
    target.historyIndex = -1;
    target.historyDraft = null;
    target.scrollOffset = 0;
    target.preferredVisualCol = null;
    target.snappedFromCursorCol = null;
    target.lastAction = null;
    target.undoStack.clear();
    store.set(undefined);
    onStashChange(false);
    target.onChange?.(target.getText());
    requestRender();
    return true;
  };

  const stashOrRestore = (): void => {
    if (target.getText().length > 0) {
      const { state, pastes, pasteCounter } = target;
      store.set(structuredClone({ state, pastes, pasteCounter }));
      target.setText("");
      target.undoStack.clear();
      onStashChange(true);
      return;
    }

    restoreStash();
  };

  target.handleInput = (data: string): void => {
    if (matchesKey(data, "ctrl+s")) {
      stashOrRestore();
      return;
    }
    const suggested = visibleSuggestion();
    if (suggestion && suggested !== undefined && getKeybindings().matches(data, "tui.input.tab")) {
      suggestion.text = undefined;
      target.setText(suggested);
      requestRender();
      return;
    }
    // Submitting never restores here: Enter also runs commands and bash. The
    // extension's `input` handler restores only once a real prompt is accepted.
    handleInput(data);
  };

  if (suggestion) {
    suggestion.requestRender = requestRender;
    target.render = (width: number): string[] => {
      const lines = render(width);
      const suggested = visibleSuggestion();
      return suggested === undefined ? lines : renderGhostSuggestion(lines, suggested);
    };
  }

  Object.defineProperty(target, decoratedEditor, { value: true });
  binding?.controller.register({
    generation: binding.generation,
    // Never overwrite a draft typed after submission; keep the stash for Ctrl+S.
    restore: () => target.getText().length === 0 && restoreStash(),
  });
  onStashChange(store.get() !== undefined);
  return editor;
}

function factoryStateOf(factory: EditorFactory | undefined): PromptEditorState | undefined {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return factory ? (factory as PromptEditorFactory)[factoryState] : undefined;
}

function isZentuiFactory(factory: EditorFactory | undefined): boolean {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return factory ? Boolean((factory as PromptEditorFactory)[zentuiEditorFactory]) : false;
}

export function wrapPromptEditorFactory(
  baseFactory: EditorFactory,
  state: PromptEditorState,
): EditorFactory {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const existing = (baseFactory as PromptEditorFactory)[factoryState];
  if (existing) {
    Object.assign(existing, state);
    return baseFactory;
  }

  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const wrappedFactory = ((...args: Parameters<EditorFactory>) => {
    const editor = baseFactory(...args);
    return decoratePromptEditor(
      editor,
      state.onStashChange,
      () => args[0].requestRender(),
      state.binding,
      state.suggestion,
    );
  }) as PromptEditorFactory;
  Object.defineProperty(wrappedFactory, factoryState, { value: state });

  // Keep Zentui ownership and other factory adapters intact. Fleet navigation
  // then sees the original PolishedEditor instance instead of a wrapper object.
  for (const symbol of Object.getOwnPropertySymbols(baseFactory)) {
    if (symbol === factoryState) continue;
    const descriptor = Object.getOwnPropertyDescriptor(baseFactory, symbol);
    if (descriptor) Object.defineProperty(wrappedFactory, symbol, descriptor);
  }
  return wrappedFactory;
}

export function installPromptEditorWhenReady(
  ui: EditorFactoryUi,
  state: PromptEditorState,
  isCurrent: () => boolean,
  options: EditorInstallOptions = {},
): void {
  const intervalMs = options.intervalMs ?? 50;
  const maxAttempts = options.maxAttempts ?? 100;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  let attempts = 0;

  const tryInstall = (): void => {
    if (!isCurrent()) return;
    try {
      const factory = ui.getEditorComponent();
      if (factory && isZentuiFactory(factory)) {
        // Already installed with this exact state: rebuilding would only drop editor-private state.
        if (factoryStateOf(factory) === state) return;
        ui.setEditorComponent(wrapPromptEditorFactory(factory, state));
        return;
      }
    } catch {
      // Zentui may be replacing the editor while this retry runs.
    }

    attempts++;
    if (attempts < maxAttempts) schedule(tryInstall, intervalMs);
  };

  schedule(tryInstall, intervalMs);
}

function readFuzzyMentionsFlag(settingsPath: string): boolean | undefined {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const settings: RuntimeValue = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isJsonRecord(settings)) return undefined;
    const enabled = settings[FUZZY_FILE_MENTIONS_SETTING];
    return isBoolean(enabled) ? enabled : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project settings win when the key is present there; otherwise the agent
 * profile's value applies. The repository's `.pi/settings.json` carries the
 * documented default (`false`).
 */
export function fuzzyFileMentionsEnabled(agentDir = getAgentDir(), projectDir?: string): boolean {
  const project =
    projectDir === undefined
      ? undefined
      : readFuzzyMentionsFlag(join(projectDir, ".pi", "settings.json"));
  if (project !== undefined) return project;
  return readFuzzyMentionsFlag(join(agentDir, "settings.json")) === true;
}

export type PromptEditorOptions = {
  store?: PromptStashStore;
  agentDir?: () => string;
  schedule?: EditorInstallOptions["schedule"];
  suggestions?: PromptSuggestionController;
};

export function createPromptEditor(options: PromptEditorOptions = {}): (pi: ExtensionAPI) => void {
  const store = options.store ?? globalPromptStashStore;
  const agentDir = options.agentDir ?? getAgentDir;
  const installOptions: EditorInstallOptions = options.schedule
    ? { schedule: options.schedule }
    : {};

  return (pi) => {
    const controller = createPromptStashController();
    const suggestions = options.suggestions ?? createPromptSuggestionController();
    let activeFileCache: IgnoreAwareFileCache | undefined;
    let zentuiInstall: { state: PromptEditorState; isCurrent: () => boolean } | undefined;

    pi.on("session_start", (_event, ctx) => {
      activeFileCache?.invalidate();
      activeFileCache = undefined;
      zentuiInstall = undefined;
      const generation = controller.advance();
      suggestions.stop();
      if (ctx.mode !== "tui") return;
      suggestions.start(ctx.sessionManager.getSessionId());
      const cwd = ctx.cwd;
      const isCurrent = (): boolean => controller.isCurrent(generation);
      const showStash = (stashed: boolean): void => {
        if (!isCurrent()) return;
        try {
          ctx.ui.setWidget(
            "prompt-stash",
            stashed ? ["Prompt stashed - Ctrl+S to restore"] : undefined,
            { placement: "aboveEditor" },
          );
        } catch (error) {
          rethrowUnlessStaleContext(error);
        }
      };
      const state: PromptEditorState = {
        onStashChange: showStash,
        binding: { store, controller, generation },
        suggestion: suggestions.slot,
      };
      showStash(store.get() !== undefined);

      if (fuzzyFileMentionsEnabled(agentDir(), cwd)) {
        const cache = new IgnoreAwareFileCache(cwd);
        activeFileCache = cache;
        const factory: EditorFactory = (tui, theme, keybindings) =>
          decoratePromptEditor(
            new FuzzyMentionEditor(tui, theme, keybindings, { cwd, cache, isCurrent }),
            showStash,
            () => tui.requestRender(),
            state.binding,
            state.suggestion,
          );
        Object.defineProperty(factory, factoryState, { value: state });
        ctx.ui.setEditorComponent(factory);
        return;
      }

      zentuiInstall = { state, isCurrent };
      installPromptEditorWhenReady(ctx.ui, state, isCurrent, installOptions);
    });

    // Pi emits `input` only from AgentSession.prompt(), after extension commands
    // are consumed; built-in commands and `!` bash never reach it. A stashed
    // draft therefore returns only once a real prompt has been accepted.
    pi.on("input", (event, ctx) => {
      suggestions.invalidate();
      if (event.source !== "interactive") return undefined;
      const generation = controller.generation;
      let factory: EditorFactory | undefined;
      try {
        factory = ctx.ui.getEditorComponent();
      } catch (error) {
        rethrowUnlessStaleContext(error);
        return undefined;
      }
      // Restore only into a live editor this controller decorated; otherwise
      // keep the stash (and its widget) rather than write into a detached editor.
      if (!controller.isCurrent(generation)) return undefined;
      if (factoryStateOf(factory)?.binding?.controller !== controller) return undefined;
      controller.restore();
      return undefined;
    });

    // A new run makes any suggestion stale; a settled run may produce the next one.
    pi.on("agent_start", () => {
      suggestions.invalidate();
    });

    // Never await here: Pi defers new prompts until settled handlers return.
    pi.on("agent_settled", (_event, ctx) => {
      void suggestions.settled(ctx);
    });

    // Zentui's /preferences editor toggle installs a fresh, undecorated factory
    // inside a custom dialog; re-decorate it once that dialog closes.
    pi.on("ui_prompt_end", (_event, ctx) => {
      const install = zentuiInstall;
      if (!install?.isCurrent()) return;
      try {
        const factory = ctx.ui.getEditorComponent();
        if (!isZentuiFactory(factory)) return;
        if (factoryStateOf(factory)?.binding?.controller === controller) return;
        installPromptEditorWhenReady(ctx.ui, install.state, install.isCurrent, installOptions);
      } catch (error) {
        rethrowUnlessStaleContext(error);
      }
    });

    pi.on("session_shutdown", () => {
      controller.advance();
      suggestions.stop();
      zentuiInstall = undefined;
      activeFileCache?.invalidate();
      activeFileCache = undefined;
    });
  };
}

export default createPromptEditor();
