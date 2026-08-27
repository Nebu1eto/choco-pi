import assert from "node:assert/strict";
import test from "node:test";
import type {
  Api,
  AssistantMessage,
  Model,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../src/types.ts";
import { continueRunningAgentNavigation, FocusedAgentController } from "../src/ui/focus-mode.ts";
import {
  FOCUSED_AGENT_RUNTIME_SYMBOL,
  type FocusedAgentRuntimeSource,
} from "../src/ui/focused-runtime.ts";
import { installMethodPatch } from "../src/ui/method-patch-registry.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

type TestContextUsage = {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
};

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the named slice exercised by its subject.
  return fixture as T;
}

interface FocusedAgentRuntimeRegistry {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: FocusedAgentRuntimeSource;
}

function currentFocusedRuntime() {
  // SAFETY: The publisher and this fixture share the exported symbol and source type.
  const registry = globalThis as typeof globalThis & FocusedAgentRuntimeRegistry;
  return registry[FOCUSED_AGENT_RUNTIME_SYMBOL]?.current();
}

function makeUserMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolMessage(id: string, output: string): [AssistantMessage, ToolResultMessage] {
  return [
    {
      ...makeAssistantMessage(""),
      content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: output }],
      isError: false,
      timestamp: Date.now(),
    },
  ];
}

test("focus survives Esc and restores exact predecessors on exit", async (t) => {
  const renderRequests: boolean[] = [];
  const listeners = new Set<AgentSessionEventListener>();
  const childEfforts: string[] = [];
  const childFastActions: string[] = [];
  const selectedModels: Model<Api>[] = [];
  let sessionCost = 2.5;
  let sessionContext: TestContextUsage = {
    percent: 12.5,
    contextWindow: 200_000,
    tokens: null,
  };
  const session = partialFixture<AgentSession>({
    sessionId: "focused-session",
    model: partialFixture<Model<Api>>({
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      provider: "openai-codex",
    }),
    thinkingLevel: "medium",
    getSessionStats: () =>
      partialFixture<ReturnType<AgentSession["getSessionStats"]>>({
        sessionId: "focused-session",
        cost: sessionCost,
        contextUsage: sessionContext,
      }),
    messages: [
      makeUserMessage("inspect the focused task"),
      makeAssistantMessage("focused agent answer"),
    ],
    subscribe(listener: AgentSessionEventListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async setModel(model: Model<Api>) {
      selectedModels.push(model);
    },
    setThinkingLevel(level) {
      childEfforts.push(level);
    },
  });
  const controlsSymbol = Symbol.for("choco-pi.model-controls.focused-sessions");
  // SAFETY: The fixture declares only the private Symbol.for slot consumed by focus mode.
  const controlsHost = globalThis as typeof globalThis & {
    [controlsSymbol]?: Map<string, { setFast(action: string): string }>;
  };
  controlsHost[controlsSymbol] = new Map([
    [
      session.sessionId,
      {
        setFast(action) {
          childFastActions.push(action);
          return `Fast mode: ${action}`;
        },
      },
    ],
  ]);
  t.after(() => delete controlsHost[controlsSymbol]);
  const record = partialFixture<AgentRecord>({
    id: "agent-7",
    type: "implementer",
    handle: "implementer",
    description: "focused work",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    session,
  });

  const orchestratorRender = (_width: number) => ["ORCHESTRATOR CONVERSATION"];
  const mermaidTransformer = (markdown: string) =>
    markdown.replace("focused agent answer", "MERMAID RENDERED");
  const document = {
    render: orchestratorRender,
    children: [{ markdownTransformers: [mermaidTransformer] }],
  };
  const orchestratorSubmits: string[] = [];
  const orchestratorInputs: string[] = [];
  const editor = {
    text: "orchestrator draft",
    onSubmit(text: string) {
      orchestratorSubmits.push(text);
    },
    getText() {
      return this.text;
    },
    setText(text: string) {
      this.text = text;
    },
    addToHistory(_text: string) {},
    handleInput(data: string) {
      orchestratorInputs.push(data);
      if (data === "\r") this.onSubmit?.(this.text);
    },
  };
  const orchestratorInput = editor.handleInput;
  const editorContainer = { children: [editor], render: (): string[] => [] };
  const tui = {
    children: [document, editorContainer],
    terminal: { columns: 100, rows: 40 },
    getFocusedComponent: () => editor,
    requestRender(force?: boolean) {
      renderRequests.push(force === true);
    },
  };

  const steerCalls: Array<{ id: string; message: string }> = [];
  const resumeCalls: Array<{ id: string; message: string }> = [];
  const abortCalls: string[] = [];
  const events: Array<{ id: string; message: string }> = [];
  const widgets = new Map<string, unknown>();
  const notifications: string[] = [];
  let switcherUp = true;
  const controller = new FocusedAgentController(
    {
      steer(id, message) {
        steerCalls.push({ id, message });
        return record.status === "running";
      },
      abort(id) {
        abortCalls.push(id);
        record.status = "aborted";
        return true;
      },
      async resume(id, message) {
        resumeCalls.push({ id, message });
        return record;
      },
    },
    {
      onSteered: (id, message) => events.push({ id, message }),
      hasSwitcher: () => switcherUp,
      resolveModel: () =>
        partialFixture<Model<Api>>({
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai-codex",
        }),
    },
  );
  t.after(() => controller.dispose());
  controller.setUICtx({
    setWidget(key, content) {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, content);
    },
    notify(message) {
      notifications.push(message);
    },
  });

  // SAFETY: The focus controller uses only the TUI and theme methods implemented by these fixtures.
  assert.equal(controller.focus(record, tui as never, theme as never), true);
  assert.deepEqual(currentFocusedRuntime(), {
    modelId: "gpt-5.6-terra",
    modelName: "GPT-5.6 Terra",
    provider: "openai-codex",
    thinking: "medium",
    costTotal: 2.5,
    contextPercent: 12.5,
    contextWindow: 200_000,
  });
  sessionCost = 3.75;
  sessionContext = { percent: null, contextWindow: 200_000, tokens: null };
  assert.deepEqual(currentFocusedRuntime(), {
    modelId: "gpt-5.6-terra",
    modelName: "GPT-5.6 Terra",
    provider: "openai-codex",
    thinking: "medium",
    costTotal: 3.75,
    contextPercent: null,
    contextWindow: 200_000,
  });
  record.session = partialFixture<AgentSession>({
    model: partialFixture<Model<Api>>({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      provider: "anthropic",
    }),
    thinkingLevel: "high",
    getSessionStats: () =>
      partialFixture<ReturnType<AgentSession["getSessionStats"]>>({
        sessionId: "replacement-session",
        cost: 0.75,
        contextUsage: { percent: 1, contextWindow: 300_000, tokens: 3_000 },
      }),
  });
  assert.deepEqual(currentFocusedRuntime(), {
    modelId: "claude-fable-5",
    modelName: "Claude Fable 5",
    provider: "anthropic",
    thinking: "high",
    costTotal: 0.75,
    contextPercent: 1,
    contextWindow: 300_000,
  });
  record.session = partialFixture<AgentSession>({
    model: partialFixture<Model<Api>>({
      id: "claude-opus-5",
      name: "Claude Opus 5",
      provider: "anthropic",
      contextWindow: 524_288,
    }),
    thinkingLevel: "xhigh",
    getSessionStats() {
      throw new Error("stats unavailable");
    },
  });
  assert.deepEqual(currentFocusedRuntime(), {
    modelId: "claude-opus-5",
    modelName: "Claude Opus 5",
    provider: "anthropic",
    thinking: "xhigh",
    costTotal: null,
    contextPercent: null,
    contextWindow: 524_288,
  });
  record.session = undefined;
  assert.equal(
    currentFocusedRuntime(),
    undefined,
    "publisher never falls back to the initial session",
  );
  record.session = session;
  assert.deepEqual(controller.getState(), { kind: "agent", agentId: "agent-7" });
  const focusedRender = document.render(100).join("\n");
  assert.match(focusedRender, /MERMAID RENDERED/);
  assert.doesNotMatch(focusedRender, /ORCHESTRATOR CONVERSATION/);
  assert.equal(widgets.has("subagent-focus"), true);
  // With the FleetView switcher up, the above-editor indicator stays silent —
  // it would only repeat the switcher. It speaks when the switcher is off.
  const indicator = widgets.get("subagent-focus");
  const renderIndicator = (): string[] => {
    if (!(indicator instanceof Function)) return [];
    // SAFETY: setWidget stores the factory this test registered above.
    const widget = indicator(tui as never, theme as never) as { render(width: number): string[] };
    return widget.render(100);
  };
  assert.deepEqual(renderIndicator(), []);
  assert.equal(editor.getText(), "");

  for (const command of ["/model openai-codex/gpt-5.6-luna", "/effort high", "/fast on"]) {
    editor.setText(command);
    editor.handleInput("\r");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectedModels[0]?.id, "gpt-5.6-luna");
  assert.deepEqual(childEfforts, ["high"]);
  assert.deepEqual(childFastActions, ["on"]);
  assert.deepEqual(orchestratorSubmits, [], "focused commands never reach the main command router");
  assert.deepEqual(steerCalls, [], "focused commands are not sent to the model as steering text");

  session.messages.push(makeAssistantMessage("streamed progress"));
  for (const listener of listeners) listener({ type: "agent_settled" });
  assert.match(document.render(100).join("\n"), /streamed progress/);
  assert.equal(renderRequests.length > 0, true);

  editor.setText("change direction");
  editor.handleInput("\r");
  assert.deepEqual(steerCalls, [{ id: "agent-7", message: "change direction" }]);
  assert.deepEqual(events, [{ id: "agent-7", message: "change direction" }]);
  assert.deepEqual(orchestratorSubmits, []);
  assert.equal(editor.getText(), "");

  record.status = "completed";
  editor.setText("follow up");
  editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(orchestratorSubmits, []);
  assert.equal(editor.getText(), "");
  assert.deepEqual(resumeCalls, [{ id: "agent-7", message: "follow up" }]);
  assert.match(notifications.at(-1) ?? "", /Resuming/);

  // A session-less completed record cannot be resumed; the draft is restored.
  const realSession = record.session;
  record.session = undefined;
  editor.setText("must not reach main");
  editor.handleInput("\r");
  assert.equal(editor.getText(), "must not reach main");
  assert.equal(resumeCalls.length, 1, "no second resume for a session-less record");
  assert.match(notifications.at(-1) ?? "", /cannot be steered/);
  record.session = realSession;

  // Esc no longer leaves focus — the FleetView switcher owns that transition —
  // and it must not reach the orchestrator editor either.
  editor.setText("still focused");
  editor.handleInput("\x1b");
  assert.deepEqual(controller.getState(), { kind: "agent", agentId: "agent-7" });
  assert.equal(controller.getFocusedAgentId(), "agent-7");
  assert.equal(editor.getText(), "still focused");
  assert.equal(orchestratorInputs.includes("\x1b"), false, "Esc is swallowed while focused");
  editor.setText("");

  // With no switcher rendered, Esc stays the escape hatch.
  switcherUp = false;
  assert.match(renderIndicator()[0] ?? "", /Esc returns to main/);
  editor.handleInput("\x1b");
  assert.deepEqual(controller.getState(), { kind: "orchestrator" });
  assert.equal(currentFocusedRuntime(), undefined, "unfocus clears the shared runtime");
  assert.equal(controller.getFocusedAgentId(), undefined);
  assert.equal(document.render, orchestratorRender);
  assert.equal(editor.handleInput, orchestratorInput);
  assert.equal(editor.getText(), "orchestrator draft");
  assert.deepEqual(document.render(100), ["ORCHESTRATOR CONVERSATION"]);
  assert.equal(widgets.has("subagent-focus"), false);
  assert.equal(listeners.size, 0);

  editor.setText("back on main");
  editor.handleInput("\r");
  assert.deepEqual(orchestratorSubmits, ["back on main"]);
  assert.equal(renderRequests.includes(true), true);

  // SAFETY: The controller uses only the TUI and theme members these fixtures implement.
  assert.equal(controller.focus(record, tui as never, theme as never), true);
  assert.notEqual(currentFocusedRuntime(), undefined);
  controller.dispose();
  assert.equal(currentFocusedRuntime(), undefined, "dispose clears the shared runtime");
});

test("/exit at a focused prompt stops the agent instead of quitting pi", () => {
  const record = partialFixture<AgentRecord>({
    id: "agent-9",
    type: "implementer",
    handle: "implementer",
    description: "focused work",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    session: partialFixture<AgentSession>({
      messages: [],
      subscribe: () => () => {},
    }),
  });
  const orchestratorInputs: string[] = [];
  const editor = {
    text: "",
    onSubmit(_text: string) {},
    getText() {
      return this.text;
    },
    setText(text: string) {
      this.text = text;
    },
    addToHistory(_text: string) {},
    handleInput(data: string) {
      orchestratorInputs.push(data);
    },
  };
  const document = { render: (_width: number) => ["ORCHESTRATOR"] };
  const tui = {
    children: [document, { children: [editor], render: (): string[] => [] }],
    terminal: { columns: 100, rows: 40 },
    getFocusedComponent: () => editor,
    requestRender() {},
  };
  const aborted: string[] = [];
  const notifications: string[] = [];
  const controller = new FocusedAgentController(
    {
      steer: () => true,
      abort(id) {
        aborted.push(id);
        return true;
      },
      async resume() {
        return undefined;
      },
    },
    { hasSwitcher: () => true },
  );
  controller.setUICtx({
    setWidget() {},
    notify(message) {
      notifications.push(message);
    },
  });

  // SAFETY: The controller uses only the TUI and theme members these fixtures implement.
  assert.equal(controller.focus(record, tui as never, theme as never), true);
  editor.setText("/exit");
  editor.handleInput("\r");

  assert.deepEqual(aborted, ["agent-9"], "/exit stops the focused agent");
  assert.deepEqual(controller.getState(), { kind: "orchestrator" }, "and leaves focus");
  assert.equal(orchestratorInputs.includes("\r"), false, "pi never sees the command");
  assert.match(notifications.at(-1) ?? "", /Stopped @implementer/);
});

test("focus switch isolates expansion, dequeue, pending UI, subscriptions, and input ownership", (t) => {
  const originalKeybindings = getKeybindings();
  const focusedKey = "\x05"; // ctrl+e, configured below instead of relying on Ctrl+O.
  const dequeueKey = "\x04"; // ctrl+d, configured below instead of relying on the host default.
  setKeybindings(
    new KeybindingsManager(
      {
        ...TUI_KEYBINDINGS,
        "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
        "app.message.dequeue": { defaultKeys: "alt+down", description: "Dequeue message" },
      },
      { "app.tools.expand": "ctrl+e", "app.message.dequeue": "ctrl+d" },
    ),
  );
  t.after(() => setKeybindings(originalKeybindings));

  const longOutput = (prefix: string) =>
    Array.from(
      { length: 30 },
      (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
    ).join("\n");
  const makeFocusedSession = (id: string) => {
    const listeners = new Set<AgentSessionEventListener>();
    const steering = [`${id} steering`];
    const followUp = [`${id} follow-up`];
    const messages: AgentSession["messages"] = [
      makeUserMessage(`${id} task`),
      ...makeToolMessage(`${id}-tool`, longOutput(`${id}-tool`)),
    ];
    const session = partialFixture<AgentSession>({
      thinkingLevel: "medium",
      messages,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSteeringMessages: () => steering,
      getFollowUpMessages: () => followUp,
      getToolDefinition: () => undefined,
      sessionManager: partialFixture<AgentSession["sessionManager"]>({
        getCwd: () => "/project",
      }),
    });
    return {
      session,
      listeners,
      fire: () => {
        for (const listener of listeners) listener({ type: "agent_settled" });
      },
    };
  };

  const a = makeFocusedSession("A");
  const b = makeFocusedSession("B");
  const makeRecord = (id: string, session: AgentSession) =>
    partialFixture<AgentRecord>({
      id,
      type: "implementer",
      handle: id.toLowerCase(),
      description: `${id} focused work`,
      status: "running",
      toolUses: 1,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      session,
    });
  const recordA = makeRecord("A", a.session);
  const recordB = makeRecord("B", b.session);
  const records = new Map([
    [recordA.id, recordA],
    [recordB.id, recordB],
  ]);

  const orchestratorRender = (_width: number) => ["MAIN TRANSCRIPT"];
  const document = { render: orchestratorRender };
  const orchestratorPendingRender = (_width: number) => ["MAIN STEERING"];
  const pendingMessages = { render: orchestratorPendingRender };
  const mainSubmits: string[] = [];
  const focusedSteers: Array<{ id: string; message: string }> = [];
  const mainPendingQueue = ["MAIN QUEUED"];
  let mainExpanded = false;
  let mainExpandActions = 0;
  let mainDequeueActions = 0;
  const editor = {
    text: "main draft",
    onSubmit(text: string) {
      mainSubmits.push(text);
    },
    getText() {
      return this.text;
    },
    setText(text: string) {
      this.text = text;
    },
    addToHistory(_text: string) {},
    handleInput(data: string) {
      if (data === focusedKey) {
        mainExpanded = !mainExpanded;
        mainExpandActions += 1;
      }
      if (data === dequeueKey) {
        mainDequeueActions += 1;
        this.text = mainPendingQueue.shift() ?? this.text;
      }
      if (data === "\r") this.onSubmit?.(this.text);
    },
  };
  const orchestratorInput = editor.handleInput;
  const editorContainer = { children: [editor], render: (): string[] => [] };
  const tui = {
    children: [document, pendingMessages, editorContainer],
    terminal: { columns: 120, rows: 40 },
    getFocusedComponent: () => editor,
    requestRender() {},
  };
  const controller = new FocusedAgentController(
    {
      steer(id, message) {
        focusedSteers.push({ id, message });
        return records.get(id)?.status === "running";
      },
      abort: () => true,
      async resume() {
        return undefined;
      },
    },
    { hasSwitcher: () => true },
  );
  t.after(() => controller.dispose());
  controller.setUICtx({ setWidget() {}, notify() {} });
  const renderDocument = () =>
    document
      .render(120)
      .map((line) => stripTerminalSequences(line))
      .join("\n");
  const renderPending = () =>
    pendingMessages
      .render(120)
      .map((line) => stripTerminalSequences(line))
      .join("\n");

  // SAFETY: The focus controller uses only TUI/theme members implemented by these fixtures.
  assert.equal(controller.focus(recordA, tui as never, theme as never), true);
  assert.equal(a.listeners.size, 1);
  assert.equal(renderPending().includes("MAIN STEERING"), false);
  assert.match(renderPending(), /A steering/);
  assert.match(renderPending(), /A follow-up/);
  assert.doesNotMatch(renderPending(), /B steering/);
  assert.doesNotMatch(renderDocument(), /A-tool-30/);

  editor.handleInput(focusedKey);
  assert.equal(mainExpandActions, 0, "focused expand never invokes the main action");
  assert.equal(mainExpanded, false, "focused expand never mutates main state");
  assert.match(renderDocument(), /A-tool-30/);

  editor.handleInput(dequeueKey);
  assert.equal(mainDequeueActions, 0, "focused dequeue never invokes the main action");
  assert.deepEqual(mainPendingQueue, ["MAIN QUEUED"], "hidden main queue stays unchanged");
  assert.equal(editor.getText(), "", "hidden main message never enters the focused editor");

  // SAFETY: The focus controller uses only TUI/theme members implemented by these fixtures.
  assert.equal(controller.focus(recordB, tui as never, theme as never), true);
  assert.equal(a.listeners.size, 0, "A subscription is synchronously disposed");
  assert.equal(b.listeners.size, 1);
  assert.match(renderDocument(), /B task/);
  assert.doesNotMatch(renderDocument(), /A task/);
  assert.doesNotMatch(renderDocument(), /B-tool-30/, "B starts independently collapsed");
  assert.match(renderPending(), /B steering/);
  assert.doesNotMatch(renderPending(), /A steering|MAIN STEERING/);

  editor.setText("message after switch");
  editor.handleInput("\r");
  assert.deepEqual(focusedSteers, [{ id: "B", message: "message after switch" }]);
  assert.deepEqual(mainSubmits, []);

  // SAFETY: The focus controller uses only TUI/theme members implemented by these fixtures.
  assert.equal(controller.focus(recordA, tui as never, theme as never), true);
  assert.equal(b.listeners.size, 0, "B subscription is synchronously disposed");
  assert.equal(a.listeners.size, 1);
  assert.match(renderDocument(), /A-tool-30/, "returning to A restores A expansion");
  const [newToolCall, newToolResult] = makeToolMessage("A-new-tool", longOutput("A-new"));
  a.session.messages.push(newToolCall, newToolResult);
  a.fire();
  assert.match(renderDocument(), /A-new-30/, "new tool output honors A expansion state");

  controller.unfocus();
  assert.equal(a.listeners.size, 0);
  assert.equal(document.render, orchestratorRender);
  assert.equal(pendingMessages.render, orchestratorPendingRender);
  assert.equal(editor.handleInput, orchestratorInput);
  assert.deepEqual(document.render(120), ["MAIN TRANSCRIPT"]);
  assert.deepEqual(pendingMessages.render(120), ["MAIN STEERING"]);
  assert.equal(editor.getText(), "main draft");

  editor.handleInput(focusedKey);
  assert.equal(mainExpandActions, 1, "the next expand action belongs to main again");
  assert.equal(mainExpanded, true);
  editor.handleInput(dequeueKey);
  assert.equal(mainDequeueActions, 1, "the next dequeue action belongs to main again");
  assert.deepEqual(mainPendingQueue, []);
  assert.equal(editor.getText(), "MAIN QUEUED");
  editor.setText("main submit restored");
  editor.handleInput("\r");
  assert.deepEqual(mainSubmits, ["main submit restored"]);
});

test("focused running-agent navigation does not reopen a key-consuming selector", async () => {
  let reopenCalls = 0;
  const focused = await continueRunningAgentNavigation(true, async () => {
    reopenCalls += 1;
    return false;
  });

  assert.equal(focused, true);
  assert.equal(reopenCalls, 0);

  const propagated = await continueRunningAgentNavigation(false, async () => {
    reopenCalls += 1;
    return true;
  });
  assert.equal(propagated, true, "a nested focus request propagates to the parent menu");
  assert.equal(reopenCalls, 1);
});

test("patch cleanup leaves a newer extension wrapper installed", () => {
  const target = { render: () => ["main"] };
  const cleanup = installMethodPatch(target, "render", "focused-conversation-render", () => [
    "focused",
  ]);
  const focusedWrapper = target.render;
  const newerWrapper = () => ["newer", ...focusedWrapper()];
  target.render = newerWrapper;

  cleanup();

  assert.equal(target.render, newerWrapper);
  assert.deepEqual(target.render(), ["newer", "main"]);
});
