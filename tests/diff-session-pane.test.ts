// The /diff pane always opens on the session source, opens by itself when the agent changes code, and refreshes.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { Container, HStack, ScrollView, VStack } from "@earendil-works/pi-tui";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type {
  DiffSnapshot,
  DiffSource,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileSummary,
  RefreshReason,
  SnapshotBaseline,
} from "../.pi/extensions/lib/changes/git/model.ts";
import type { TurnTreeProvider } from "../.pi/extensions/lib/changes/types.ts";
import { DIFF_SUBCOMMANDS, parseDiffCommand } from "../.pi/extensions/diff/ui/command.ts";
import { registerDiffPane, TOGGLE_SHORTCUT } from "../.pi/extensions/diff/ui/controller.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import {
  NATIVE_DIFF_ENV,
  NATIVE_DIFF_NOTIFY_PREFIX,
  presentNativeDiff,
} from "../.pi/extensions/diff/native-diff.ts";
import { createSystemClock } from "../.pi/extensions/lib/changes/git/clock.ts";
import {
  parsePrefs,
  prefsPath,
  serializePrefs,
  type PrefsIo,
} from "../.pi/extensions/diff/ui/prefs.ts";
import { FakeClock, FakeTui } from "./diff-actions-fakes.ts";

const PREFS = prefsPath("/agent");
const CHECKPOINT: SnapshotBaseline = { kind: "checkpoint", label: "turn 1 (edit b please)" };

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

class RecordingTui extends FakeTui {
  overlays = 0;
  override showOverlay(component: Component): OverlayHandle {
    this.overlays += 1;
    return super.showOverlay(component);
  }
}

function summary(path: string): FileSummary {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
  };
}

function snapshotOf(revision: number, source: DiffSource, paths: string[]): DiffSnapshot {
  const snapshot: DiffSnapshot = {
    revision,
    source,
    repoRoot: "/repo",
    head: "abc",
    branch: "main",
    base: source.kind === "session" ? "c0ffee" : "abc",
    capturedAt: 0,
    files: paths.map(summary),
    totals: { files: paths.length, additions: paths.length, deletions: 0 },
    omittedFiles: 0,
  };
  if (source.kind === "session") snapshot.baseline = CHECKPOINT;
  return snapshot;
}

/** A store that lists world[source kind] for its current source on every read. */
class SourceStore implements DiffStore {
  state: DiffStoreState = { kind: "idle" };
  listeners = new Set<(state: DiffStoreState) => void>();
  reasons: RefreshReason[] = [];
  sources: DiffSource[] = [];
  visible: boolean[] = [];
  reads = 0;
  disposed = false;
  source: DiffSource;
  readonly world: Map<string, string[]>;
  /** When set, refreshNow waits for this before reading. */
  gate: Promise<void> | undefined;
  readonly initial: DiffSource | undefined;
  readonly checkpoints: TurnTreeProvider | undefined;
  constructor(world: Map<string, string[]>, checkpoints?: TurnTreeProvider, source?: DiffSource) {
    this.world = world;
    this.checkpoints = checkpoints;
    this.initial = source;
    this.source = source ?? { kind: "uncommitted" };
  }
  getState(): DiffStoreState {
    return this.state;
  }
  subscribe(listener: (state: DiffStoreState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private read(): void {
    this.reads += 1;
    const snapshot = snapshotOf(this.reads, this.source, this.world.get(this.source.kind) ?? []);
    this.state = { kind: "ready", snapshot, refreshing: false };
    for (const listener of this.listeners) listener(this.state);
  }
  requestRefresh(reason: RefreshReason): void {
    this.reasons.push(reason);
    this.read();
  }
  async refreshNow(): Promise<void> {
    if (this.gate) await this.gate;
    if (!this.disposed) this.read();
  }
  async loadFile(): Promise<{ revision: number; body: FileBody }> {
    return { revision: this.reads, body: { kind: "binary" } };
  }
  async loadContext(): Promise<never> {
    throw new Error("not used");
  }
  setSource(source: DiffSource): void {
    this.sources.push(source);
    this.source = source;
    if (this.state.kind === "ready") this.read();
  }
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

function chatRoot() {
  const transcript = new ScrollView(new Container(), { follow: "end", primary: true });
  const dock = new VStack([{ component: new Lines(["editor"]), shrink: 1, minSize: 3 }]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { root, transcript };
}

function setup(
  options: {
    mode?: ExtensionContext["mode"];
    files?: Map<string, string>;
    root?: RuntimeValue;
    world?: Map<string, string[]>;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Array<(data: RuntimeValue) => void>>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const shortcuts = new Map<string, Shortcut>();
  const notices: string[] = [];
  const stores: SourceStore[] = [];
  const world = options.world ?? new Map<string, string[]>();
  const files = options.files ?? new Map<string, string>();
  const clock = new FakeClock();
  const viewport = chatRoot();
  const tui = new RecordingTui(options.root === undefined ? viewport.root : options.root);
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
  const mode = options.mode ?? "tui";
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    mode,
    hasUI: mode !== "print",
    cwd: "/repo",
    ui: {
      notify: (message: string) => notices.push(message),
      getEditorText: () => "",
      setEditorText: () => {},
    },
  });
  const io: PrefsIo = {
    read: async (path) => files.get(path),
    write: async (path, contents) => {
      files.set(path, contents);
    },
  };
  const probe = registerDiffPane(reinterpretHostValue<ExtensionAPI>(fakePi), {
    createStore: (_cwd, checkpoints, source) => {
      const store = new SourceStore(world, checkpoints, source);
      stores.push(store);
      return store;
    },
    clock,
    prefsIo: io,
    agentDir: () => "/agent",
    probe: () => tui,
    styler: () => plainPaneStyler,
    renderFileBody: () => [],
    listTurns: () => [],
  });
  const fire = async (event: string, payload: RuntimeValue = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const run = async (args = "") => {
    const command = commands.get("diff");
    assert.ok(command);
    await command.handler(args, ctx);
  };
  const store = (index = -1): SourceStore => {
    const value = stores.at(index);
    assert.ok(value, "a store exists");
    return value;
  };
  const docked = () => viewport.root.children[0] instanceof HStack;
  const header = () => {
    const view = probe.session()?.view;
    assert.ok(view, "a view exists");
    return view.renderHeader(120, false).join("\n");
  };
  const body = () => {
    const view = probe.session()?.view;
    assert.ok(view, "a view exists");
    return view.renderBody(120, false).join("\n");
  };
  /** Let the controller's promise chains settle and run due timers. */
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      for (const [id, timer] of clock.timers) {
        clock.timers.delete(id);
        timer.fn();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  return {
    fire,
    run,
    fakePi,
    shortcuts,
    commands,
    ctx,
    tui,
    viewport,
    stores,
    store,
    world,
    files,
    notices,
    probe,
    docked,
    header,
    body,
    settle,
  };
}

/* ------------------------------------------------------------ the source */

test("bare /diff, open, focus and the toggle shortcut open on the session source and name its baseline", async () => {
  const h = setup({ world: new Map([["session", ["b.txt"]]]) });
  await h.fire("session_start", { reason: "startup" });
  await h.run("");
  assert.ok(h.docked(), "docked beside the transcript");
  assert.deepEqual(
    h.store().initial,
    { kind: "session" },
    "the store starts on the session source",
  );
  h.store().requestRefresh("manual");
  assert.match(h.header(), /^╭─ Diff · Session changes ─+ \d+ files? – \+\d+ -\d+ ─╮/u);
  assert.match(h.header(), /╰─+ (\? help – )?main ─╯$/mu, "the branch on the bottom border");
  assert.match(h.header(), /Baseline: checkpoint before turn 1 \(edit b please\)/u);
  assert.match(h.body(), /b\.txt/u);

  await h.run("close");
  const toggle = h.shortcuts.get(TOGGLE_SHORTCUT);
  assert.ok(toggle);
  await toggle.handler(h.ctx);
  assert.ok(h.docked(), "the shortcut opens it");
  assert.equal(h.store().source.kind, "session");
  await toggle.handler(h.ctx);
  await h.run("focus");
  assert.equal(h.store().source.kind, "session");
});

test("an explicit source applies until the pane closes and is never remembered", async () => {
  const world = new Map([
    ["session", ["b.txt"]],
    ["uncommitted", ["a.txt", "b.txt"]],
  ]);
  const h = setup({ world });
  await h.fire("session_start", { reason: "startup" });
  await h.run("source uncommitted");
  assert.ok(h.docked(), "/diff source opens the pane when it is closed");
  assert.match(h.header(), /^╭─ Diff · Uncommitted changes /u);
  assert.match(h.body(), /a\.txt[\s\S]*b\.txt/u);
  await h.fire("tool_execution_end", { toolName: "edit" });
  assert.equal(h.store().source.kind, "uncommitted", "a refresh keeps the explicit source");

  await h.run("");
  assert.equal(h.docked(), false);
  assert.equal(h.store().source.kind, "session", "closing returns the store to the session source");
  await h.run("");
  assert.match(h.header(), /^╭─ Diff · Session changes /u);
  assert.doesNotMatch(h.header(), /Diff source: Uncommitted/u, "no stale source message");
  assert.doesNotMatch(h.body(), /a\.txt/u);

  await h.run("source uncommitted");
  await h.run("source session");
  assert.equal(h.store().source.kind, "session", "/diff source session returns explicitly");
  assert.match(h.header(), /^╭─ Diff · Session changes /u);

  await h.run("source uncommitted");
  await h.settle();
  assert.equal(h.files.get(PREFS)?.includes("uncommitted") ?? false, false, "never persisted");
  await h.fire("session_shutdown", { reason: "new" });
  await h.fire("session_start", { reason: "new" });
  await h.run("");
  assert.deepEqual(
    h.store().initial,
    { kind: "session" },
    "a new session starts on the session source",
  );
});

test("completions offer and the parser accepts the session source and the auto setting", () => {
  const values: string[] = DIFF_SUBCOMMANDS.map((item) => item.value);
  for (const value of ["source session", "source uncommitted", "auto on", "auto off"]) {
    assert.ok(values.includes(value), value);
  }
  assert.deepEqual(parseDiffCommand("source session"), {
    kind: "source",
    source: { kind: "session" },
  });
  assert.deepEqual(parseDiffCommand("auto off"), { kind: "auto", enabled: false });
  assert.deepEqual(parseDiffCommand("auto"), { kind: "auto", enabled: undefined });
  assert.equal(parseDiffCommand("auto maybe").kind, "invalid");
  assert.deepEqual(parseDiffCommand("source branch"), { kind: "source-branch", base: undefined });
});

/* ------------------------------------------------------------ preferences */

test("preferences: old files load with automatic opening on, odd values fall back, off is kept", () => {
  assert.deepEqual(parsePrefs('{"version":1,"open":true,"width":70}'), {
    open: true,
    width: 70,
    autoOpen: true,
  });
  assert.deepEqual(parsePrefs('{"version":1,"open":false,"width":60,"autoOpen":false}'), {
    open: false,
    width: 60,
    autoOpen: false,
  });
  assert.deepEqual(
    parsePrefs('{"version":1,"open":true,"width":60,"autoOpen":"no","later":1}'),
    { open: true, width: 60, autoOpen: true },
    "a non-boolean autoOpen or an unknown key keeps open and width",
  );
  assert.equal(parsePrefs('{"version":2,"open":true,"width":60}'), undefined);
  assert.equal(
    serializePrefs({ open: true, width: 56, autoOpen: true }).includes("autoOpen"),
    false,
  );
  assert.match(serializePrefs({ open: true, width: 56, autoOpen: false }), /"autoOpen":false/u);
});

test("/diff auto off stops automatic opening and is saved; /diff auto on restores it", async () => {
  const world = new Map([["session", ["b.txt"]]]);
  const h = setup({ world });
  await h.fire("session_start", { reason: "startup" });
  await h.run("auto off");
  await h.settle();
  assert.match(h.files.get(PREFS) ?? "", /"autoOpen":false/u);
  await h.fire("tool_execution_end", { toolName: "edit" });
  await h.settle();
  assert.equal(h.docked(), false, "off: nothing opens");

  const again = setup({ world, files: h.files });
  await again.fire("session_start", { reason: "startup" });
  await again.fire("tool_execution_end", { toolName: "edit" });
  await again.settle();
  assert.equal(again.docked(), false, "the saved preference applies to the next session");
  await again.run("auto on");
  await again.settle();
  assert.equal(again.files.get(PREFS)?.includes("autoOpen") ?? false, false);
  await again.fire("tool_execution_end", { toolName: "edit" });
  await again.settle();
  assert.ok(again.docked());
});

/* ------------------------------------------------------- automatic opening */

test("a file-changing tool call docks the pane without focus; read-only tools and no change do not", async () => {
  const world = new Map<string, string[]>();
  const h = setup({ world });
  await h.fire("session_start", { reason: "startup" });
  await h.fire("tool_execution_end", { toolName: "read" });
  await h.settle();
  assert.equal(h.stores.length, 0, "a read-only tool reads nothing");
  await h.fire("tool_execution_end", { toolName: "bash" });
  await h.settle();
  assert.equal(h.store().source.kind, "session", "the check reads the session source");
  assert.equal(h.docked(), false, "nothing changed in this session: stays closed");

  world.set("uncommitted", ["pre-session.txt"]);
  await h.fire("tool_execution_end", { toolName: "bash" });
  await h.settle();
  assert.equal(h.docked(), false, "changes the session source does not list never open it");

  world.set("session", ["b.txt"]);
  await h.fire("tool_execution_end", { toolName: "edit" });
  await h.settle();
  assert.ok(h.docked(), "opened by itself");
  assert.equal(h.tui.paneFocused(), false, "focus stays in the prompt editor");
  assert.equal(h.tui.overlays, 0);
  assert.match(h.header(), /^╭─ Diff · Session changes /u);
  assert.equal(h.notices.length, 0, "no inline list and no notice");
});

test("a subagent's completion can open it too", async () => {
  const h = setup({ world: new Map([["session", ["by-subagent.txt"]]]) });
  await h.fire("session_start", { reason: "startup" });
  h.fakePi.events.emit("subagents:completed", { id: "x" });
  await h.settle();
  assert.ok(h.docked());
});

test("closing stops automatic opening for the session until the user opens the pane again", async () => {
  const world = new Map([["session", ["b.txt"]]]);
  const h = setup({ world });
  await h.fire("session_start", { reason: "startup" });
  await h.fire("tool_execution_end", { toolName: "edit" });
  await h.settle();
  assert.ok(h.docked());
  await h.run("close");
  world.set("session", ["b.txt", "c.txt"]);
  await h.fire("tool_execution_end", { toolName: "edit" });
  h.fakePi.events.emit("subagents:completed", { id: "y" });
  await h.settle();
  assert.equal(h.docked(), false, "the user's close is not fought");

  await h.run("");
  assert.ok(h.docked(), "/diff opens it");
  await h.run("");
  await h.fire("tool_execution_end", { toolName: "edit" });
  await h.settle();
  assert.equal(h.docked(), false, "closed again by the user: stays closed");

  await h.run("open");
  await h.run("close");
  await h.fire("session_shutdown", { reason: "new" });
  await h.fire("session_start", { reason: "new" });
  await h.fire("tool_execution_end", { toolName: "write" });
  await h.settle();
  assert.ok(h.docked(), "a new session is armed again");
});

test("narrow terminals, regular mode and an unexpected layout never get a list or an overlay; one hint", async () => {
  const world = new Map([["session", ["b.txt"]]]);
  const narrow = setup({ world });
  narrow.tui.terminal.columns = 60;
  await narrow.fire("session_start", { reason: "startup" });
  await narrow.fire("tool_execution_end", { toolName: "edit" });
  await narrow.settle();
  await narrow.fire("tool_execution_end", { toolName: "edit" });
  await narrow.settle();
  assert.equal(narrow.docked(), false);
  assert.equal(narrow.tui.overlays, 0);
  assert.equal(narrow.notices.length, 1, "one hint, once");
  assert.match(narrow.notices[0] ?? "", /did not open by itself: the terminal is 60 columns wide/u);
  assert.doesNotMatch(narrow.notices[0] ?? "", /b\.txt/u, "no inline list");

  const regular = setup({ world });
  regular.tui.mode = "regular";
  await regular.fire("session_start", { reason: "startup" });
  await regular.fire("tool_execution_end", { toolName: "edit" });
  await regular.settle();
  assert.equal(regular.docked(), false);
  assert.match(regular.notices.join("\n"), /fullscreen mode/u);

  const odd = setup({ world, root: new VStack([new Lines(["only child"])]) });
  await odd.fire("session_start", { reason: "startup" });
  await odd.fire("tool_execution_end", { toolName: "edit" });
  await odd.settle();
  assert.equal(odd.tui.overlays, 0, "never an uninvited overlay");
  assert.equal(odd.probe.session()?.host, undefined);
  assert.match(odd.notices.join("\n"), /screen layout/u);
});

test("an overlay opened by hand says why on the pane's own message line, not behind it", async () => {
  const world = new Map([["session", ["b.txt"]]]);
  const odd = setup({ world, root: new VStack([new Lines(["only child"])]) });
  await odd.fire("session_start", { reason: "startup" });
  await odd.run("");
  assert.equal(odd.tui.overlays, 1);
  assert.match(odd.header(), /Opened as an overlay because Pi's screen layout/u);
  assert.equal(odd.notices.length, 0, "a notification would be drawn under the overlay");
  await odd.run("bogus");
  assert.match(odd.header(), /Usage/u, "a usage error while the overlay is open is in it too");
  assert.equal(odd.notices.length, 0);
});

test("print, RPC and ACP sessions never open anything by themselves", async () => {
  for (const mode of ["print", "rpc", "json"] as const) {
    const h = setup({ mode, world: new Map([["session", ["b.txt"]]]) });
    await h.fire("session_start", { reason: "startup" });
    await h.fire("tool_execution_end", { toolName: "edit" });
    h.fakePi.events.emit("subagents:completed", { id: "z" });
    await h.settle();
    assert.equal(h.stores.length, 0, mode);
    assert.equal(h.notices.length, 0, mode);
    assert.equal(h.tui.overlays, 0, mode);
  }
});

test("a session that ends while the check reads git never gets a host", async () => {
  const h = setup({ world: new Map([["session", ["b.txt"]]]) });
  h.tui.terminal.columns = 60;
  await h.fire("session_start", { reason: "startup" });
  // A first check lists a change but cannot dock (narrow), leaving a ready snapshot behind.
  await h.fire("tool_execution_end", { toolName: "bash" });
  await h.settle();
  assert.equal(h.docked(), false);
  h.tui.terminal.columns = 160;
  let release: () => void = () => {};
  h.store().gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await h.fire("tool_execution_end", { toolName: "edit" });
  await h.fire("session_shutdown", { reason: "quit" });
  release();
  await h.settle();
  assert.equal(h.docked(), false, "the ended session's check installs nothing");
  assert.equal(h.probe.session(), undefined);
});

/* ---------------------------------------------------------------- refresh */

test("in Zed, /diff sends the session's changes as native diffs, old text from the checkpoint tree", async () => {
  const sent: string[] = [];
  const bases: Array<string | null> = [];
  const snapshot = snapshotOf(1, { kind: "session" }, ["b.txt"]);
  const shown = await presentNativeDiff(
    { mode: "rpc", ui: { notify: (message) => sent.push(message) } },
    { kind: "ready", snapshot, refreshing: false },
    {
      env: { [NATIVE_DIFF_ENV]: "1" },
      clock: createSystemClock(),
      alive: () => true,
      readers: (_root, base) => {
        bases.push(base);
        return {
          readOld: async () => ({ kind: "text", text: "old\n" }),
          readNew: async () => ({ kind: "text", text: "new\n" }),
          dispose: () => {},
        };
      },
    },
  );
  assert.equal(shown, true);
  assert.deepEqual(bases, ["c0ffee"], "old text comes from the session's checkpoint tree");
  assert.equal(sent.length, 1);
  const message = sent[0] ?? "";
  assert.ok(message.startsWith(NATIVE_DIFF_NOTIFY_PREFIX));
  assert.match(message, /"title":"\/diff: session changes since turn 1 \(edit b please\) on main/u);
});

test("the open pane refreshes the session source after tools, subagents, settling, turns, and on request", async () => {
  const h = setup({ world: new Map([["session", ["b.txt"]]]) });
  await h.fire("session_start", { reason: "startup" });
  await h.run("");
  const store = h.store();
  await h.fire("tool_execution_end", { toolName: "edit" });
  await h.fire("tool_execution_end", { toolName: "bash" });
  h.fakePi.events.emit("subagents:completed", { id: "a" });
  await h.fire("agent_settled", {});
  await h.fire("turn_start", {});
  await h.run("refresh");
  const view = h.probe.session()?.view;
  assert.ok(view);
  h.probe.session()?.host?.focus();
  h.tui.input("r");
  assert.deepEqual(store.reasons, [
    "open",
    "tool",
    "tool",
    "subagent",
    "settled",
    "turn",
    "manual",
    "manual",
  ]);
  assert.equal(store.source.kind, "session");
});
