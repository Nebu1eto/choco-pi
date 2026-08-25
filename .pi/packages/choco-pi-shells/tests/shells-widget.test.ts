import assert from "node:assert/strict";
import test from "node:test";

import { Editor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type { ShellChangeEvent, ShellResult, StopShellInput } from "../src/shell-manager.ts";
import {
  ShellsWidget,
  type ShellsWidgetComponent,
  type ShellsWidgetManager,
  type ShellsWidgetTheme,
  type ShellsWidgetTUI,
  type ShellsWidgetUICtx,
} from "../src/ui/shells-widget.ts";

const theme: ShellsWidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

class ManagerFixture implements ShellsWidgetManager {
  readonly listeners = new Set<(event: ShellChangeEvent) => void>();
  readonly stopCalls: StopShellInput[] = [];
  stopResult: (input: StopShellInput) => Promise<ShellResult> = async (input) =>
    shell({ shellId: input.shellId, state: "stopped", endedAt: Date.now() });

  onChange(listener: (event: ShellChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ShellChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  stop(input: StopShellInput): Promise<ShellResult> {
    this.stopCalls.push(input);
    return this.stopResult(input);
  }
}

interface WidgetCall {
  key: string;
  content: ((tui: ShellsWidgetTUI, theme: ShellsWidgetTheme) => ShellsWidgetComponent) | undefined;
  placement?: "aboveEditor" | "belowEditor";
}

class UIFixture implements ShellsWidgetUICtx {
  readonly calls: WidgetCall[] = [];
  readonly notices: Array<{ message: string; type?: string }> = [];
  readonly inputHandlers = new Set<
    (data: string) => { consume?: boolean; data?: string } | undefined
  >();
  renders = 0;
  editorText = "";
  // SAFETY: Editor identity is the only tested invariant; no Editor methods are invoked.
  readonly editor = Object.create(Editor.prototype) as Editor;
  focusedComponent: unknown = this.editor;
  overlayVisible = false;

  setWidget(
    key: string,
    content:
      | undefined
      | ((tui: ShellsWidgetTUI, theme: ShellsWidgetTheme) => ShellsWidgetComponent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    this.calls.push({ key, content, placement: options?.placement });
  }

  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void {
    this.inputHandlers.add(handler);
    return () => this.inputHandlers.delete(handler);
  }

  getEditorText(): string {
    return this.editorText;
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notices.push({ message, type });
  }

  send(data: string): { consume?: boolean; data?: string } | undefined {
    assert.equal(this.inputHandlers.size, 1);
    const [handler] = this.inputHandlers;
    return handler?.(data);
  }

  lines(width = 120): string[] {
    const registration = this.calls.findLast((call) => call.content !== undefined);
    assert.ok(registration?.content);
    const component = registration.content(
      {
        requestRender: () => this.renders++,
        focusedComponent: this.focusedComponent,
        hasOverlay: () => this.overlayVisible,
      },
      theme,
    );
    return component.render(width);
  }
}

function shell(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    shellId: "shell-1",
    ownerId: "root",
    command: "printf hello",
    cwd: "/tmp",
    state: "running",
    pid: 1234,
    startedAt: Date.now() - 500,
    ...overrides,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

test("registers automatically for a non-root owner's start event", () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);

  manager.emit({
    type: "start",
    shell: shell({ ownerId: "nested-session", name: "worker shell" }),
  });

  assert.deepEqual(
    ui.calls.map(({ key, placement, content }) => ({ key, placement, registered: !!content })),
    [{ key: "shells", placement: "aboveEditor", registered: true }],
  );
  const text = ui.lines().join("\n");
  assert.match(text, /^● Shells/m);
  assert.match(text, /worker shell/);
  assert.match(text, /owner:nested-session/);
  assert.match(text, /pid 1234 · 0\.\ds/);
  assert.match(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  widget.dispose();
});

test("renders explicit exited, stopped, and failed statuses", () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);
  const endedAt = Date.now();

  manager.emit({
    type: "end",
    shell: shell({ shellId: "exited", state: "exited", exitCode: 7, endedAt }),
  });
  manager.emit({
    type: "end",
    shell: shell({ shellId: "stopped", state: "stopped", endedAt }),
  });
  manager.emit({
    type: "end",
    shell: shell({ shellId: "failed", state: "failed", error: "spawn failed", endedAt }),
  });

  const text = ui.lines().join("\n");
  assert.match(text, /✓ exited.*exit 7/);
  assert.match(text, /■ stopped/);
  assert.match(text, /✗ failed.*spawn failed/);
  widget.dispose();
});

test("lingers settled rows, then unregisters the empty widget", async () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root", { lingerMs: 25, refreshMs: 5 });
  widget.setUICtx(ui);
  manager.emit({ type: "end", shell: shell({ state: "exited", endedAt: Date.now() }) });

  assert.match(ui.lines().join("\n"), /✓ exited/);
  await wait(50);

  assert.equal(ui.calls.at(-1)?.key, "shells");
  assert.equal(ui.calls.at(-1)?.content, undefined);
  widget.dispose();
});

test("setUICtx unregisters the predecessor and force-registers its replacement", () => {
  const manager = new ManagerFixture();
  const first = new UIFixture();
  const second = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(first);
  manager.emit({ type: "start", shell: shell() });

  widget.setUICtx(second);

  assert.equal(first.calls.at(-1)?.content, undefined);
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0]?.key, "shells");
  assert.equal(second.calls[0]?.placement, "aboveEditor");
  assert.ok(second.calls[0]?.content);
  widget.dispose();
});

test("dispose removes its listener, timer, and registered widget", async () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root", { refreshMs: 5 });
  widget.setUICtx(ui);
  manager.emit({ type: "start", shell: shell() });
  ui.lines();
  assert.equal(manager.listeners.size, 1);

  widget.dispose();
  const callsAfterDispose = ui.calls.length;
  const rendersAfterDispose = ui.renders;
  manager.emit({ type: "start", shell: shell({ shellId: "late" }) });
  await wait(20);

  assert.equal(manager.listeners.size, 0);
  assert.equal(ui.calls.at(-1)?.content, undefined);
  assert.equal(ui.calls.length, callsAfterDispose);
  assert.equal(ui.renders, rendersAfterDispose);
});

test("invalidate near linger expiry still unregisters the widget", async () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  let now = 0;
  const widget = new ShellsWidget(manager, "root", {
    lingerMs: 25,
    refreshMs: 5,
    now: () => now,
  });
  widget.setUICtx(ui);
  manager.emit({ type: "start", shell: shell() });
  const registration = ui.calls.findLast((call) => call.content !== undefined);
  assert.ok(registration?.content);
  const component = registration.content({ requestRender: () => ui.renders++ }, theme);

  component.invalidate();
  now = 5;
  manager.emit({ type: "end", shell: shell({ state: "exited", endedAt: 5 }) });
  assert.equal(ui.renders, 0, "the stale TUI is not asked to render");
  assert.equal(ui.calls.filter((call) => call.content !== undefined).length, 2);
  assert.match(ui.lines().join("\n"), /✓ exited/);

  now = 30;
  await wait(15);

  assert.equal(ui.calls.at(-1)?.key, "shells");
  assert.equal(ui.calls.at(-1)?.content, undefined);
  widget.dispose();
});

test("sanitizes and bounds shell-controlled widget metadata", () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);
  manager.emit({
    type: "start",
    shell: shell({
      shellId: "named",
      name: `name\x1b[31m-red\x1b[0m\nnext\x07${"n".repeat(100)}`,
      ownerId: `nested\x1b[2J\nowner\x07${"o".repeat(100)}`,
    }),
  });
  manager.emit({
    type: "start",
    shell: shell({
      shellId: "commanded",
      name: undefined,
      command: `printf\x1b[31m red\x1b[0m\nnext\x07 ${"c".repeat(100)}`,
    }),
  });

  const lines = ui.lines();
  assert.ok(
    lines.every((line) =>
      Array.from(line).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
      }),
    ),
  );
  assert.ok(lines.every((line) => line.length < 140));
  assert.match(lines.join("\n"), /name-rednext/);
  assert.match(lines.join("\n"), /printf rednext/);
  assert.equal(lines.join("\n").includes("\x1b"), false);
  assert.equal(lines.join("\n").includes("\x07"), false);
  widget.dispose();
});

test("activates only from an empty focused prompt with visible rows", () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);

  assert.equal(ui.send("\x1b[B"), undefined);
  manager.emit({ type: "start", shell: shell() });
  ui.editorText = "draft";
  assert.equal(ui.send("\x1b[B"), undefined);
  ui.editorText = "";
  ui.focusedComponent = {};
  ui.lines();
  assert.equal(ui.send("\x1b[B"), undefined);
  assert.doesNotMatch(ui.lines().join("\n"), /›/);

  ui.focusedComponent = ui.editor;
  ui.lines();
  assert.deepEqual(ui.send("\x1b[B"), { consume: true });
  assert.match(ui.lines().join("\n"), /›.*printf hello/);
  assert.match(ui.lines().join("\n"), /Status: running · Runtime:/);
  assert.match(ui.lines().join("\n"), /Command: printf hello/);
  assert.match(ui.lines().join("\n"), /Cwd: \/tmp/);
  assert.match(ui.lines().join("\n"), /x stop · Esc back/);
  widget.dispose();
});

test("requires a live editor-owned TUI and yields during visible overlays", () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);
  manager.emit({ type: "start", shell: shell() });

  assert.equal(ui.send("\x1b[B"), undefined, "registration alone has no live TUI");
  ui.lines();
  ui.overlayVisible = true;
  assert.equal(ui.send("\x1b[B"), undefined);
  ui.overlayVisible = false;
  ui.focusedComponent = {};
  ui.lines();
  assert.equal(ui.send("\x1b[B"), undefined, "dialogs are not editors");

  ui.focusedComponent = ui.editor;
  ui.lines();
  assert.deepEqual(ui.send("\x1b[B"), { consume: true });
  ui.overlayVisible = true;
  assert.equal(ui.send("x"), undefined, "an overlay takes action-key ownership");
  assert.equal(manager.stopCalls.length, 0);
  assert.doesNotMatch(ui.lines().join("\n"), /›/);
  widget.dispose();
});

test("coordinates shell and agent fleet ownership through the optional registry", () => {
  const key = Symbol.for("pi-subagents:manager");
  // SAFETY: This test owns and restores the exact symbol-keyed registry entry in finally.
  const processRegistry = globalThis as typeof globalThis & {
    [registryKey: symbol]: { hasFleetRows(): boolean; isFleetActive(): boolean } | undefined;
  };
  const previous = processRegistry[key];
  let fleetRows = true;
  let fleetActive = false;
  const agentKeys: string[] = [];
  processRegistry[key] = {
    hasFleetRows: () => fleetRows,
    isFleetActive: () => fleetActive,
  };

  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  const dispatch = (data: string): "shell" | "agent" | undefined => {
    const shellResult = ui.send(data);
    if (shellResult?.consume) return "shell";
    const activatesAgent = data === "\x1b[B" || data === "\x1b[D";
    if (!fleetActive && activatesAgent) fleetActive = true;
    if (!fleetActive) return undefined;
    agentKeys.push(data);
    if (data === "\x1b") fleetActive = false;
    return "agent";
  };

  try {
    widget.setUICtx(ui);
    manager.emit({ type: "start", shell: shell() });
    assert.match(ui.lines().join("\n"), /→ manage/);

    assert.equal(dispatch("\x1b[B"), "agent", "visible agents retain Down activation");
    assert.equal(dispatch("\x1b"), "agent");
    assert.equal(dispatch("\x1b[C"), "shell", "Right activates shell navigation");
    assert.match(ui.lines().join("\n"), /›.*printf hello/);

    assert.equal(dispatch("\x1b[D"), "agent", "Left transfers ownership to agents");
    assert.doesNotMatch(ui.lines().join("\n"), /›/);
    assert.equal(dispatch("x"), "agent", "agent-active x bypasses shell actions");
    assert.equal(dispatch("\x1b"), "agent", "agent-active Esc bypasses shell navigation");
    assert.equal(manager.stopCalls.length, 0);
    assert.deepEqual(agentKeys, ["\x1b[B", "\x1b", "\x1b[D", "x", "\x1b"]);

    fleetRows = false;
    assert.equal(dispatch("\x1b[B"), "shell", "shell-only Down still activates shells");
  } finally {
    widget.dispose();
    if (previous === undefined) delete processRegistry[key];
    else processRegistry[key] = previous;
  }
});

test("navigates by shell id, ignores key releases, and exits on Esc or pass-through", () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);
  manager.emit({ type: "start", shell: shell({ shellId: "first", name: "first" }) });
  manager.emit({ type: "start", shell: shell({ shellId: "second", name: "second" }) });
  ui.lines();

  assert.deepEqual(ui.send("\x1b[B"), { consume: true });
  assert.equal(ui.send("\x1b[1;1:3B"), undefined);
  assert.match(ui.lines().join("\n"), /›.*first/);
  assert.deepEqual(ui.send("\x1b[B"), { consume: true });
  assert.match(ui.lines().join("\n"), /›.*second/);
  assert.deepEqual(ui.send("\x1b[A"), { consume: true });
  assert.match(ui.lines().join("\n"), /›.*first/);

  assert.deepEqual(ui.send("\x1b"), { consume: true });
  assert.doesNotMatch(ui.lines().join("\n"), /›/);
  assert.deepEqual(ui.send("\x1b[B"), { consume: true });
  assert.equal(ui.send("a"), undefined);
  assert.doesNotMatch(ui.lines().join("\n"), /›/);
  widget.dispose();
});

test("stops a selected nested-owned shell immediately with root admin authority", async () => {
  const manager = new ManagerFixture();
  const pending = deferred<ShellResult>();
  manager.stopResult = () => pending.promise;
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root-session");
  widget.setUICtx(ui);
  manager.emit({
    type: "start",
    shell: shell({ shellId: "nested-shell", ownerId: "nested-session" }),
  });
  ui.lines();
  ui.send("\x1b[B");

  assert.deepEqual(ui.send("x"), { consume: true });
  assert.deepEqual(manager.stopCalls, [
    { requesterId: "root-session", isAdmin: true, shellId: "nested-shell" },
  ]);
  assert.match(ui.lines().join("\n"), /stopping…/);
  ui.send("x");
  assert.equal(manager.stopCalls.length, 1);

  pending.resolve(shell({ shellId: "nested-shell", state: "stopped", endedAt: Date.now() }));
  await pending.promise;
  await Promise.resolve();
  assert.doesNotMatch(ui.lines().join("\n"), /stopping…/);
  widget.dispose();
});

test("contains stop rejection and renders a sanitized bounded error", async () => {
  const manager = new ManagerFixture();
  const pending = deferred<ShellResult>();
  manager.stopResult = () => pending.promise;
  const ui = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(ui);
  manager.emit({
    type: "start",
    shell: shell({
      shellId: `id\x1b[2J\n${"i".repeat(100)}`,
      cwd: `/tmp\x07\n${"d".repeat(100)}`,
      command: `run\x1b[31m\n${"c".repeat(100)}`,
    }),
  });
  ui.lines();
  ui.send("\x1b[B");
  ui.send("x");
  pending.reject(new Error(`denied\x1b[31m\n${"e".repeat(100)}`));
  await pending.promise.catch(() => undefined);
  await Promise.resolve();

  const lines = ui.lines(44);
  const text = lines.map((line) => stripTerminalSequences(line)).join("\n");
  assert.ok(lines.every((line) => visibleWidth(line) <= 44));
  assert.equal(text.includes("\x1b"), false);
  assert.equal(text.includes("\x07"), false);
  assert.match(text, /stop failed: denied/);
  widget.dispose();
});

test("keeps keyed selection across starts and clamps it after selected expiry", async () => {
  const manager = new ManagerFixture();
  const ui = new UIFixture();
  let now = 0;
  const widget = new ShellsWidget(manager, "root", {
    lingerMs: 10,
    refreshMs: 5,
    now: () => now,
  });
  widget.setUICtx(ui);
  manager.emit({ type: "start", shell: shell({ shellId: "first", name: "first" }) });
  manager.emit({ type: "start", shell: shell({ shellId: "second", name: "second" }) });
  ui.lines();
  ui.send("\x1b[B");
  ui.send("\x1b[B");
  manager.emit({ type: "start", shell: shell({ shellId: "third", name: "third" }) });
  assert.match(ui.lines().join("\n"), /›.*second/);

  manager.emit({
    type: "end",
    shell: shell({ shellId: "second", name: "second", state: "exited", endedAt: 0 }),
  });
  now = 11;
  await wait(15);
  const text = ui.lines().join("\n");
  assert.doesNotMatch(text, /second/);
  assert.match(text, /›.*third/);
  widget.dispose();
});

test("settled x is non-destructive and input listeners rebind and dispose", () => {
  const manager = new ManagerFixture();
  const first = new UIFixture();
  const second = new UIFixture();
  const widget = new ShellsWidget(manager, "root");
  widget.setUICtx(first);
  manager.emit({
    type: "end",
    shell: shell({ shellId: "done", state: "exited", endedAt: Date.now() }),
  });
  first.lines();
  first.send("\x1b[B");
  first.send("x");
  assert.equal(manager.stopCalls.length, 0);
  assert.deepEqual(first.notices, [
    { message: "Shell already settled; nothing to stop.", type: "info" },
  ]);

  widget.setUICtx(second);
  assert.equal(first.inputHandlers.size, 0);
  assert.equal(second.inputHandlers.size, 1);
  widget.dispose();
  assert.equal(second.inputHandlers.size, 0);
});
