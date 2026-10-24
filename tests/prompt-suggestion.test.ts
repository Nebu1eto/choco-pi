import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  stripTerminalSequences,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { createPromptEditor, decoratePromptEditor } from "../.pi/extensions/prompt-editor.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPromptSuggestionController,
  PROMPT_SUGGESTION_FALLBACK_MODEL,
  PROMPT_SUGGESTION_MODEL,
  PROMPT_SUGGESTION_SYSTEM_PROMPT,
  promptSuggestionSystemPrompt,
  renderGhostSuggestion,
  sanitizePromptSuggestion,
  suggestionTranscript,
  type PromptSuggestionGenerator,
  type PromptSuggestionSlot,
} from "../.pi/extensions/lib/prompt-suggestion.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const TAB = "\t";

function realEditor(): Editor {
  const tui = reinterpretHostValue<TUI>({ terminal: { rows: 40 }, requestRender: () => {} });
  const editor = new Editor(tui, {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  });
  editor.focused = true;
  return editor;
}

function suggestingEditor(text: string | undefined) {
  const slot: PromptSuggestionSlot = { text, requestRender: undefined };
  let renders = 0;
  const editor = realEditor();
  decoratePromptEditor(
    editor,
    () => {},
    () => {
      renders += 1;
    },
    undefined,
    slot,
  );
  return {
    editor,
    slot,
    get renders() {
      return renders;
    },
  };
}

function strip(line: string): string {
  return stripTerminalSequences(line.replace(CURSOR_MARKER, ""));
}

test("ghost text fills the empty editor's padding without changing line widths", () => {
  const { editor } = suggestingEditor("run the tests");
  const base = realEditor().render(40);
  const lines = editor.render(40);
  assert.equal(lines.length, base.length);
  assert.deepEqual(
    lines.map((line) => visibleWidth(line)),
    base.map((line) => visibleWidth(line)),
  );
  const cursorLine = lines.find((line) => line.includes(CURSOR_MARKER));
  assert.ok(cursorLine);
  assert.match(strip(cursorLine), /^ run the tests\s+$/u);
  assert.ok(cursorLine.includes("\x1b[2mrun the tests\x1b[22m"));
});

test("wide-character ghost text is truncated to the available columns", () => {
  const { editor } = suggestingEditor(
    "테스트를 실행하고 결과를 요약해 주세요 그리고 커밋까지 진행해 주세요",
  );
  const base = realEditor().render(20);
  const lines = editor.render(20);
  assert.deepEqual(
    lines.map((line) => visibleWidth(line)),
    base.map((line) => visibleWidth(line)),
  );
  const cursorLine = lines.find((line) => line.includes(CURSOR_MARKER));
  assert.ok(cursorLine?.includes("…"));
});

test("Tab accepts the suggestion into an empty editor and consumes it", () => {
  const harness = suggestingEditor("run the tests");
  harness.editor.handleInput(TAB);
  assert.equal(harness.editor.getText(), "run the tests");
  assert.equal(harness.slot.text, undefined);
  assert.equal(harness.renders, 1);
  const cursorLine = harness.editor.render(40).find((line) => line.includes(CURSOR_MARKER));
  assert.ok(cursorLine && !cursorLine.includes("\x1b[2m"));
});

test("typed text hides the ghost and Tab keeps its normal behavior", () => {
  const harness = suggestingEditor("run the tests");
  harness.editor.handleInput("x");
  assert.ok(harness.editor.render(40).every((line) => !line.includes("\x1b[2m")));
  harness.editor.handleInput(TAB);
  assert.equal(harness.editor.getText().startsWith("x"), true);
  assert.equal(harness.slot.text, "run the tests");
});

test("an editor without a suggestion renders unchanged", () => {
  const { editor } = suggestingEditor(undefined);
  assert.deepEqual(editor.render(40), realEditor().render(40));
});

test("ghost rendering leaves lines without a focused end-of-line cursor untouched", () => {
  const lines = ["plain", "\x1b[7mx\x1b[0m   "];
  assert.deepEqual(renderGhostSuggestion(lines, "next"), lines);
});

test("sanitizing keeps one clean line and rejects NONE or overlong output", () => {
  assert.equal(sanitizePromptSuggestion('\n  "Run the tests."  \nmore'), "Run the tests.");
  assert.equal(sanitizePromptSuggestion("User: 커밋해 줘"), "커밋해 줘");
  assert.equal(sanitizePromptSuggestion("NONE"), undefined);
  assert.equal(sanitizePromptSuggestion("none."), undefined);
  assert.equal(sanitizePromptSuggestion("x".repeat(301)), undefined);
  assert.equal(sanitizePromptSuggestion("Should I add a unit test?"), undefined);
  assert.equal(sanitizePromptSuggestion("Do you want me to commit?"), undefined);
  assert.equal(sanitizePromptSuggestion("Yes, add a unit test"), "Yes, add a unit test");
});

type Entry = {
  type: string;
  message: { role: string; content: Array<{ type: string; text: string }>; stopReason?: string };
};

function message(role: "user" | "assistant", text: string, stopReason = "stop"): Entry {
  const entry: Entry = { type: "message", message: { role, content: [{ type: "text", text }] } };
  if (role === "assistant") entry.message.stopReason = stopReason;
  return entry;
}

function entries(list: Entry[]): Parameters<typeof suggestionTranscript>[0] {
  return reinterpretHostValue<Parameters<typeof suggestionTranscript>[0]>(list);
}

test("transcripts require a completed final reply and include user turns", () => {
  const done = suggestionTranscript(
    entries([message("user", "Fix the bug"), message("assistant", "Fixed. Run tests?")]),
  );
  assert.equal(done, "USER:\nFix the bug\n\nAGENT:\nFixed. Run tests?");
  assert.equal(
    suggestionTranscript(
      entries([message("user", "Fix"), message("assistant", "partial", "aborted")]),
    ),
    undefined,
  );
  assert.equal(suggestionTranscript(entries([message("assistant", "hello")])), undefined);
});

function settleHarness(
  options: {
    enabled?: boolean;
    editorText?: string;
    language?: string;
    pending?: boolean;
    branch?: Entry[];
  } = {},
) {
  let sessionId = "session-a";
  const branch = entries(
    options.branch ?? [message("user", "Fix the bug"), message("assistant", "Fixed.")],
  );
  const ctx = reinterpretHostValue<ExtensionContext>({
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: { getEditorText: () => options.editorText ?? "" },
    hasPendingMessages: () => options.pending ?? false,
  });
  return {
    ctx,
    switchSession(next: string) {
      sessionId = next;
    },
    readPreferences: async () => ({ enabled: options.enabled ?? true, language: options.language }),
  };
}

test("a settled run fills the slot, falling back when the primary model fails", async () => {
  const calls: string[] = [];
  const generate: PromptSuggestionGenerator = async ({ modelName }) => {
    calls.push(modelName);
    if (modelName === PROMPT_SUGGESTION_MODEL) throw new Error("unavailable");
    return "Run the tests";
  };
  const harness = settleHarness();
  const controller = createPromptSuggestionController({
    generate,
    readPreferences: harness.readPreferences,
  });
  let renders = 0;
  controller.slot.requestRender = () => {
    renders += 1;
  };
  controller.start("session-a");
  await controller.settled(harness.ctx);
  assert.deepEqual(calls, [PROMPT_SUGGESTION_MODEL, PROMPT_SUGGESTION_FALLBACK_MODEL]);
  assert.equal(controller.slot.text, "Run the tests");
  assert.equal(renders, 1);

  controller.invalidate();
  assert.equal(controller.slot.text, undefined);
  assert.equal(renders, 2);
});

test("disabled preference, a typed draft, or another session skips the request", async () => {
  const calls: string[] = [];
  const generate: PromptSuggestionGenerator = async ({ modelName }) => {
    calls.push(modelName);
    return "unused";
  };
  for (const harness of [settleHarness({ enabled: false }), settleHarness({ editorText: "dra" })]) {
    const controller = createPromptSuggestionController({
      generate,
      readPreferences: harness.readPreferences,
    });
    controller.start("session-a");
    await controller.settled(harness.ctx);
    assert.equal(controller.slot.text, undefined);
  }
  const other = settleHarness();
  const controller = createPromptSuggestionController({
    generate,
    readPreferences: other.readPreferences,
  });
  controller.start("session-b");
  await controller.settled(other.ctx);
  assert.deepEqual(calls, []);
  assert.equal(controller.slot.text, undefined);
});

test("a result arriving after the next run starts is discarded", async () => {
  let release: (value: string) => void = () => {};
  let observedSignal: AbortSignal | undefined;
  const generate: PromptSuggestionGenerator = ({ signal }) => {
    observedSignal = signal;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const harness = settleHarness();
  const controller = createPromptSuggestionController({
    generate,
    readPreferences: harness.readPreferences,
  });
  controller.start("session-a");
  const pending = controller.settled(harness.ctx);
  await new Promise<RuntimeValue>((resolve) => setImmediate(resolve));
  controller.invalidate();
  assert.equal(observedSignal?.aborted, true);
  release("stale");
  await pending;
  assert.equal(controller.slot.text, undefined);
});

test("the agent_settled handler returns without waiting for the model", async () => {
  let started = false;
  const generate: PromptSuggestionGenerator = () => {
    started = true;
    return new Promise<string>(() => {});
  };
  const harness = settleHarness();
  const suggestions = createPromptSuggestionController({
    generate,
    readPreferences: harness.readPreferences,
  });
  const handlers = new Map<string, (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue>();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (name: string, handler: (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue) =>
      handlers.set(name, handler),
  });
  createPromptEditor({ suggestions })(pi);
  suggestions.start("session-a");
  const returned = handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);
  assert.equal(returned, undefined);
  await new Promise<RuntimeValue>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  suggestions.stop();
});

async function settleOnce(
  harness: ReturnType<typeof settleHarness>,
  generate: PromptSuggestionGenerator,
): Promise<string | undefined> {
  const controller = createPromptSuggestionController({
    generate,
    readPreferences: harness.readPreferences,
  });
  controller.start("session-a");
  await controller.settled(harness.ctx);
  return controller.slot.text;
}

test("a suggestion in a script the user and preference never use is dropped", async () => {
  const korean = [message("user", "버그 고쳐 줘"), message("assistant", "Fixed. Add a test?")];
  const shown = async (suggestion: string, language?: string) =>
    settleOnce(settleHarness({ branch: korean, language }), async () => suggestion);
  assert.equal(await shown("네, 테스트 추가해 줘", "English"), "네, 테스트 추가해 줘");
  assert.equal(
    await shown("Yes, add tests in prompt-suggestion.test.ts", "English"),
    "Yes, add tests in prompt-suggestion.test.ts",
  );
  assert.equal(await shown("はい、テストを追加して", "English"), undefined);
  assert.equal(await shown("好的，添加测试", "English"), undefined);
  assert.equal(await shown("Да, добавь тест", "English"), undefined);
  assert.equal(await shown("はい、テストを追加して", "Japanese"), "はい、テストを追加して");
  assert.equal(await shown("Да, добавь тест", "Русский"), "Да, добавь тест");
});

test("the preferred language reaches the request and its system prompt", async () => {
  let seen: string | undefined;
  await settleOnce(settleHarness({ language: "Korean" }), async ({ language }) => {
    seen = language;
    return undefined;
  });
  assert.equal(seen, "Korean");
  assert.ok(promptSuggestionSystemPrompt("Korean").includes("Preferred response language: Korean"));
  assert.equal(promptSuggestionSystemPrompt(undefined), PROMPT_SUGGESTION_SYSTEM_PROMPT);
});

type GlobalSlots = { [slot: symbol]: RuntimeValue };

async function withGlobalSlot<T>(
  key: string,
  value: RuntimeValue,
  run: () => Promise<T>,
): Promise<T> {
  const slots = reinterpretHostValue<GlobalSlots>(globalThis);
  const symbol = Symbol.for(key);
  const previous = slots[symbol];
  slots[symbol] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, symbol);
    else slots[symbol] = previous;
  }
}

test("no suggestion is requested while the agent will resume on its own", async () => {
  const calls: string[] = [];
  const generate: PromptSuggestionGenerator = async ({ modelName }) => {
    calls.push(modelName);
    return "Run the tests";
  };
  assert.equal(await settleOnce(settleHarness({ pending: true }), generate), undefined);

  const goal = (status: string) =>
    new Map([
      ["session-a", { owner: "session-a", getGoal: () => ({ status }), completeGoal: () => ({}) }],
    ]);
  assert.equal(
    await withGlobalSlot("choco-pi-goal:runtime", goal("active"), () =>
      settleOnce(settleHarness(), generate),
    ),
    undefined,
  );
  assert.equal(
    await withGlobalSlot("pi-subagents:manager", { hasRunning: () => true }, () =>
      settleOnce(settleHarness(), generate),
    ),
    undefined,
  );
  const shellManager = {
    list: () => ({
      shells: [
        {
          shellId: "s1",
          ownerId: "session-a",
          command: "sleep 9",
          cwd: "/",
          state: "running",
          startedAt: 1,
        },
      ],
    }),
    read: () => ({}),
    stop: () => ({}),
    toolCallIdOf: () => null,
  };
  assert.equal(
    await withGlobalSlot("choco-pi-shells:manager", shellManager, () =>
      settleOnce(settleHarness(), generate),
    ),
    undefined,
  );
  assert.deepEqual(calls, []);

  assert.equal(
    await withGlobalSlot("choco-pi-goal:runtime", goal("paused"), () =>
      settleOnce(settleHarness(), generate),
    ),
    "Run the tests",
  );
});
