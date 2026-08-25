import assert from "node:assert/strict";
import test from "node:test";

import type { ShellChangeEvent, ShellResult } from "../src/shell-manager.ts";
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

  onChange(listener: (event: ShellChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ShellChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

interface WidgetCall {
  key: string;
  content: ((tui: ShellsWidgetTUI, theme: ShellsWidgetTheme) => ShellsWidgetComponent) | undefined;
  placement?: "aboveEditor" | "belowEditor";
}

class UIFixture implements ShellsWidgetUICtx {
  readonly calls: WidgetCall[] = [];
  renders = 0;

  setWidget(
    key: string,
    content:
      | undefined
      | ((tui: ShellsWidgetTUI, theme: ShellsWidgetTheme) => ShellsWidgetComponent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    this.calls.push({ key, content, placement: options?.placement });
  }

  lines(): string[] {
    const registration = this.calls.findLast((call) => call.content !== undefined);
    assert.ok(registration?.content);
    const component = registration.content({ requestRender: () => this.renders++ }, theme);
    return component.render();
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
  manager.emit({ type: "end", shell: shell({ state: "exited", endedAt: 0 }) });
  const registration = ui.calls.findLast((call) => call.content !== undefined);
  assert.ok(registration?.content);
  const component = registration.content({ requestRender: () => ui.renders++ }, theme);

  component.invalidate();
  now = 25;
  await wait(15);

  assert.equal(ui.calls.at(-1)?.key, "shells");
  assert.equal(ui.calls.at(-1)?.content, undefined);
  widget.dispose();
});
