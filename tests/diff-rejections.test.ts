// No promise the /diff pane starts without awaiting it may reject unhandled:
// automatic opening, review-record and change-time reads, the notes file read, and
// the pane's key actions each contain their failure and show it.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { Container, HStack, ScrollView, VStack, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffSource } from "../.pi/extensions/lib/changes/git/model.ts";
import type { RecordsRead, RecordsReader } from "../.pi/extensions/lib/changes/findings.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  registerDiffPane,
  type DiffPaneDependencies,
} from "../.pi/extensions/diff/ui/controller.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import type { PrefsIo } from "../.pi/extensions/diff/ui/prefs.ts";
import { ChangesView } from "../.pi/extensions/lib/changes/view/changes-view.ts";
import type { PaneStyler } from "../.pi/extensions/lib/changes/view/rows.ts";
import type { FileBody } from "../.pi/extensions/lib/changes/git/model.ts";
import {
  FakeClock,
  FakeStore,
  FakeTui,
  file,
  flush,
  hunk,
  renderPlain,
  snapshot,
  textBody,
} from "./diff-actions-fakes.ts";

const STALE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.";

/** Fails the test if any promise rejects with nothing attached while it runs. */
function watchRejections(t: { after(fn: () => void): void }) {
  const seen: string[] = [];
  const listener = (reason: RuntimeValue) => {
    seen.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", listener);
  t.after(() => {
    process.off("unhandledRejection", listener);
  });
  return async (label: string) => {
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(seen.length, 0, `${label}: unhandled rejection ${seen[0] ?? ""}`);
  };
}

class Lines implements Component {
  render(): string[] {
    return ["editor"];
  }
  invalidate(): void {}
}

class BreakableTui extends FakeTui {
  renderError: Error | undefined;
  overlays = 0;
  override requestRender(): void {
    if (this.renderError) throw this.renderError;
  }
  override showOverlay(component: Component): OverlayHandle {
    this.overlays += 1;
    return super.showOverlay(component);
  }
}

/** Lists one session change on every read; counts reads; can fail a source change. */
class SessionStore extends FakeStore {
  reads = 0;
  sourceError: Error | undefined;
  override async refreshNow(): Promise<void> {
    this.reads += 1;
    this.ready(this.reads, [file("a.ts")], { kind: "session" });
  }
  override setSource(source: DiffSource): void {
    if (this.sourceError) throw this.sourceError;
    super.setSource(source);
  }
}

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue;

function setup(overrides: Partial<DiffPaneDependencies> = {}) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Array<(data: RuntimeValue) => void>>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const notices: string[] = [];
  const stores: SessionStore[] = [];
  const editor = { text: "" };
  const transcript = new ScrollView(new Container(), { follow: "end", primary: true });
  const dock = new VStack([{ component: new Lines(), shrink: 1, minSize: 3 }]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  const tui = new BreakableTui(root);
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
    registerShortcut: () => {},
  };
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    ui: {
      notify: (message: string) => notices.push(message),
      getEditorText: () => editor.text,
      setEditorText: (text: string) => {
        editor.text = text;
      },
    },
  });
  const prefsIo: PrefsIo = { read: async () => undefined, write: async () => {} };
  const probe = registerDiffPane(reinterpretHostValue<ExtensionAPI>(fakePi), {
    createStore: () => {
      const store = new SessionStore(undefined);
      stores.push(store);
      return store;
    },
    clock: new FakeClock(),
    prefsIo,
    agentDir: () => "/agent",
    probe: () => tui,
    styler: () => plainPaneStyler,
    renderFileBody: renderPlain,
    listTurns: () => [],
    ...overrides,
  });
  const fire = async (event: string, payload: RuntimeValue = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const run = async (args = "") => {
    const command = commands.get("diff");
    assert.ok(command);
    await command.handler(args, ctx);
  };
  const store = () => {
    const value = stores[0];
    assert.ok(value, "a store exists");
    return value;
  };
  const view = () => {
    const value = probe.session()?.view;
    assert.ok(value, "a view exists");
    return value;
  };
  return {
    fire,
    run,
    fakePi,
    tui,
    root,
    store,
    view,
    notices,
    editor,
    host: () => probe.session()?.host?.kind,
    docked: () => root.children[0] instanceof HStack,
    header: () => view().renderHeader(150, true).join("\n"),
    body: () => view().renderBody(150, true).join("\n"),
  };
}

function breakLayout(tui: FakeTui, error: Error): void {
  Object.defineProperty(tui, "layoutRoot", {
    configurable: true,
    get() {
      throw error;
    },
  });
}

function restoreLayout(tui: FakeTui, root: VStack): void {
  Object.defineProperty(tui, "layoutRoot", { configurable: true, writable: true, value: root });
}

/* ------------------------------------------------------- automatic opening */

test("automatic opening that throws turns itself off for the session, says so once, and /diff still opens the pane", async (t) => {
  const noRejections = watchRejections(t);
  const h = setup();
  await h.fire("session_start", { reason: "startup" });
  breakLayout(h.tui, new Error("layout moved"));
  await h.fire("tool_execution_end", { toolName: "edit" });
  await noRejections("first tool call");
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] ?? "", /could not open by itself \(layout moved\)/u);
  assert.match(h.notices[0] ?? "", /\/diff opens it/u);
  assert.equal(h.docked(), false);
  assert.equal(h.host(), undefined, "nothing half mounted");

  const reads = h.store().reads;
  await h.fire("tool_execution_end", { toolName: "write" });
  h.fakePi.events.emit("subagents:completed", {});
  await noRejections("later triggers");
  assert.equal(h.store().reads, reads, "no further git read after the failure");
  assert.equal(h.notices.length, 1, "told once");

  await h.run("");
  await noRejections("/diff by hand");
  assert.equal(h.host(), "overlay", "a user's open falls back to the overlay");
  assert.equal(h.tui.overlays, 1);

  restoreLayout(h.tui, h.root);
  await h.run("close");
  await h.run("");
  assert.ok(h.docked(), "docks by hand once the layout is back");
  await h.run("close");
  await h.fire("tool_execution_end", { toolName: "edit" });
  await noRejections("after close");
  assert.equal(h.store().reads, reads, "still off for this session");
});

test("a stale context during automatic opening is silent and stops the checks", async (t) => {
  const noRejections = watchRejections(t);
  let stale = false;
  let tui: FakeTui | undefined;
  const h = setup({
    probe: () => {
      if (stale) throw new Error(STALE);
      return tui;
    },
  });
  tui = h.tui;
  await h.fire("session_start", { reason: "startup" });
  stale = true;
  await h.fire("tool_execution_end", { toolName: "edit" });
  await noRejections("stale probe");
  assert.equal(h.notices.length, 0, "nothing to tell a session that ended");
  const reads = h.store().reads;
  assert.equal(reads, 1);
  await h.fire("tool_execution_end", { toolName: "edit" });
  await noRejections("second tool call");
  assert.equal(h.store().reads, reads);
});

/* ------------------------------------------------------ records and times */

function reviewListing(path: string): RecordsRead {
  return {
    errors: [],
    tasks: [
      {
        workTask: "wt-a",
        invalid: [],
        records: [
          {
            schema: 1,
            agentId: "rev-1",
            agentType: "reviewer",
            workTask: "wt-a",
            completedAt: "2026-01-01T00:00:00.000Z",
            status: "parsed",
            review: {
              schema: 1,
              verdict: "FINDINGS",
              bundleDigest: "sha256:abc",
              findings: [
                {
                  id: "F1",
                  class: "finding",
                  severity: "high",
                  path,
                  invariant: "F1 invariant",
                  evidence: "code_path",
                  reproduction: "",
                  startLine: 1,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test("a review-record read that throws keeps the pane and shows a read error; the next refresh reads it", async (t) => {
  const noRejections = watchRejections(t);
  let scratchFails = true;
  let rejectWith: { value: RuntimeValue } | undefined;
  const reader: RecordsReader = async () => {
    if (rejectWith) throw rejectWith.value;
    return reviewListing("a.ts");
  };
  const h = setup({
    scratchDir: () => {
      if (scratchFails) throw new Error("no scratch directory");
      return "/scratch";
    },
    readRecords: reader,
  });
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  await noRejections("scratch lookup throws");
  assert.deepEqual(h.view().recorded.errors, [
    "Cannot read the review records: no scratch directory",
  ]);
  assert.match(h.header(), /Review: 1 read error/u);

  scratchFails = false;
  rejectWith = { value: undefined };
  await h.run("refresh");
  await noRejections("reader rejects with a non-Error");
  assert.deepEqual(h.view().recorded.errors, ["Cannot read the review records: undefined"]);

  rejectWith = undefined;
  await h.run("refresh");
  await noRejections("recovered");
  assert.equal(h.view().recorded.errors.length, 0);
  assert.equal(h.view().recorded.findings.length, 1, "findings are read again");
});

test("a change-time scan that throws keeps the last findings and shows a read error", async (t) => {
  const noRejections = watchRejections(t);
  let statFails = false;
  const h = setup({
    scratchDir: () => "/scratch",
    readRecords: async () => reviewListing("a.ts"),
    fileChangedAt: (path) => {
      if (statFails) throw new Error(`cannot stat ${path}`);
      return Promise.resolve(1);
    },
  });
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  await h.store().refreshNow();
  await h.run("refresh");
  await noRejections("first read");
  assert.equal(h.view().recorded.findings.length, 1);
  assert.equal(h.view().recorded.errors.length, 0);

  statFails = true;
  await h.store().refreshNow();
  await noRejections("scan throws");
  assert.equal(h.view().recorded.findings.length, 1, "the findings last read stay");
  assert.deepEqual(h.view().recorded.errors, [
    "Cannot read the review records: cannot stat /repo/a.ts",
  ]);
  assert.match(h.header(), /Review: wt-a FINDINGS 1 finding.* · 1 read error/u);

  statFails = false;
  await h.run("refresh");
  await noRejections("recovered");
  assert.equal(h.view().recorded.errors.length, 0);
});

/* ------------------------------------------------------- notes and keys */

test("a redraw that throws while the notes file loads is reported, and the notes still load", async (t) => {
  const noRejections = watchRejections(t);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const notesIo: PrefsIo = {
    read: async () => {
      await gate;
      return JSON.stringify({
        version: 1,
        notes: [
          {
            id: "n1",
            path: "a.ts",
            hunkId: "h-a",
            range: "L1",
            text: "check this",
            createdAt: 1,
          },
        ],
      });
    },
    write: async () => {},
  };
  const h = setup({ notesIo, notesFile: () => "/scratch/notes.json" });
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  h.tui.renderError = new Error("render broke");
  release?.();
  await noRejections("notes load");
  h.tui.renderError = undefined;
  assert.ok(
    h.notices.some((notice) => /Cannot redraw the diff pane: render broke/u.test(notice)),
    "the failure is told",
  );
  h.view().handleKey("C");
  await noRejections("send notes");
  assert.match(h.editor.text, /check this/u, "the loaded note is sent");
});

test("a key action that fails shows the failure in the pane and the key works again", async (t) => {
  const noRejections = watchRejections(t);
  const h = setup();
  await h.fire("session_start", { reason: "startup" });
  await h.run("open");
  h.store().sourceError = new Error("source broke");
  h.view().handleKey("s");
  await noRejections("cycle source");
  assert.match(h.view().message?.text ?? "", /Cannot change the diff source: source broke/u);
  h.store().sourceError = undefined;
  h.view().handleKey("s");
  await noRejections("cycle source again");
  assert.match(h.view().message?.text ?? "", /Diff source:/u);

  h.view().handleKey("C");
  h.tui.renderError = new Error("render broke");
  await noRejections("send notes");
  h.tui.renderError = undefined;
  assert.ok(
    h.notices.some((notice) => /Cannot put the notes in the editor: render broke/u.test(notice)),
    "a pane that cannot draw falls back to a notice",
  );
  h.view().handleKey("C");
  await noRejections("send notes again");
  assert.match(h.view().message?.text ?? "", /No notes yet/u);
});

/* ------------------------------------------------------ the shared view */

test("a body load that rejects oddly or a redraw that throws while showing it stays inside the view", async (t) => {
  const noRejections = watchRejections(t);
  let next: () => Promise<{ revision: number; body: FileBody }> = () => Promise.reject(undefined);
  let renderError: Error | undefined;
  const view = new ChangesView({
    store: { loadFile: () => next() },
    styler: plainPaneStyler,
    renderFileBody: renderPlain,
    keyHint: "hint",
    helpLines: [],
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {
        if (renderError) throw renderError;
      },
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
  });
  t.after(() => view.dispose());
  view.setState({ kind: "ready", snapshot: snapshot(1, [file("a.ts")]), refreshing: false });
  view.handleKey("\r");
  await noRejections("non-Error rejection");
  assert.equal(view.bodies.get("a.ts")?.body.kind, "unreadable");
  assert.match(view.renderBody(80, true).join("\n"), /undefined/u);

  const body = textBody("a.ts", [hunk("h-a", 1, [" keep", "+added"])]);
  next = async () => ({ revision: 2, body });
  renderError = new Error("render broke");
  view.setState({ kind: "ready", snapshot: snapshot(2, [file("a.ts")]), refreshing: false });
  view.renderBody(80, true);
  await noRejections("redraw throws");
  renderError = undefined;
  assert.match(view.message?.text ?? "", /Cannot show a\.ts: render broke/u);

  next = async () => ({ revision: 3, body });
  view.setState({ kind: "ready", snapshot: snapshot(3, [file("a.ts")]), refreshing: false });
  view.renderBody(80, true);
  await noRejections("recovered");
  assert.match(view.renderBody(80, true).join("\n"), /added/u, "the body shows afterwards");
});

/* ----------------------------------------------- the controller's response */

/** The docked pane's body and header, found in the layout the harness gives the dock host. */
function dockedPane(root: VStack) {
  const row = root.children[0];
  if (!(row instanceof HStack)) return undefined;
  const box = row.children[2];
  if (!(box instanceof VStack)) return undefined;
  const header = box.children[0];
  const scroll = box.children[1];
  return header && scroll ? { header, scroll } : undefined;
}

test("a view render that throws (a host-supplied styler) closes the pane once, returns focus, and /diff opens it again", async (t) => {
  const noRejections = watchRejections(t);
  let broken = false;
  let calls = 0;
  const styler: PaneStyler = {
    ...plainPaneStyler,
    fg: (_color, text) => {
      calls += 1;
      if (broken) throw new Error("styler \u001b[31mbroke\nmore");
      return text;
    },
  };
  const h = setup({ styler: () => styler });
  await h.fire("session_start", { reason: "startup" });
  await h.run("");
  const pane = dockedPane(h.root);
  assert.ok(pane, "docked");
  h.view().handleKey("\t");
  broken = true;
  const fallback = pane.header.render(60);
  assert.equal(fallback.length, 1);
  assert.ok(visibleWidth(fallback[0] ?? "") <= 60);
  const after = calls;
  for (let frame = 0; frame < 60; frame += 1) pane.header.render(60);
  assert.equal(calls, after, "the failing path is not called again");
  await noRejections("render failure");
  assert.equal(h.docked(), false, "closed");
  assert.equal(h.host(), undefined);
  assert.equal(h.tui.focused, h.tui.editor, "focus is back in the editor");
  const told = h.notices.filter((notice) => notice.includes("could not be drawn"));
  assert.equal(told.length, 1);
  assert.equal((told[0] ?? "").includes("\u001b"), false);

  const reads = h.store().reads;
  await h.fire("tool_execution_end", { toolName: "edit" });
  await noRejections("next edit");
  assert.equal(h.docked(), false, "it does not open by itself again");
  assert.equal(h.store().reads, reads);

  broken = false;
  await h.run("");
  assert.ok(h.docked(), "/diff by hand opens it");
  const header = dockedPane(h.root)?.header.render(60) ?? [];
  assert.equal(
    header.some((line) => line.includes("could not be drawn")),
    false,
    "and it draws",
  );
});

test("a key that throws in the pane is shown on its line and focus returns to the editor", async (t) => {
  const noRejections = watchRejections(t);
  const h = setup();
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  assert.notEqual(h.tui.focused, h.tui.editor);
  const body = h.tui.focused;
  assert.ok(body?.handleInput);
  h.tui.renderError = new Error("render request broke");
  assert.doesNotThrow(() => body.handleInput?.("j"));
  h.tui.renderError = undefined;
  await noRejections("key");
  assert.equal(h.tui.focused, h.tui.editor);
  assert.match(
    h.view().message?.text ?? "",
    /A key in the diff pane failed: render request broke/u,
  );
  assert.ok(h.docked(), "the pane stays; its close key and /diff close still work");
  await h.run("close");
  assert.equal(h.docked(), false);
});
