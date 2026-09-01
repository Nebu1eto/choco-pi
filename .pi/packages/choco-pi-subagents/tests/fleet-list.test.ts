import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "../src/agent-manager.ts";
import type { AgentRecord } from "../src/types.ts";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.ts";
import type { Theme } from "../src/ui/agent-widget.ts";

initTheme("dark", false);

const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const styledTheme: Theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

const KEY_DOWN = "\x1b[B";
const KEY_UP = "\x1b[A";
const KEY_ESC = "\x1b";
type FocusedComponentFixture = {} | null | undefined;

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the named slice exercised by its subject.
  return fixture as T;
}

let started = 0;
function makeRecord(
  id: string,
  description: string,
  sideConversation = false,
  parentAgentId?: string,
): AgentRecord {
  started += 1;
  return partialFixture<AgentRecord>({
    id,
    type: "implementer",
    handle: id,
    description,
    status: "running",
    toolUses: 0,
    startedAt: started,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    sideConversation,
    parentAgentId,
    session: partialFixture<AgentSession>({}),
  });
}

function mount(
  records: AgentRecord[],
  renderTheme = theme,
  renderWidth = 90,
  focusedComponent?: FocusedComponentFixture,
) {
  let focusedId: string | undefined;
  const focusCalls: string[] = [];
  let unfocusCalls = 0;
  const opened: string[] = [];
  const manager = partialFixture<AgentManager>({
    // Production order is newest-first; FleetList re-sorts by startedAt.
    listAgents: () => records.toReversed(),
  });
  const fleet = new FleetList(manager, new Map(), {
    focusAgent: (record) => {
      focusedId = record.id;
      focusCalls.push(record.id);
      return true;
    },
    focusedAgentId: () => focusedId,
    unfocusAgent: () => {
      focusedId = undefined;
      unfocusCalls += 1;
    },
    openSideConversation: (record) => {
      opened.push(record.id);
      return true;
    },
  });

  const tui = partialFixture<TUI & { focusedComponent?: FocusedComponentFixture }>({
    requestRender() {},
    focusedComponent,
  });
  let widget: { render(width: number): string[] } | undefined;
  let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let overlayCount = 0;
  const ui = partialFixture<FleetUICtx>({
    setWidget(_key, content) {
      widget = content ? content(tui, renderTheme) : undefined;
    },
    onTerminalInput(h) {
      handler = h;
      return () => {};
    },
    getEditorText: () => "",
    notify() {},
    custom<T>(): Promise<T> {
      overlayCount += 1;
      // SAFETY: These tests only observe whether the overlay was opened; the
      // fleet list never reads the resolved value.
      return Promise.resolve(undefined as T);
    },
  });
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    press: (data: string) => handler?.(data),
    render: () => (widget?.render(renderWidth) ?? []).join("\n"),
    focusCalls,
    opened,
    focusedId: () => focusedId,
    unfocusCalls: () => unfocusCalls,
    showingRows: () => fleet.isShowingRows(),
    active: () => fleet.isActive(),
    overlayCount: () => overlayCount,
  };
}

test("cross-package custom editors retain FleetView arrow navigation", () => {
  const customEditor = {
    getText: () => "",
    setText() {},
    handleInput() {},
  };
  const view = mount([makeRecord("a1", "first")], theme, 90, customEditor);
  try {
    assert.deepEqual(view.press(KEY_DOWN), { consume: true });
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a1");
  } finally {
    view.fleet.dispose();
  }
});

test("non-editor overlays keep ownership of arrow keys", () => {
  const view = mount([makeRecord("a1", "first")], theme, 90, { handleInput() {} });
  try {
    assert.equal(view.press(KEY_DOWN), undefined);
    assert.equal(view.active(), false);
  } finally {
    view.fleet.dispose();
  }
});

test("arrow navigation switches fullscreen focus, and main restores the orchestrator", () => {
  const view = mount([makeRecord("a1", "first"), makeRecord("a2", "second")]);
  try {
    // The first press only activates the list, with the cursor on the main row.
    assert.deepEqual(view.press(KEY_DOWN), { consume: true });
    assert.equal(view.active(), true);
    assert.equal(view.focusedId(), undefined);

    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a1");
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a2");
    assert.deepEqual(view.focusCalls, ["a1", "a2"]);

    // The switcher keeps rendering while an agent is focused.
    const focusedRender = view.render();
    assert.match(focusedRender, /main/);
    assert.match(focusedRender, /second/);
    assert.match(focusedRender, /switch agent/);

    // Esc leaves list navigation only; it never unfocuses.
    assert.deepEqual(view.press(KEY_ESC), { consume: true });
    assert.equal(view.active(), false);
    assert.equal(view.focusedId(), "a2");
    assert.match(view.render(), /switch agents/);

    // Re-entering the list keeps the cursor on the focused agent.
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a2");

    view.press(KEY_UP);
    assert.equal(view.focusedId(), "a1");
    view.press(KEY_UP);
    assert.equal(view.focusedId(), undefined, "main returns to the orchestrator transcript");
    assert.equal(view.unfocusCalls(), 1);

    // Enter must not open the modal viewer for an ordinary agent: the row is
    // already focused in the main area, so an overlay would duplicate it.
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a1");
    assert.deepEqual(view.press("\r"), { consume: true });
    assert.equal(view.overlayCount(), 0, "Enter opens no popup for a focused agent");
    assert.equal(view.focusedId(), "a1", "Enter keeps the agent focused");
  } finally {
    view.fleet.dispose();
  }
});

test("losing the focused row from the roster restores the orchestrator", () => {
  const records = [makeRecord("a1", "first")];
  const view = mount(records);
  try {
    view.press(KEY_DOWN);
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a1");
    assert.equal(view.showingRows(), true);

    // The manager evicts a settled record ten minutes after completion; the
    // switcher then has no rows, so focus must not strand the transcript.
    records.length = 0;
    view.fleet.update();

    assert.equal(view.focusedId(), undefined, "eviction unfocuses");
    assert.equal(view.showingRows(), false, "and the switcher reports itself gone");
  } finally {
    view.fleet.dispose();
  }
});

test("a /btw row is never auto-focused and keeps its dismissible overlay", () => {
  const view = mount([makeRecord("a1", "first"), makeRecord("b1", "side question", true)]);
  try {
    view.press(KEY_DOWN);
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), "a1");

    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), undefined, "side conversations own their overlay");
    assert.deepEqual(view.focusCalls, ["a1"]);
    assert.match(view.render(), /\[btw\]/);

    assert.deepEqual(view.press("\r"), { consume: true });
    assert.deepEqual(view.opened, ["b1"]);
  } finally {
    view.fleet.dispose();
  }
});

test("rows render alias-only labels and preserve unnamed role labels", () => {
  const parent = makeRecord("planner", "plan work");
  parent.alias = "alpha";
  const child = makeRecord("scout", "inspect code", false, parent.id);
  child.alias = "beta";
  const grandchild = makeRecord("review", "check finding", false, child.id);
  const view = mount([grandchild, parent, child], styledTheme, 400);
  try {
    const rendered = view.render();
    assert.match(rendered, /<muted><bold>@alpha<\/bold><\/muted>  plan work/);
    assert.match(rendered, /└ <muted><bold>@beta<\/bold><\/muted>/);
    assert.doesNotMatch(rendered, /implementer.*@alpha|@alpha.*implementer/);
    assert.match(rendered, /<muted>Agent<\/muted>/);
    assert.doesNotMatch(rendered, /\b(?:token|tokens)\b|↻/);
    assert.ok(rendered.indexOf("plan work") < rendered.indexOf("inspect code"));
    assert.ok(rendered.indexOf("inspect code") < rendered.indexOf("check finding"));

    view.press(KEY_DOWN);
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), parent.id);
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), child.id);
    view.press(KEY_DOWN);
    assert.equal(view.focusedId(), grandchild.id);
  } finally {
    view.fleet.dispose();
  }
});
