import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentManager } from "../src/agent-manager.ts";
import type { AgentRecord, WidgetMode } from "../src/types.ts";
import type { AgentActivity, Theme } from "../src/ui/agent-widget.ts";
import { FleetPanel, type FleetPanelUICtx } from "../src/ui/fleet-panel.ts";
import type { ShellSectionProvider, ShellSectionRow } from "../src/ui/shell-section-contract.ts";

initTheme("dark", false);

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};
const styledTheme: Theme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the exact structural slice exercised by its subject.
  return fixture as T;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let started = 0;
function agent(id: string, description = id, options: Partial<AgentRecord> = {}): AgentRecord {
  started++;
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
    session: partialFixture<AgentSession>({}),
    ...options,
  });
}

function shell(id: string, options: Partial<ShellSectionRow> = {}): ShellSectionRow {
  return {
    shellId: id,
    label: options.label ?? id,
    state: "running",
    startedAt: Date.now() - 1_000,
    command: `run ${id}`,
    cwd: "/tmp",
    ...options,
  };
}

class ProviderFixture implements ShellSectionProvider {
  current: ShellSectionRow[] = [];
  listeners = new Set<() => void>();
  stopCalls: string[] = [];
  openCalls: string[] = [];
  stopResult: (id: string) => Promise<void> = async () => {};
  viewerResult: Promise<void> = Promise.resolve();
  closer: (() => void) | undefined;

  rows(): readonly ShellSectionRow[] {
    return this.current;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(id: string): Promise<void> {
    this.stopCalls.push(id);
    return this.stopResult(id);
  }

  openViewer(
    id: string,
    _ui: FleetPanelUICtx,
    onOpened: (close: () => void) => void,
  ): Promise<void> {
    this.openCalls.push(id);
    this.closer = () => {};
    onOpened(this.closer);
    return this.viewerResult;
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }
}

type FocusedComponent = {} | null | undefined;

function mount(
  options: {
    records?: AgentRecord[];
    shells?: ShellSectionRow[];
    activity?: Map<string, AgentActivity>;
    mode?: WidgetMode;
    renderTheme?: Theme;
    width?: number;
    focusedComponent?: FocusedComponent;
    overlay?: boolean;
    editorText?: string;
    openSideConversation?: boolean;
  } = {},
) {
  const records = options.records ?? [];
  const provider = new ProviderFixture();
  provider.current = options.shells ?? [];
  let mode = options.mode ?? "all";
  let widgetModeCalls = 0;
  let focusedId: string | undefined;
  let unfocusCalls = 0;
  const focusCalls: string[] = [];
  const openedBtw: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const manager = partialFixture<AgentManager>({
    listAgents: () => records.toReversed(),
    getScheduledActiveCount: () => records.filter((record) => record.status === "running").length,
    getActiveCount: () => records.filter((record) => record.status === "running").length,
    getMaxConcurrent: () => 8,
  });
  const panel = new FleetPanel(
    manager,
    options.activity ?? new Map<string, AgentActivity>(),
    {
      focusAgent(record) {
        focusedId = record.id;
        focusCalls.push(record.id);
        return true;
      },
      focusedAgentId: () => focusedId,
      unfocusAgent() {
        focusedId = undefined;
        unfocusCalls++;
      },
      openSideConversation(record) {
        openedBtw.push(record.id);
        return options.openSideConversation ?? true;
      },
    },
    {
      widgetMode: () => {
        widgetModeCalls++;
        return mode;
      },
    },
  );
  const tui = partialFixture<TUI & { focusedComponent?: FocusedComponent }>({
    terminal: partialFixture<TUI["terminal"]>({ columns: options.width ?? 120 }),
    focusedComponent: options.focusedComponent,
    hasOverlay: () => options.overlay === true,
    requestRender() {},
  });
  let component: { render(width: number): string[] } | undefined;
  let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const ui = partialFixture<FleetPanelUICtx>({
    setStatus(_key, value) {
      statuses.push(value);
    },
    setWidget(_key, factory) {
      component = factory?.(tui, options.renderTheme ?? theme);
    },
    onTerminalInput(next) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
    getEditorText: () => options.editorText ?? "",
    notify(message, type) {
      notices.push({ message, type });
    },
    custom<T>(): Promise<T> {
      // SAFETY: No test invokes the generic custom viewer result; the fixture
      // only satisfies the UI surface used by FleetPanel.
      return Promise.resolve(undefined as T);
    },
  });
  panel.setUICtx(ui);
  panel.setShellSection(provider);
  panel.update();
  return {
    panel,
    provider,
    records,
    focusCalls,
    openedBtw,
    notices,
    statuses,
    press: (key: string) => handler?.(key),
    lines: (width = options.width ?? 120) => component?.render(width) ?? [],
    text: (width = options.width ?? 120) => (component?.render(width) ?? []).join("\n"),
    focused: () => focusedId,
    unfocusCalls: () => unfocusCalls,
    widgetModeCalls: () => widgetModeCalls,
    setMode(next: WidgetMode) {
      mode = next;
      panel.update();
    },
  };
}

test("custom editors retain arrow navigation", () => {
  const view = mount({
    records: [agent("a1")],
    focusedComponent: { getText() {}, setText() {}, handleInput() {} },
  });
  try {
    assert.deepEqual(view.press(DOWN), { consume: true });
    view.press(DOWN);
    assert.equal(view.focused(), "a1");
  } finally {
    view.panel.dispose();
  }
});

test("focused agent row omits the redundant focused badge text", () => {
  const view = mount({ records: [agent("a1")] });
  try {
    view.press(DOWN);
    const rendered = view.text();
    assert.ok(rendered.includes("a1"), "focused-row name is still rendered");
    assert.ok(
      !rendered.includes("focused"),
      "focused row shows no literal 'focused' badge (cursor already carries focus)",
    );
  } finally {
    view.panel.dispose();
  }
});

test("non-editor overlays retain arrow keys", () => {
  const view = mount({ records: [agent("a1")], focusedComponent: { handleInput() {} } });
  try {
    assert.equal(view.press(DOWN), undefined);
    assert.equal(view.panel.isActive(), false);
  } finally {
    view.panel.dispose();
  }
});

test("agent navigation focuses rows and main restores orchestrator without popup", () => {
  const view = mount({ records: [agent("a1"), agent("a2")] });
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press(DOWN);
    assert.deepEqual(view.focusCalls, ["a1", "a2"]);
    assert.equal(view.focused(), "a2");
    assert.deepEqual(view.press(ESC), { consume: true });
    assert.equal(view.focused(), "a2");
    view.press(DOWN);
    view.press(UP);
    view.press(UP);
    assert.equal(view.focused(), undefined);
    view.press(DOWN);
    assert.deepEqual(view.press("\r"), { consume: true });
    assert.equal(view.focused(), "a1");
  } finally {
    view.panel.dispose();
  }
});

test("roster loss unfocuses and deactivates", () => {
  const view = mount({ records: [agent("a1")] });
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.records.length = 0;
    view.panel.update();
    assert.equal(view.focused(), undefined);
    assert.equal(view.panel.isActive(), false);
    assert.equal(view.unfocusCalls(), 1);
  } finally {
    view.panel.dispose();
  }
});

test("focused agent loss unfocuses while shell rows remain", () => {
  const view = mount({ records: [agent("a1")], shells: [shell("s")] });
  try {
    view.press(DOWN);
    view.press(DOWN);
    assert.equal(view.focused(), "a1");
    view.records.length = 0;
    view.panel.update();
    assert.equal(view.focused(), undefined);
    assert.equal(view.unfocusCalls(), 1);
    assert.match(view.text(), /s/);
  } finally {
    view.panel.dispose();
  }
});

test("btw rows never focus and Enter opens their overlay", () => {
  const view = mount({
    records: [agent("a1"), agent("btw", "side", { sideConversation: true })],
  });
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press(DOWN);
    assert.equal(view.focused(), undefined);
    assert.match(view.text(), /\[btw\]/);
    view.press("\r");
    assert.deepEqual(view.openedBtw, ["btw"]);
  } finally {
    view.panel.dispose();
  }
});

test("session-less btw Enter reports unavailable session", () => {
  const record = agent("btw", "side", {
    sideConversation: true,
    session: undefined,
    status: "completed",
    completedAt: Date.now(),
  });
  const view = mount({ records: [record], openSideConversation: false });
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press("\r");
    assert.deepEqual(view.notices, [
      { message: "Agent is completed — no session available.", type: "info" },
    ]);
  } finally {
    view.panel.dispose();
  }
});

test("finished rows obey either linger clock and render sanitized errors", () => {
  const failed = agent("failed", "failed task", {
    status: "error",
    completedAt: Date.now(),
    error: `boom\x1b[31m\n${"x".repeat(100)}`,
  });
  const completed = agent("completed", "completed task", {
    status: "completed",
    completedAt: Date.now(),
  });
  const view = mount({ records: [failed, completed] });
  try {
    view.panel.markFinished(failed.id);
    view.panel.markFinished(completed.id);
    view.panel.update();
    assert.match(view.text(), /failed task error: boom/);
    assert.equal(view.text().includes("\x1b[31m"), false);
    assert.match(view.text(), /completed task/);

    view.panel.onTurnStart();
    assert.match(view.text(), /failed task/);
    assert.match(view.text(), /completed task/);

    view.panel.onTurnStart();
    assert.match(view.text(), /failed task/);

    failed.completedAt = Date.now() - 4_000;
    completed.completedAt = Date.now() - 4_000;
    view.panel.update();
    assert.doesNotMatch(view.text(), /failed task/);
    assert.doesNotMatch(view.text(), /completed task/);
  } finally {
    view.panel.dispose();
  }
});

test("agent rows preserve alias-only and unnamed role labels", () => {
  const parent = agent("parent", "plan", { alias: "alpha" });
  const child = agent("child", "inspect", { alias: "beta", parentAgentId: parent.id });
  const unnamed = agent("unnamed", "review", { parentAgentId: child.id });
  const view = mount({ records: [unnamed, parent, child], renderTheme: styledTheme, width: 400 });
  try {
    const text = view.text();
    assert.match(text, /<bold>@alpha<\/bold>/);
    assert.match(text, /<bold>@beta<\/bold>/);
    assert.doesNotMatch(text, /implementer.*@alpha|@alpha.*implementer/);
    assert.match(text, /Agent/);
    assert.ok(text.indexOf("plan") < text.indexOf("inspect"));
    assert.ok(text.indexOf("inspect") < text.indexOf("review"));
  } finally {
    view.panel.dispose();
  }
});

test("running detail row keeps alias and compact activity stats", () => {
  const record = agent("api", "Find hook", { alias: "explorer-api", toolUses: 5 });
  const activity = partialFixture<AgentActivity>({
    activeTools: new Map(),
    toolUses: 5,
    responseText: "",
    turnCount: 5,
    maxTurns: 10,
    lifetimeUsage: { input: 50_000, output: 8_500, cacheWrite: 0 },
    session: {
      getSessionStats: () => ({
        tokens: { input: 50_000, output: 8_500, cacheWrite: 0 },
        contextUsage: { percent: 9 },
      }),
    },
  });
  const view = mount({
    records: [record],
    activity: new Map([[record.id, activity]]),
    renderTheme: styledTheme,
    width: 400,
  });
  try {
    const text = view.text();
    assert.match(text, /<bold>@explorer-api<\/bold>/);
    assert.match(text, /thinking… · 5 tool uses · 58\.5k \(<dim>9%<\/dim>\)/);
    assert.doesNotMatch(text, /↻|\b(?:token|tokens)\b/);
  } finally {
    view.panel.dispose();
  }
});

test("activation requires empty editor focus and yields to visible overlay", () => {
  const draft = mount({ shells: [shell("s")], editorText: "draft" });
  const overlay = mount({ shells: [shell("s")], overlay: true });
  try {
    assert.equal(draft.press(DOWN), undefined);
    assert.equal(overlay.press(DOWN), undefined);
  } finally {
    draft.panel.dispose();
    overlay.panel.dispose();
  }
});

test("mixed arrows cross agent and shell section boundaries", () => {
  const view = mount({ records: [agent("a")], shells: [shell("s")] });
  try {
    view.press(DOWN);
    view.press(DOWN);
    assert.equal(view.focused(), "a");
    view.press(DOWN);
    assert.equal(view.focused(), undefined);
    assert.match(view.text(), /●.*s/);
    view.press(UP);
    assert.equal(view.focused(), "a");
  } finally {
    view.panel.dispose();
  }
});

test("right and left jump to first shell and agent", () => {
  const view = mount({ records: [agent("a1"), agent("a2")], shells: [shell("s1")] });
  try {
    view.press(DOWN);
    view.press(RIGHT);
    assert.match(view.text(), /●.*s1/);
    view.press(LEFT);
    assert.match(view.text(), /●.*a1/);
    assert.equal(view.focused(), "a1");
  } finally {
    view.panel.dispose();
  }
});

test("shell-only roster reports no agent rows and still navigates", () => {
  const view = mount({ shells: [shell("s")] });
  try {
    assert.equal(view.panel.hasAgentRows(), false);
    assert.match(view.text(), /↓ to manage shells/);
    assert.deepEqual(view.press(DOWN), { consume: true });
    view.press(DOWN);
    assert.match(view.text(), /●.*s/);
  } finally {
    view.panel.dispose();
  }
});

test("fleetView false removes agents but retains shells", () => {
  const view = mount({ records: [agent("a")], shells: [shell("s")] });
  try {
    view.panel.setAgentSectionEnabled(false);
    assert.equal(view.panel.hasAgentRows(), false);
    assert.doesNotMatch(view.text(), / a\b/);
    assert.match(view.text(), /s/);
    assert.equal(view.press(LEFT), undefined);
    assert.deepEqual(view.press(DOWN), { consume: true });
  } finally {
    view.panel.dispose();
  }
});

test("Enter opens shell viewer and yields all keys until close", async () => {
  const view = mount({ shells: [shell("s")] });
  const pending = deferred<void>();
  view.provider.viewerResult = pending.promise;
  try {
    view.press(DOWN);
    view.press(DOWN);
    assert.deepEqual(view.press("\r"), { consume: true });
    assert.deepEqual(view.provider.openCalls, ["s"]);
    assert.equal(view.press("x"), undefined);
    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    assert.deepEqual(view.press("x"), { consume: true });
  } finally {
    view.panel.dispose();
  }
});

test("shell viewer rejection notifies and clears viewer state", async () => {
  const view = mount({ shells: [shell("s")] });
  view.provider.viewerResult = Promise.reject(new Error("Viewer \x1b[31mfailed\n"));
  try {
    view.press(DOWN);
    view.press(DOWN);
    assert.deepEqual(view.press("\r"), { consume: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(view.notices, [{ message: "Viewer failed", type: "error" }]);
    assert.deepEqual(view.press("x"), { consume: true });
  } finally {
    view.panel.dispose();
  }
});

test("non-Error shell viewer rejection uses a safe notification", async () => {
  const view = mount({ shells: [shell("s")] });
  view.provider.viewerResult = Promise.reject("not an Error");
  try {
    view.press(DOWN);
    view.press(DOWN);
    assert.deepEqual(view.press("\r"), { consume: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(view.notices, [{ message: "Shell viewer failed.", type: "error" }]);
  } finally {
    view.panel.dispose();
  }
});

test("x stops selected shell once and renders pending state", async () => {
  const view = mount({ shells: [shell("nested")] });
  const pending = deferred<void>();
  view.provider.stopResult = () => pending.promise;
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press("x");
    view.press("x");
    assert.deepEqual(view.provider.stopCalls, ["nested"]);
    assert.match(view.text(), /stopping…/);
    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    assert.doesNotMatch(view.text(), /stopping…/);
  } finally {
    view.panel.dispose();
  }
});

test("stop rejection is sanitized, bounded, rendered, and notified", async () => {
  const view = mount({ shells: [shell("s")] });
  view.provider.stopResult = async () => {
    throw new Error(`denied\x1b[31m\n${"e".repeat(100)}`);
  };
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press("x");
    await Promise.resolve();
    await Promise.resolve();
    assert.match(view.text(), /stop failed: denied/);
    assert.equal(stripTerminalSequences(view.text()).includes("\x1b"), false);
    assert.equal(view.notices.at(-1)?.type, "error");
    assert.ok((view.notices.at(-1)?.message.length ?? 100) <= 60);
  } finally {
    view.panel.dispose();
  }
});

test("settled x is non-destructive", () => {
  const view = mount({ shells: [shell("done", { state: "exited", endedAt: Date.now() })] });
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press("x");
    assert.deepEqual(view.provider.stopCalls, []);
    assert.deepEqual(view.notices, [
      { message: "Shell already settled; nothing to stop.", type: "info" },
    ]);
  } finally {
    view.panel.dispose();
  }
});

test("shell selection remains keyed across insertion and clamps after removal", () => {
  const view = mount({ shells: [shell("first"), shell("second")] });
  try {
    view.press(DOWN);
    view.press(DOWN);
    view.press(DOWN);
    assert.match(view.text(), /●.*second/);
    view.provider.current.unshift(shell("zero"));
    view.provider.changed();
    assert.match(view.text(), /●.*second/);
    view.provider.current = view.provider.current.filter((row) => row.shellId !== "second");
    view.provider.changed();
    assert.match(view.text(), /●.*first/);
  } finally {
    view.panel.dispose();
  }
});

test("widget modes affect details but never agent membership", () => {
  const foreground = agent("fg", "foreground", { isBackground: false });
  const background = agent("bg", "background", { isBackground: true });
  const view = mount({ records: [foreground, background], mode: "all" });
  try {
    assert.equal(view.lines().filter((line) => line.includes("⎿")).length, 2);
    view.setMode("background");
    assert.equal(view.lines().filter((line) => line.includes("⎿")).length, 1);
    assert.match(view.text(), /foreground/);
    view.setMode("off");
    assert.equal(view.lines().filter((line) => line.includes("⎿")).length, 0);
    assert.match(view.text(), /foreground/);
    assert.match(view.text(), /background/);
  } finally {
    view.panel.dispose();
  }
});

test("rendering reads only the injected widget-mode getter", () => {
  const view = mount({ records: [agent("a")] });
  try {
    assert.equal(view.widgetModeCalls(), 0);
    view.lines();
    assert.ok(view.widgetModeCalls() > 0);
  } finally {
    view.panel.dispose();
  }
});

test("twelve-line budget drops details before compact rows", () => {
  const records = Array.from({ length: 5 }, (_, index) => agent(`a${index}`));
  const shells = Array.from({ length: 3 }, (_, index) => shell(`s${index}`));
  const view = mount({ records, shells, mode: "all" });
  try {
    const lines = view.lines();
    assert.ok(lines.length <= 12);
    assert.equal(
      lines.some((line) => line.includes("⎿")),
      false,
    );
    for (const record of records) assert.match(lines.join("\n"), new RegExp(record.id));
    for (const row of shells) assert.match(lines.join("\n"), new RegExp(row.shellId));
  } finally {
    view.panel.dispose();
  }
});

test("one unref timer ticks while rows exist and stops when roster empties", async () => {
  const view = mount({ shells: [shell("s")] });
  try {
    const before = view.lines().join("\n");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = view.lines().join("\n");
    assert.notEqual(after, before, "spinner advances on the shared timer");
    view.provider.current = [];
    view.provider.changed();
    assert.deepEqual(view.lines(), []);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(view.lines(), []);
  } finally {
    view.panel.dispose();
  }
});
