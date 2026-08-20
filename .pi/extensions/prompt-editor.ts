import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent } from "@earendil-works/pi-tui";

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
}

interface PromptStash {
  state: EditorState;
  pastes: Map<number, string>;
  pasteCounter: number;
}

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type PromptEditorState = {
  onStashChange: (stashed: boolean) => void;
};

type PromptEditorFactory = EditorFactory & {
  [factoryState]?: PromptEditorState;
  [symbol: symbol]: unknown;
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

type DecoratedEditor = EditorInternals & { [decoratedEditor]?: true };

export function decoratePromptEditor(
  editor: EditorComponent,
  onStashChange: (stashed: boolean) => void,
  requestRender: () => void,
): EditorComponent {
  const target = editor as DecoratedEditor;
  if (target[decoratedEditor]) return editor;

  let stash: PromptStash | undefined;
  const handleInput = editor.handleInput.bind(editor);

  const restoreStash = (): void => {
    if (!stash) return;

    const restored = stash;
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
    stash = undefined;
    onStashChange(false);
    target.onChange?.(target.getText());
    requestRender();
  };

  const stashOrRestore = (): void => {
    if (target.getText().length > 0) {
      const { state, pastes, pasteCounter } = target;
      stash = structuredClone({ state, pastes, pasteCounter });
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

    if (!stash) {
      handleInput(data);
      return;
    }

    const submit = target.onSubmit;
    const restoreAfterSubmit = (text: string): void => {
      try {
        submit?.(text);
      } finally {
        restoreStash();
      }
    };
    target.onSubmit = restoreAfterSubmit;
    try {
      handleInput(data);
    } finally {
      if (target.onSubmit === restoreAfterSubmit) target.onSubmit = submit;
    }
  };

  Object.defineProperty(target, decoratedEditor, { value: true });
  return editor;
}

export function wrapPromptEditorFactory(
  baseFactory: EditorFactory,
  state: PromptEditorState,
): EditorFactory {
  const existing = (baseFactory as PromptEditorFactory)[factoryState];
  if (existing) {
    Object.assign(existing, state);
    return baseFactory;
  }

  const wrappedFactory = ((...args: Parameters<EditorFactory>) => {
    const editor = baseFactory(...args);
    return decoratePromptEditor(editor, state.onStashChange, () => args[0].requestRender());
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
      if (factory && Boolean((factory as PromptEditorFactory)[zentuiEditorFactory])) {
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

export default function promptEditor(pi: ExtensionAPI): void {
  let installGeneration = 0;

  pi.on("session_start", (_event, ctx) => {
    const generation = ++installGeneration;
    if (ctx.mode !== "tui") return;
    const showStash = (stashed: boolean): void => {
      ctx.ui.setWidget(
        "prompt-stash",
        stashed ? ["Prompt stashed - Ctrl+S to restore"] : undefined,
        { placement: "aboveEditor" },
      );
    };
    installPromptEditorWhenReady(
      ctx.ui,
      { onStashChange: showStash },
      () => generation === installGeneration,
    );
  });

  pi.on("session_shutdown", () => {
    installGeneration++;
  });
}
