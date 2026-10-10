import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorComponent } from "@earendil-works/pi-tui";
import {
  createPromptEditor,
  createPromptStashController,
  decoratePromptEditor,
  installPromptEditorWhenReady,
  readPromptStash,
  wrapPromptEditorFactory,
  type PromptStash,
  type PromptStashStore,
} from "../.pi/extensions/prompt-editor.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type EditorFixtureInternals = EditorComponent & {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pastes: Map<number, string>;
  pasteCounter: number;
};

function editorFixture(initialText = "draft"): EditorComponent {
  // SAFETY: The fixture supplies every host member exercised by this test.
  const editor = Object.assign(Object.create(Editor.prototype) as EditorComponent, {
    state: { lines: [initialText], cursorLine: 0, cursorCol: initialText.length },
    pastes: new Map<number, string>(),
    pasteCounter: 0,
    undoStack: { clear: () => {} },
    historyIndex: -1,
    historyDraft: null,
    scrollOffset: 0,
    preferredVisualCol: null,
    snappedFromCursorCol: null,
    lastAction: null,
    render() {
      return [this.state.lines.join("\n")];
    },
    invalidate: () => {},
    getText() {
      return this.state.lines.join("\n");
    },
    setText(value: string) {
      this.state = { lines: value.split("\n"), cursorLine: 0, cursorCol: value.length };
    },
    handleInput(this: EditorComponent, data: string) {
      if (data === "\r") this.onSubmit?.(this.getText());
    },
  });
  return editor;
}

function memoryStore(): PromptStashStore & { value: PromptStash | undefined } {
  return {
    value: undefined,
    get() {
      return readPromptStash(this.value);
    },
    set(next) {
      this.value = next;
    },
  };
}

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue;

type Harness = {
  emit(name: string, event: RuntimeValue): RuntimeValue;
  widgets: Array<string[] | undefined>;
  scheduled: Array<() => void>;
  current: EditorFactory | undefined;
  build(requestRender?: () => void): EditorFixtureInternals;
};

function zentuiFactory(text = ""): EditorFactory {
  return Object.assign(
    reinterpretHostValue<EditorFactory>(() => editorFixture(text)),
    { [Symbol.for("pi-zentui.editor-factory")]: true },
  );
}

function startHarness(store: PromptStashStore): Harness {
  const handlers = new Map<string, Handler>();
  const scheduled: Array<() => void> = [];
  const harness: Harness = {
    widgets: [],
    scheduled,
    current: zentuiFactory(),
    emit(name, event) {
      return handlers.get(name)?.(event, ctx);
    },
    build(requestRender = () => {}) {
      const factory = harness.current;
      assert.ok(factory);
      return reinterpretHostValue<EditorFixtureInternals>(
        factory(
          reinterpretHostValue<Parameters<EditorFactory>[0]>({ requestRender }),
          reinterpretHostValue<Parameters<EditorFactory>[1]>(undefined),
          reinterpretHostValue<Parameters<EditorFactory>[2]>(undefined),
        ),
      );
    },
  };
  const ctx = reinterpretHostValue<ExtensionContext>({
    mode: "tui",
    cwd: "/nonexistent/choco-pi-prompt-editor-test",
    ui: {
      setWidget: (_key: string, lines: string[] | undefined) => harness.widgets.push(lines),
      getEditorComponent: () => harness.current,
      setEditorComponent: (factory: EditorFactory | undefined) => {
        harness.current = factory;
      },
    },
  });
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  });
  createPromptEditor({
    store,
    agentDir: () => "/nonexistent/choco-pi-prompt-editor-agent",
    schedule: (callback) => scheduled.push(callback),
  })(pi);
  harness.emit("session_start", { type: "session_start", reason: "startup" });
  return harness;
}

function inputEvent(source: InputEvent["source"]): InputEvent {
  return { type: "input", text: "hello", source };
}

test("prompt stash decorates the Zentui editor without changing Editor identity", () => {
  const editor = editorFixture();
  let stashed = false;
  let renders = 0;
  const decorated = decoratePromptEditor(
    editor,
    (value) => {
      stashed = value;
    },
    () => {
      renders++;
    },
  );

  assert.equal(decorated, editor);
  assert.equal(decorated instanceof Editor, true);
  decorated.handleInput("\x13");
  assert.equal(decorated.getText(), "");
  assert.equal(stashed, true);
  decorated.handleInput("\x13");
  assert.equal(decorated.getText(), "draft");
  assert.equal(stashed, false);
  assert.equal(renders, 1);
});

test("prompt factory preserves Zentui ownership symbols and editor identity", () => {
  const zentuiKey = Symbol.for("pi-zentui.editor-factory");
  const base = reinterpretHostValue<EditorFactory & { [zentuiKey]?: boolean }>(() =>
    editorFixture(),
  );
  base[zentuiKey] = true;
  const wrapped = wrapPromptEditorFactory(base, { onStashChange: () => {} });
  const editor = wrapped(
    // SAFETY: The fixture supplies every host member exercised by this test.
    { requestRender: () => {} } as never,
    // SAFETY: The fixture supplies every host member exercised by this test.
    undefined as never,
    // SAFETY: The fixture supplies every host member exercised by this test.
    undefined as never,
  );

  // SAFETY: The fixture supplies every host member exercised by this test.
  assert.equal((wrapped as typeof base)[zentuiKey], true);
  assert.equal(editor instanceof Editor, true);
});

test("prompt editor installation waits for the standalone Zentui factory", () => {
  const zentuiKey = Symbol.for("pi-zentui.editor-factory");
  const plain = reinterpretHostValue<EditorFactory>(() => editorFixture());
  const zentui = Object.assign(reinterpretHostValue<EditorFactory>(plain.bind(undefined)), {
    [zentuiKey]: true,
  });
  let current = plain;
  const scheduled: Array<() => void> = [];
  installPromptEditorWhenReady(
    {
      getEditorComponent: () => current,
      setEditorComponent: (factory) => {
        current = factory;
      },
    },
    { onStashChange: () => {} },
    () => true,
    {
      schedule: (callback) => scheduled.push(callback),
    },
  );

  scheduled.shift()?.();
  assert.equal(current, plain);
  current = zentui;
  scheduled.shift()?.();
  assert.notEqual(current, zentui);
  // SAFETY: The fixture supplies every host member exercised by this test.
  assert.equal((current as { [zentuiKey]?: boolean })[zentuiKey], true);
});

test("submitting while stashed does not restore the draft", () => {
  const store = memoryStore();
  const editor = decoratePromptEditor(
    editorFixture(),
    () => {},
    () => {},
    {
      store,
      controller: createPromptStashController(),
      generation: 0,
    },
  );
  let submitted: string | undefined;
  editor.onSubmit = (text) => {
    submitted = text;
  };

  editor.handleInput("\x13");
  editor.handleInput("\r");
  assert.equal(submitted, "");
  assert.equal(editor.getText(), "");
  assert.deepEqual(store.get()?.state.lines, ["draft"]);
});

test("an async submit handler leaves the stash intact", () => {
  const store = memoryStore();
  const editor = decoratePromptEditor(
    editorFixture(),
    () => {},
    () => {},
    {
      store,
      controller: createPromptStashController(),
      generation: 0,
    },
  );
  let pending: Promise<void> | undefined;
  editor.onSubmit = () => {
    pending = new Promise<void>(() => {});
    return pending;
  };

  editor.handleInput("\x13");
  editor.handleInput("\r");
  assert.ok(pending);
  assert.equal(editor.getText(), "");
  assert.deepEqual(store.get()?.state.lines, ["draft"]);
});

test("an interactive input event restores lines, cursor, and pastes", () => {
  const store = memoryStore();
  const harness = startHarness(store);
  harness.scheduled.shift()?.();
  let renders = 0;
  const decorated = harness.build(() => {
    renders++;
  });
  decorated.state = { lines: ["first", "[paste #1]"], cursorLine: 1, cursorCol: 3 };
  decorated.pastes = new Map([[1, "pasted body"]]);
  decorated.pasteCounter = 1;
  decorated.handleInput("\x13");
  assert.equal(decorated.getText(), "");
  assert.deepEqual(harness.widgets.at(-1), ["Prompt stashed - Ctrl+S to restore"]);

  assert.equal(harness.emit("input", inputEvent("extension")), undefined);
  assert.equal(decorated.getText(), "");
  assert.notEqual(store.get(), undefined);
  assert.equal(renders, 0);

  assert.equal(harness.emit("input", inputEvent("interactive")), undefined);
  assert.deepEqual(decorated.state, {
    lines: ["first", "[paste #1]"],
    cursorLine: 1,
    cursorCol: 3,
  });
  assert.deepEqual([...decorated.pastes], [[1, "pasted body"]]);
  assert.equal(decorated.pasteCounter, 1);
  assert.equal(store.get(), undefined);
  assert.equal(harness.widgets.at(-1), undefined);
  assert.equal(renders, 1);
});

test("a replacement editor sharing the store sees the stash", () => {
  const store = memoryStore();
  const controller = createPromptStashController();
  const binding = { store, controller, generation: controller.generation };
  const first = decoratePromptEditor(
    editorFixture(),
    () => {},
    () => {},
    binding,
  );
  first.handleInput("\x13");

  const changes: boolean[] = [];
  const second = decoratePromptEditor(
    editorFixture(""),
    (value) => changes.push(value),
    () => {},
    binding,
  );
  assert.deepEqual(changes, [true]);
  second.handleInput("\x13");
  assert.equal(second.getText(), "draft");
  assert.deepEqual(changes, [true, false]);
});

test("session_start re-shows the stash widget when the store holds a draft", () => {
  const store = memoryStore();
  store.set({
    state: { lines: ["kept"], cursorLine: 0, cursorCol: 4 },
    pastes: new Map(),
    pasteCounter: 0,
  });
  const harness = startHarness(store);
  assert.deepEqual(harness.widgets, [["Prompt stashed - Ctrl+S to restore"]]);
  harness.emit("session_shutdown", { type: "session_shutdown" });
});

test("restore is a no-op once the session generation changes", () => {
  const store = memoryStore();
  const controller = createPromptStashController();
  const editor = decoratePromptEditor(
    editorFixture(),
    () => {},
    () => {},
    {
      store,
      controller,
      generation: controller.generation,
    },
  );
  editor.handleInput("\x13");
  controller.advance();
  assert.equal(controller.restore(), false);
  assert.equal(editor.getText(), "");
  assert.notEqual(store.get(), undefined);

  const harness = startHarness(store);
  harness.scheduled.shift()?.();
  const live = harness.build();
  harness.emit("session_shutdown", { type: "session_shutdown" });
  harness.emit("input", inputEvent("interactive"));
  assert.equal(live.getText(), "");
  assert.notEqual(store.get(), undefined);
});

test("closing a dialog re-decorates a fresh Zentui editor factory", () => {
  const store = memoryStore();
  const harness = startHarness(store);
  harness.scheduled.shift()?.();
  const installed = harness.current;
  harness.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" });
  assert.equal(harness.scheduled.length, 0);

  const fresh = zentuiFactory();
  harness.current = fresh;
  harness.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" });
  harness.scheduled.shift()?.();
  assert.notEqual(harness.current, fresh);
  assert.notEqual(harness.current, installed);

  const editor = harness.build();
  editor.setText("draft");
  editor.handleInput("\x13");
  assert.equal(editor.getText(), "");
  assert.notEqual(store.get(), undefined);
  harness.emit("input", inputEvent("interactive"));
  assert.equal(editor.getText(), "draft");
  assert.equal(store.get(), undefined);
});
