// Shared fakes for the diff-actions-* and diff-findings-* suites (not a test file itself).
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TuiInputListener, TuiMode } from "@earendil-works/pi-tui";
import { Container, ScrollView, VStack, isFocusable } from "@earendil-works/pi-tui";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type {
  DiffHunk,
  DiffLine,
  SessionCheckpointProvider,
} from "../.pi/extensions/review/core/types.ts";
import type { TurnCheckpointInfo } from "../.pi/extensions/diff/core/checkpoints.ts";
import type { DiffClock } from "../.pi/extensions/lib/changes/git/clock.ts";
import type { RecordsReader } from "../.pi/extensions/lib/changes/findings.ts";
import type {
  DiffSnapshot,
  DiffSource,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileSummary,
  RefreshReason,
} from "../.pi/extensions/lib/changes/git/model.ts";
import type { PaneTui } from "../.pi/extensions/diff/host/types.ts";
import {
  registerDiffPane,
  type DiffPaneDependencies,
} from "../.pi/extensions/diff/ui/controller.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import type { FileBodyRenderer } from "../.pi/extensions/diff/ui/pane-view.ts";
import type { PrefsIo } from "../.pi/extensions/diff/ui/prefs.ts";

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

export class FakeClock implements DiffClock {
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
}

export class FakeTui implements PaneTui {
  mode: TuiMode = "fullscreen";
  terminal = { columns: 160, rows: 60 };
  children: Component[] = [];
  layoutRoot: RuntimeValue;
  focused: Component | null;
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
  showOverlay(component: Component): OverlayHandle {
    return {
      hide: () => {},
      setHidden: () => {},
      isHidden: () => false,
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
  input(data: string): void {
    for (const listener of this.listeners) if (listener(data)?.consume) return;
    this.focused?.handleInput?.(data);
  }
  type(text: string): void {
    for (const character of text) this.input(character);
  }
  paneFocused(): boolean {
    return this.focused !== this.editor;
  }
}

export function file(path: string, overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

export function snapshot(
  revision: number,
  files: FileSummary[],
  source: DiffSource = { kind: "uncommitted" },
): DiffSnapshot {
  return {
    revision,
    source,
    repoRoot: "/repo",
    head: "abc",
    branch: "main",
    base: "abc",
    capturedAt: 0,
    files,
    totals: { files: files.length, additions: files.length, deletions: 0 },
    omittedFiles: 0,
  };
}

/** A hunk whose lines are context except the `+`/`-` prefixed ones; new-file numbering from `newStart`. */
export function hunk(id: string, newStart: number, body: string[]): DiffHunk {
  let oldLine = newStart;
  let newLine = newStart;
  const lines: DiffLine[] = body.map((raw) => {
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") return { kind: "add", newLine: newLine++, text };
    if (marker === "-") return { kind: "del", oldLine: oldLine++, text };
    return { kind: "context", oldLine: oldLine++, newLine: newLine++, text };
  });
  const newLines = lines.filter((line) => line.newLine !== undefined).length;
  const oldLines = lines.filter((line) => line.oldLine !== undefined).length;
  return {
    id,
    header: `@@ -${newStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart: newStart,
    oldLines,
    newStart,
    newLines,
    lines,
  };
}

export function textBody(path: string, hunks: DiffHunk[]): FileBody {
  return {
    kind: "text",
    file: { path, kind: "modified", hunks, additions: 1, deletions: 0 },
  };
}

export class FakeStore implements DiffStore {
  state: DiffStoreState = { kind: "idle" };
  listeners = new Set<(state: DiffStoreState) => void>();
  reasons: RefreshReason[] = [];
  sources: DiffSource[] = [];
  loads: string[] = [];
  bodies = new Map<string, FileBody>();
  /**
   * While true, loads wait in `held` until released. Like the real store (see the
   * contract test in changes-store-contract.test.ts), a load answers with the revision
   * and body current when it began, whenever it is released.
   */
  holdLoads = false;
  held: Array<{ path: string; revision: number; release(): void }> = [];
  readonly checkpoints: SessionCheckpointProvider | undefined;
  constructor(checkpoints: SessionCheckpointProvider | undefined) {
    this.checkpoints = checkpoints;
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
  ready(revision: number, files: FileSummary[], source?: DiffSource): void {
    this.emit({ kind: "ready", snapshot: snapshot(revision, files, source), refreshing: false });
  }
  requestRefresh(reason: RefreshReason): void {
    this.reasons.push(reason);
  }
  async refreshNow(): Promise<void> {}
  async loadFile(path: string): Promise<{ revision: number; body: FileBody }> {
    this.loads.push(path);
    const revision = this.state.kind === "ready" ? this.state.snapshot.revision : 0;
    const result = { revision, body: this.bodies.get(path) ?? { kind: "gone" as const } };
    if (!this.holdLoads) return result;
    return new Promise((resolve) => {
      this.held.push({ path, revision, release: () => resolve(result) });
    });
  }
  /** Like the real store: the next snapshot carries the new source. */
  setSource(source: DiffSource): void {
    this.sources.push(source);
    const state = this.state;
    if (state.kind !== "ready") return;
    this.ready(state.snapshot.revision + 1, state.snapshot.files, source);
  }
  setVisible(): void {}
  dispose(): void {
    this.listeners.clear();
  }
}

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue;

export type HarnessOptions = {
  mode?: ExtensionContext["mode"];
  turns?: TurnCheckpointInfo[];
  readRecords?: RecordsReader;
  scratchDir?: string;
  changeTimes?: Map<string, number | null>;
  editorText?: string;
  notesIo?: PrefsIo;
  /** Defaults to {@link renderPlain}; pass the production renderer to test it. */
  renderFileBody?: FileBodyRenderer;
  /** The clipboard write fails with this message. */
  clipboardError?: string;
  /** No clipboard is wired. */
  noClipboard?: boolean;
};

/** Plain unified rendering: the hunk header, then one `newLine|text` line per diff line. */
export function renderPlain(diffFile: { hunks: DiffHunk[] }): string[] {
  return diffFile.hunks.flatMap((entry) => [
    entry.header,
    ...entry.lines.map((line) => `${line.newLine ?? "-"}|${line.text}`),
  ]);
}

export function harness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Array<(data: RuntimeValue) => void>>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const notices: string[] = [];
  const stores: FakeStore[] = [];
  const clock = new FakeClock();
  const editor = { text: options.editorText ?? "", sets: 0 };
  const transcript = new ScrollView(new Container(), { follow: "end", primary: true });
  const dock = new VStack([{ component: new Lines(["editor"]), shrink: 1, minSize: 3 }]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  const tui = new FakeTui(root);
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
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: "/repo",
    ui: {
      notify: (message: string) => notices.push(message),
      getEditorText: () => editor.text,
      setEditorText: (text: string) => {
        editor.text = text;
        editor.sets += 1;
      },
    },
  });
  const deps: DiffPaneDependencies = {
    createStore: (_cwd, checkpoints) => {
      const store = new FakeStore(checkpoints);
      stores.push(store);
      return store;
    },
    clock,
    prefsIo: { read: async () => undefined, write: async () => {} },
    agentDir: () => "/agent",
    probe: () => tui,
    styler: () => plainPaneStyler,
    renderFileBody: options.renderFileBody ?? renderPlain,
    listTurns: () => options.turns ?? [],
    scratchDir: () => options.scratchDir,
    fileChangedAt: async (path) => {
      const relative = path.startsWith("/repo/") ? path.slice("/repo/".length) : path;
      return options.changeTimes?.get(relative) ?? null;
    },
    notesFile: () => "/scratch/diff-notes/session.json",
  };
  /** What the pane put on the clipboard, oldest first. */
  const copied: string[] = [];
  if (!options.noClipboard) {
    deps.copyText = async (text) => {
      if (options.clipboardError) throw new Error(options.clipboardError);
      copied.push(text);
    };
  }
  if (options.readRecords) deps.readRecords = options.readRecords;
  if (options.notesIo) deps.notesIo = options.notesIo;
  const probe = registerDiffPane(reinterpretHostValue<ExtensionAPI>(fakePi), deps);
  const fire = async (event: string, payload: RuntimeValue = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const run = async (args = "") => {
    const command = commands.get("diff");
    assert.ok(command);
    await command.handler(args, ctx);
  };
  const store = (): FakeStore => {
    const value = stores[0];
    assert.ok(value, "a store exists");
    return value;
  };
  const view = () => {
    const value = probe.session()?.view;
    assert.ok(value, "a view exists");
    return value;
  };
  const header = () => view().renderHeader(150, true).join("\n");
  const body = () => view().renderBody(150, true).join("\n");
  return {
    fire,
    run,
    fakePi,
    ctx,
    tui,
    clock,
    stores,
    store,
    view,
    header,
    body,
    notices,
    editor,
    probe,
    copied,
  };
}

/** Let promise callbacks and real file reads run. */
export async function until(condition: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

export async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
