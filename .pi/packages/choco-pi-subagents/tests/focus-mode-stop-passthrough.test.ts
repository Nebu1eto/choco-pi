import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../src/types.ts";
import { FocusedAgentController } from "../src/ui/focus-mode.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Fixtures provide only the members the focus controller reads.
  return fixture as T;
}

function setup() {
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
    session: partialFixture<AgentSession>({ messages: [], subscribe: () => () => {} }),
  });
  const hostSubmits: string[] = [];
  const steered: string[] = [];
  const aborted: string[] = [];
  const editor = {
    text: "",
    // The host's own submit path. The predecessor handleInput below invokes whatever
    // onSubmit is installed at that moment, like Pi's Editor does on Enter.
    onSubmit(text: string) {
      hostSubmits.push(text);
    },
    getText() {
      return this.text;
    },
    setText(text: string) {
      this.text = text;
    },
    addToHistory(_text: string) {},
    handleInput(data: string) {
      if (data === "\r") {
        const text = this.text;
        this.text = "";
        this.onSubmit(text);
      }
    },
  };
  const hostOnSubmit = editor.onSubmit;
  const document = { render: (_width: number) => ["ORCHESTRATOR"] };
  const tui = {
    children: [document, { children: [editor], render: (): string[] => [] }],
    terminal: { columns: 100, rows: 40 },
    getFocusedComponent: () => editor,
    requestRender() {},
  };
  const controller = new FocusedAgentController(
    {
      steer(id, message) {
        steered.push(`${id}:${message}`);
        return true;
      },
      abort(id) {
        aborted.push(id);
        return true;
      },
      async resume() {
        return undefined;
      },
      setFastMode: () => undefined,
    },
    { hasSwitcher: () => true },
  );
  controller.setUICtx({ setWidget() {}, notify() {} });
  // SAFETY: The controller uses only the TUI and theme members these fixtures implement.
  assert.equal(controller.focus(record, tui as never, theme as never), true);
  return { controller, editor, hostOnSubmit, hostSubmits, steered, aborted };
}

for (const command of [
  "/stop",
  "/stop all",
  "/stop agent implementer",
  "/resume-work",
  "  /STOP  ",
]) {
  test(`focused prompt hands ${JSON.stringify(command)} to the host submit path, not the child`, () => {
    const { controller, editor, hostOnSubmit, hostSubmits, steered, aborted } = setup();
    editor.setText(command);
    editor.handleInput("\r");

    assert.deepEqual(hostSubmits, [command], "host's own onSubmit received the command");
    assert.deepEqual(steered, [], "child is not steered");
    assert.deepEqual(aborted, [], "child is not aborted");
    assert.equal(editor.onSubmit, hostOnSubmit, "host submit handler is left in place");
    assert.equal(controller.getState().kind, "agent", "focus is retained");
    controller.dispose();
  });
}

for (const text of ["please /stop that", "/stopper", "/resume-workers now", "hello"]) {
  test(`focused prompt still steers ${JSON.stringify(text)} to the child`, () => {
    const { controller, editor, hostSubmits, steered } = setup();
    editor.setText(text);
    editor.handleInput("\r");

    assert.deepEqual(steered, [`agent-7:${text}`]);
    assert.deepEqual(hostSubmits, [], "host submit path is not used");
    controller.dispose();
  });
}
