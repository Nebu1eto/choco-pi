import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  StackEntry,
  TuiInputListener,
  TuiMode,
} from "@earendil-works/pi-tui";
import { Container, HStack, ScrollView, VStack, isFocusable } from "@earendil-works/pi-tui";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { DiffClock } from "../.pi/extensions/lib/changes/git/clock.ts";
import type {
  DiffSnapshot,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileSummary,
  RefreshReason,
} from "../.pi/extensions/lib/changes/git/model.ts";
import type { PaneTui } from "../.pi/extensions/diff/host/types.ts";
import {
  FOCUS_SHORTCUT,
  registerDiffPane,
  TOGGLE_SHORTCUT,
} from "../.pi/extensions/diff/ui/controller.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import { PaneView } from "../.pi/extensions/diff/ui/pane-view.ts";
import { prefsPath, type PrefsIo } from "../.pi/extensions/diff/ui/prefs.ts";

/* ------------------------------------------------------------------ fakes */

class Lines implements Component {
  readonly lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(): string[] {
    return this.lines;
  }
  invalidate(): void {}
}

class FakeClock implements DiffClock {
  time = 1_000;
  nextId = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): RuntimeValue {
    this.nextId += 1;
    this.timers.set(this.nextId, { at: this.time + ms, fn });
    return this.nextId;
  }
  clearTimeout(handle: RuntimeValue): void {
    if (Number.isInteger(handle)) this.timers.delete(Number(handle));
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of this.timers) {
      if (timer.at > this.time) continue;
      this.timers.delete(id);
      timer.fn();
    }
  }
}

type OverlayRecord = { component: Component; options: OverlayOptions; hidden: boolean };

class FakeTui implements PaneTui {
  mode: TuiMode = "fullscreen";
  terminal = { columns: 120, rows: 40 };
  children: Component[] = [new Lines([]), new Lines(["editor"]), new Lines(["footer"])];
  layoutRoot: RuntimeValue;
  focused: Component | null;
  overlays: OverlayRecord[] = [];
  listeners: TuiInputListener[] = [];
  readonly editor: Component;

  constructor(root: RuntimeValue) {
    this.layoutRoot = root;
    this.editor = new Lines(["editor"]);
    this.focused = this.editor;
  }
  setFocus(component: Component | null): void {
    if (this.focused && isFocusable(this.focused)) this.focused.focused = false;
    this.focused = component;
    if (component && isFocusable(component)) component.focused = true;
  }
  getFocusedComponent(): Component | null {
    return this.focused;
  }
  requestRender(): void {}
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    const record: OverlayRecord = { component, options: options ?? {}, hidden: false };
    this.overlays.push(record);
    return {
      hide: () => {
        record.hidden = true;
      },
      setHidden: () => {},
      isHidden: () => record.hidden,
      focus: () => this.setFocus(component),
      unfocus: () => this.setFocus(this.editor),
      isFocused: () => this.focused === component,
      getBounds: () => undefined,
    };
  }
  addInputListener(listener: TuiInputListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
  /** Deliver input the way the TUI does: listeners first, then the focused component. */
  input(data: string): void {
    for (const listener of this.listeners) {
      if (listener(data)?.consume) return;
    }
    this.focused?.handleInput?.(data);
  }
}

function chatViewport() {
  const transcript = new ScrollView(new Container(), { follow: "end", primary: true });
  const dock = new VStack([{ component: new Lines(["editor"]), shrink: 1, minSize: 3 }]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { root, transcript, dock };
}

function entriesOf(stack: Component): StackEntry[] {
  const raw: RuntimeValue = "entries" in stack ? stack.entries : undefined;
  assert.ok(Array.isArray(raw));
  return raw.map((entry: StackEntry) => ({ ...entry }));
}

function file(path: string, additions = 1, deletions = 0): FileSummary {
  return {
    path,
    status: "modified",
    additions,
    deletions,
    binary: false,
    staged: false,
    unstaged: true,
  };
}

function snapshot(revision: number, files: FileSummary[]): DiffSnapshot {
  return {
    revision,
    source: { kind: "uncommitted" },
    repoRoot: "/repo",
    head: "abc",
    branch: "main",
    base: "abc",
    capturedAt: 0,
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, entry) => sum + (entry.additions ?? 0), 0),
      deletions: 0,
    },
    omittedFiles: 0,
  };
}

class FakeStore implements DiffStore {
  state: DiffStoreState = { kind: "idle" };
  listeners = new Set<(state: DiffStoreState) => void>();
  reasons: RefreshReason[] = [];
  visible: boolean[] = [];
  loads: string[] = [];
  refreshNowCalls = 0;
  disposed = false;
  bodies = new Map<string, FileBody>();
  readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  getState(): DiffStoreState {
    return this.state;
  }
  subscribe(listener: (state: DiffStoreState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(state: DiffStoreState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  requestRefresh(reason: RefreshReason): void {
    this.reasons.push(reason);
  }
  async refreshNow(): Promise<void> {
    this.refreshNowCalls += 1;
    this.emit({
      kind: "ready",
      snapshot: snapshot(1, [file("src/a.ts", 3, 1)]),
      refreshing: false,
    });
  }
  async loadFile(path: string): Promise<{ revision: number; body: FileBody }> {
    this.loads.push(path);
    const revision = this.state.kind === "ready" ? this.state.snapshot.revision : 0;
    return { revision, body: this.bodies.get(path) ?? { kind: "binary" } };
  }
  async loadContext(): Promise<never> {
    throw new Error("not used");
  }
  setSource(): void {}
  setVisible(visible: boolean): void {
    this.visible.push(visible);
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue;
type Shortcut = { handler: (ctx: ExtensionContext) => Promise<void> | void };

function harness(
  options: {
    mode?: ExtensionContext["mode"];
    root?: RuntimeValue;
    files?: Map<string, string>;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Array<(data: RuntimeValue) => void>>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const shortcuts = new Map<string, Shortcut>();
  const notices: string[] = [];
  const stores: FakeStore[] = [];
  const clock = new FakeClock();
  const files = options.files ?? new Map<string, string>();
  const reads: string[] = [];
  const writes: string[] = [];
  let probes = 0;
  const viewport = chatViewport();
  const tui = new FakeTui(options.root === undefined ? viewport.root : options.root);

  const fakePi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on: (channel: string, handler: (data: RuntimeValue) => void) => {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => {};
      },
      emit: (channel: string, data: RuntimeValue) => {
        for (const handler of bus.get(channel) ?? []) handler(data);
      },
    },
    registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      commands.set(name, command);
    },
    registerShortcut: (key: string, shortcut: Shortcut) => {
      shortcuts.set(key, shortcut);
    },
  };
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    mode: options.mode ?? "tui",
    hasUI: (options.mode ?? "tui") !== "print",
    cwd: "/repo",
    ui: { notify: (message: string) => notices.push(message) },
  });
  const io: PrefsIo = {
    read: async (path) => {
      reads.push(path);
      return files.get(path);
    },
    write: async (path, contents) => {
      writes.push(contents);
      files.set(path, contents);
    },
  };
  const probe = registerDiffPane(reinterpretHostValue<ExtensionAPI>(fakePi), {
    createStore: (cwd) => {
      const store = new FakeStore(cwd);
      stores.push(store);
      return store;
    },
    clock,
    prefsIo: io,
    agentDir: () => "/agent",
    probe: () => {
      probes += 1;
      return tui;
    },
    styler: () => plainPaneStyler,
    renderFileBody: (diffFile) => diffFile.hunks.map((hunk) => hunk.header),
  });

  const fire = async (event: string, payload: RuntimeValue = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const run = async (args = "") => {
    const command = commands.get("diff");
    assert.ok(command);
    await command.handler(args, ctx);
  };
  return {
    fire,
    run,
    fakePi,
    handlers,
    shortcuts,
    ctx,
    tui,
    viewport,
    clock,
    stores,
    notices,
    reads,
    writes,
    files,
    probe,
    probes: () => probes,
  };
}

const PREFS = prefsPath("/agent");

/* -------------------------------------------------------------- the tests */

test("nothing is created before the pane is first opened or a tool may have changed files", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.fire("tool_execution_end", { toolName: "read" });
  await h.fire("turn_start");
  await h.fire("agent_settled");
  assert.equal(h.stores.length, 0, "no store");
  assert.equal(h.probes(), 0, "no TUI probe");
  assert.equal(h.clock.timers.size, 0, "no timers");
  assert.deepEqual(h.reads, [PREFS], "only the preference file was read");
  assert.equal(h.probe.session()?.host, undefined);
});

test("/diff opens a docked pane without taking focus and persists the choice", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("");
  const store = h.stores[0];
  assert.ok(store);
  assert.ok(h.viewport.root.children[0] instanceof HStack, "docked beside the transcript");
  assert.equal(h.tui.focused, h.tui.editor, "focus stays in the editor");
  assert.deepEqual(store.visible, [true]);
  assert.deepEqual(store.reasons, ["open"]);
  h.clock.advance(200);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(h.files.get(PREFS) ?? "null"), { version: 1, open: true, width: 56 });
  await h.run("");
  assert.equal(h.viewport.root.children[0], h.viewport.transcript, "toggle closes and restores");
  assert.deepEqual(store.visible, [true, false]);
});

test("refresh wiring calls requestRefresh for each event while the pane is open", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  const store = h.stores[0];
  assert.ok(store);
  await h.fire("tool_execution_end", { toolName: "bash" });
  await h.fire("agent_settled", { aborted: false });
  await h.fire("turn_start");
  h.fakePi.events.emit("subagents:completed", { id: "a" });
  h.fakePi.events.emit("subagents:failed", { id: "b" });
  h.fakePi.events.emit("subagents:stopped", { id: "c" });
  assert.deepEqual(store.reasons, [
    "open",
    "tool",
    "settled",
    "turn",
    "subagent",
    "subagent",
    "subagent",
  ]);
  await h.run("close");
  await h.fire("tool_execution_end");
  assert.equal(store.reasons.length, 7, "a closed pane does not refresh");
});

test("Kitty-encoded Esc returns focus to the editor and a second Esc closes", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  assert.notEqual(h.tui.focused, h.tui.editor, "focus moved into the pane");
  h.tui.input("j");
  assert.notEqual(h.tui.focused, h.tui.editor, "pane keys stay in the pane");
  h.tui.input("\u001b[27u");
  assert.equal(h.tui.focused, h.tui.editor, "Kitty Esc returns focus");
  assert.ok(h.viewport.root.children[0] instanceof HStack, "the pane stays open");
  h.tui.input("\u001b[27u");
  assert.equal(h.viewport.root.children[0], h.viewport.transcript, "second Esc closes");
  assert.equal(h.tui.listeners.length, 0);
});

test("legacy Esc and q return focus; a late Esc goes to the editor", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  h.tui.input("\u001b");
  assert.equal(h.tui.focused, h.tui.editor);
  h.clock.advance(600);
  h.tui.input("\u001b");
  assert.ok(h.viewport.root.children[0] instanceof HStack, "Esc after the window does not close");
  await h.run("focus");
  h.tui.input("q");
  assert.equal(h.tui.focused, h.tui.editor);
  await h.run("focus");
  h.tui.input("\u001b[112;7u");
  assert.equal(
    h.viewport.root.children[0],
    h.viewport.transcript,
    "toggle key closes from the pane",
  );
  assert.equal(TOGGLE_SHORTCUT, "ctrl+alt+p");
  assert.ok(h.shortcuts.has(TOGGLE_SHORTCUT) && h.shortcuts.has(FOCUS_SHORTCUT));
});

test("width is clamped on every change and on terminal resize, and persisted", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  await h.run("width 500");
  assert.equal(h.probe.session()?.width, 79);
  await h.run("width 2");
  assert.equal(h.probe.session()?.width, 24);
  await h.run("focus");
  h.tui.input("[");
  h.tui.input("[");
  assert.equal(h.probe.session()?.width, 32);
  h.tui.input("]");
  assert.equal(h.probe.session()?.width, 28);
  h.clock.advance(200);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(h.files.get(PREFS) ?? "null"), { version: 1, open: true, width: 28 });
  await h.run("width 70");
  h.tui.terminal.columns = 90;
  const row = h.viewport.root.children[0];
  assert.ok(row instanceof HStack);
  const paneBox = entriesOf(row)[2];
  assert.equal(paneBox?.basis, 70);
  row.children[1]?.render(1);
  await Promise.resolve();
  assert.equal(entriesOf(row)[2]?.basis, 49, "re-clamped after the terminal shrank");
});

test("session_shutdown disposes everything synchronously and keeps the open preference", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  const store = h.stores[0];
  assert.ok(store);
  const before = h.clock.timers.size;
  assert.equal(before, 1, "debounced preference write pending");
  for (const handler of h.handlers.get("session_shutdown") ?? [])
    handler({ reason: "quit" }, h.ctx);
  assert.equal(store.disposed, true);
  assert.equal(store.listeners.size, 0);
  assert.equal(h.viewport.root.children[0], h.viewport.transcript);
  assert.equal(h.tui.listeners.length, 0);
  assert.equal(h.clock.timers.size, 0, "debounce timer cleared");
  assert.equal(h.probe.session(), undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(h.files.get(PREFS) ?? "null"), { version: 1, open: true, width: 56 });

  const restarted = harness({ files: h.files });
  await restarted.fire("session_start", { reason: "startup" });
  assert.ok(restarted.viewport.root.children[0] instanceof HStack, "reopened from the preference");
  assert.equal(restarted.tui.focused, restarted.tui.editor);
});

test("/new and /reload start clean: the old session's host and store are gone", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  h.clock.advance(200);
  await Promise.resolve();
  await Promise.resolve();
  await h.fire("session_shutdown", { reason: "new" });
  await h.fire("session_start", { reason: "new" });
  assert.equal(h.stores.length, 2);
  assert.equal(h.stores[0]?.disposed, true);
  assert.equal(h.stores[1]?.disposed, false);
  const row = h.viewport.root.children[0];
  assert.ok(row instanceof HStack, "reopened because the preference says open");
  assert.equal(h.viewport.root.children.length, 2);
  assert.equal(row.children[0], h.viewport.transcript);
  assert.equal(h.tui.listeners.length, 1);
});

test("an unexpected layout root selects the overlay host, which shutdown hides", async () => {
  const h = harness({ root: new VStack([new Lines(["only child"])]) });
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  assert.equal(h.probe.session()?.host?.kind, "overlay");
  assert.equal(h.tui.overlays.length, 1);
  assert.equal(h.tui.overlays[0]?.options.nonCapturing, true);
  // Said on the pane's own message line: a notification would be drawn under the overlay.
  assert.match(h.probe.session()?.view?.message?.text ?? "", /overlay/);
  assert.equal(h.notices.length, 0);
  await h.fire("session_shutdown", { reason: "reload" });
  assert.equal(h.tui.overlays[0]?.hidden, true);
});

test("no-UI sessions answer inline and never install a host", async () => {
  const h = harness({ mode: "print" });
  await h.fire("session_start", { reason: "startup" });
  assert.deepEqual(h.reads, [], "no preference read without a UI");
  await h.run("");
  await h.run("open");
  assert.equal(h.probes(), 0);
  assert.equal(h.tui.overlays.length, 0);
  assert.equal(h.viewport.root.children[0], h.viewport.transcript);
  assert.equal(h.stores[0]?.visible.length, 0);
  assert.match(h.notices[0] ?? "", /M src\/a\.ts {2}\+3 -1/);
});

test("regular TUI mode and narrow terminals print the inline list and say why", async () => {
  const h = harness();
  h.tui.mode = "regular";
  await h.fire("session_start", { reason: "startup" });
  await h.run("");
  assert.match(h.notices[0] ?? "", /fullscreen mode/);
  assert.match(h.notices[0] ?? "", /src\/a\.ts/);
  h.tui.mode = "fullscreen";
  h.tui.terminal.columns = 60;
  await h.run("");
  assert.match(h.notices[1] ?? "", /60 columns wide; the diff pane needs 65/);
  assert.equal(h.viewport.root.children[0], h.viewport.transcript);
});

test("a corrupt preference file is ignored and rewritten", async () => {
  const files = new Map([[PREFS, "{not json"]]);
  const h = harness({ files });
  await h.fire("session_start", { reason: "startup" });
  assert.equal(h.probe.session()?.host, undefined);
  h.clock.advance(200);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(files.get(PREFS) ?? "null"), { version: 1, open: false, width: 56 });
  files.set(PREFS, JSON.stringify({ version: 1, open: "yes", width: 40 }));
  const again = harness({ files });
  await again.fire("session_start", { reason: "startup" });
  assert.equal(again.probe.session()?.host, undefined);
});

/* ------------------------------------------------------------- view tests */

function viewHarness() {
  const store = new FakeStore("/repo");
  const calls: string[] = [];
  let rendered = 0;
  const view = new PaneView({
    store,
    styler: plainPaneStyler,
    renderFileBody: (diffFile) => {
      rendered += 1;
      return diffFile.hunks.map((hunk) => hunk.header);
    },
    actions: {
      unfocus: () => calls.push("unfocus"),
      close: () => calls.push("close"),
      resizeBy: (delta) => calls.push(`resize ${delta}`),
      refresh: () => calls.push("refresh"),
      requestRender: () => {},
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
  });
  return { view, store, calls, renders: () => rendered };
}

const textBody = (path: string): FileBody => ({
  kind: "text",
  file: {
    path,
    kind: "modified",
    additions: 1,
    deletions: 0,
    hunks: [
      {
        id: path,
        header: `@@ ${path} @@`,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [],
      },
    ],
  },
});

test("selection and expansion survive a refresh that moves the file", async () => {
  const { view, store } = viewHarness();
  store.bodies.set("b.ts", textBody("b.ts"));
  const first = snapshot(1, [file("a.ts"), file("b.ts"), file("c.ts")]);
  store.state = { kind: "ready", snapshot: first, refreshing: false };
  view.setState(store.state);
  view.renderBody(60, true);
  view.handleKey("j");
  view.handleKey("\r");
  assert.equal(view.selectedPath, "b.ts");
  assert.deepEqual(store.loads, ["b.ts"]);
  await Promise.resolve();
  assert.ok(view.renderBody(60, true).some((line) => line.includes("@@ b.ts @@")));

  const second = snapshot(2, [file("0.ts"), file("a.ts"), file("b.ts"), file("c.ts")]);
  store.state = { kind: "ready", snapshot: second, refreshing: false };
  view.setState(store.state);
  assert.equal(view.selectedPath, "b.ts");
  assert.equal(view.selectedIndex, 2);
  assert.ok(view.expanded.has("b.ts"));
  assert.deepEqual(store.loads, ["b.ts", "b.ts"], "hunks reloaded for the new revision");
  const lines = view.renderBody(60, true);
  assert.match(lines[2] ?? "", /^❯▾ M b\.ts/);

  store.state = { kind: "ready", snapshot: snapshot(3, [file("a.ts")]), refreshing: false };
  view.setState(store.state);
  assert.equal(view.selectedPath, "a.ts", "selection falls back when the file is gone");
  assert.equal(view.expanded.size, 0, "gone files are no longer expanded");
});

test("render cache: an unchanged revision renders nothing new", async () => {
  const { view, store, renders } = viewHarness();
  store.bodies.set("a.ts", textBody("a.ts"));
  const ready: DiffStoreState = {
    kind: "ready",
    snapshot: snapshot(4, [file("a.ts"), file("b.ts")]),
    refreshing: false,
  };
  store.state = ready;
  view.setState(ready);
  view.renderBody(50, false);
  view.handleKey(" ");
  await Promise.resolve();
  view.renderBody(50, false);
  const blocks = view.blockRenders;
  const bodies = renders();
  view.setState({ kind: "ready", snapshot: { ...ready.snapshot }, refreshing: true });
  view.setState({ kind: "ready", snapshot: { ...ready.snapshot }, refreshing: false });
  view.renderBody(50, false);
  view.renderBody(50, true);
  assert.equal(view.blockRenders, blocks, "cache hit for the same width and revision");
  assert.equal(renders(), bodies);
  view.renderBody(40, false);
  assert.ok(view.blockRenders > blocks, "a new width renders again");
  const afterWidth = view.blockRenders;
  view.setState({
    kind: "ready",
    snapshot: snapshot(5, [file("a.ts"), file("b.ts")]),
    refreshing: false,
  });
  view.renderBody(40, false);
  assert.ok(view.blockRenders > afterWidth, "a new revision renders again");
});

test("pane keys: Kitty Esc unfocuses, brackets resize, r refreshes, body states explain themselves", async () => {
  const { view, store, calls } = viewHarness();
  view.handleKey("\u001b[27u");
  view.handleKey("[");
  view.handleKey("]");
  view.handleKey("r");
  assert.deepEqual(calls, ["unfocus", "resize 4", "resize -4", "refresh"]);
  store.bodies.set("big.bin", { kind: "too-large", bytes: 2_000_000, limit: 1_000_000 });
  store.state = {
    kind: "ready",
    snapshot: { ...snapshot(1, [file("big.bin")]), omittedFiles: 3 },
    refreshing: false,
  };
  view.setState(store.state);
  view.handleKey("\r");
  await Promise.resolve();
  const lines = view.renderBody(70, false);
  assert.match(lines.join("\n"), /Diff too large to show \(1\.9 MB, limit 977 KB\)/);
  assert.match(lines.at(-1) ?? "", /3 more files not shown/);
  view.setState({ kind: "ready", snapshot: snapshot(2, []), refreshing: false });
  assert.deepEqual(view.renderBody(70, false), ["No uncommitted changes"]);
  view.setState({ kind: "not-a-repository", cwd: "/tmp" });
  assert.match(view.renderHeader(70, false).join("\n"), /Not a git repository/);
});
