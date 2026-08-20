import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecord } from "../src/types.ts";
import { continueRunningAgentNavigation, FocusedAgentController } from "../src/ui/focus-mode.ts";
import { installMethodPatch } from "../src/ui/method-patch-registry.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("focus exits on one Esc and restores exact predecessors", async () => {
  const renderRequests: boolean[] = [];
  const listeners = new Set<() => void>();
  const session = {
    messages: [
      { role: "user", content: "inspect the focused task" },
      { role: "assistant", content: [{ type: "text", text: "focused agent answer" }] },
    ],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const record = {
    id: "agent-7",
    type: "implementer",
    handle: "implementer",
    description: "focused work",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactionCount: 0,
    session,
  } as unknown as AgentRecord;

  const orchestratorRender = (_width: number) => ["ORCHESTRATOR CONVERSATION"];
  const document = { render: orchestratorRender };
  const orchestratorSubmits: string[] = [];
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
      if (data === "\r") this.onSubmit?.(this.text);
    },
  };
  const orchestratorInput = editor.handleInput;
  const editorContainer = { children: [editor], render: () => [] as string[] };
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
  const events: Array<{ id: string; message: string }> = [];
  const widgets = new Map<string, unknown>();
  const notifications: string[] = [];
  const controller = new FocusedAgentController(
    {
      steer(id, message) {
        steerCalls.push({ id, message });
        return record.status === "running";
      },
      async resume(id, message) {
        resumeCalls.push({ id, message });
        return record;
      },
    },
    { onSteered: (id, message) => events.push({ id, message }) },
  );
  controller.setUICtx({
    setWidget(key, content) {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, content);
    },
    notify(message) {
      notifications.push(message);
    },
  });

  assert.equal(controller.focus(record, tui as never, theme as never), true);
  assert.deepEqual(controller.getState(), { kind: "agent", agentId: "agent-7" });
  const focusedRender = document.render(100).join("\n");
  assert.match(focusedRender, /focused agent answer/);
  assert.doesNotMatch(focusedRender, /ORCHESTRATOR CONVERSATION/);
  assert.equal(widgets.has("subagent-focus"), true);
  assert.equal(editor.getText(), "");

  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "streamed progress" }],
  });
  for (const listener of listeners) listener();
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

  editor.handleInput("\x1b");
  assert.deepEqual(controller.getState(), { kind: "orchestrator" });
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
