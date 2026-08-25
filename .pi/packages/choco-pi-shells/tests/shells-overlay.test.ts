import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { ShellOutputViewer } from "../src/ui/shell-viewer.ts";
import {
  openShellsOverlay,
  type ShellStreamChunk,
  type ShellSummary,
  type ShellCustomOptions,
  type ShellsManager,
  ShellsOverlay,
  type ShellsUICtx,
  type ShellViewerKeybindings,
} from "../src/ui/shells-overlay.ts";

// SAFETY: These components exercise only Theme.fg; the fixture supplies that exact method.
const theme = { fg: (_color: string, text: string) => text } as Theme;

function tui(rows = 30): TUI & { renders: number } {
  const fixture = {
    terminal: { rows },
    renders: 0,
    requestRender() {
      fixture.renders += 1;
    },
  };
  // SAFETY: UI code under test reads terminal.rows and calls requestRender only.
  return fixture as TUI & { renders: number };
}

function shell(id: string, state: ShellSummary["state"] = "running"): ShellSummary {
  return {
    shellId: id,
    ownerId: `owner-${id}`,
    name: `shell-${id}`,
    command: `command-${id}`,
    cwd: "/tmp",
    state,
    pid: 100 + Number(id),
    startedAt: Date.now() - 2_000,
  };
}

function chunk(data: string, startOffset = 0, dropped = false): ShellStreamChunk {
  const nextOffset = startOffset + Buffer.byteLength(data);
  return { data, startOffset, nextOffset, endOffset: nextOffset, dropped };
}

function managerFixture(shells: ShellSummary[]): ShellsManager & {
  stopCalls: string[];
  readCalls: Array<{ stdoutOffset?: number; stderrOffset?: number }>;
} {
  const stopCalls: string[] = [];
  const readCalls: Array<{ stdoutOffset?: number; stderrOffset?: number }> = [];
  const fixture = {
    stopCalls,
    readCalls,
    list: () => ({ shells }),
    read(input: { stdoutOffset?: number; stderrOffset?: number; shellId: string }) {
      fixture.readCalls.push({
        stdoutOffset: input.stdoutOffset,
        stderrOffset: input.stderrOffset,
      });
      return { shell: shells[0] ?? shell(input.shellId), stdout: chunk(""), stderr: chunk("") };
    },
    async stop(input: { shellId: string }) {
      fixture.stopCalls.push(input.shellId);
      const selected =
        shells.find((item) => item.shellId === input.shellId) ?? shell(input.shellId);
      selected.state = "stopped";
      selected.endedAt = Date.now();
      return selected;
    },
  };
  return fixture;
}

function rendered(component: Component, width = 80): string {
  return component.render(width).join("\n");
}

test("ShellsOverlay navigates with viewer keys, hands Enter off, and confirms stop", async () => {
  const shells = [shell("1"), shell("2"), shell("3")];
  const manager = managerFixture(shells);
  const selected: Array<ShellSummary | undefined> = [];
  const component = new ShellsOverlay(tui(), manager, "admin", theme, (value) =>
    selected.push(value),
  );

  component.handleInput("j");
  assert.match(rendered(component), /● ● shell-2/);
  component.handleInput("\x1b[6~");
  assert.match(rendered(component), /● ● shell-3/);
  component.handleInput("k");
  component.handleInput("\r");
  assert.equal(selected[0]?.shellId, "2");

  const stopComponent = new ShellsOverlay(tui(), manager, "admin", theme, () => {});
  stopComponent.handleInput("x");
  assert.match(rendered(stopComponent), /x again to STOP/);
  stopComponent.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.stopCalls, ["1"]);
  stopComponent.dispose();
});

test("openShellsOverlay uses centered overlays and Enter opens ShellOutputViewer", async () => {
  const manager = managerFixture([shell("1", "exited")]);
  const components: Component[] = [];
  const options: ShellCustomOptions[] = [];
  let call = 0;
  const ui: ShellsUICtx = {
    async custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: ShellViewerKeybindings | undefined,
        done: (result: T) => void,
      ) => Component,
      overlayOptions?: ShellCustomOptions,
    ) {
      let resolution: T | undefined;
      const component = factory(tui(), theme, undefined, (value: T) => {
        resolution = value;
      });
      components.push(component);
      if (overlayOptions) options.push(overlayOptions);
      if (call === 0) component.handleInput?.("\r");
      else component.handleInput?.("\x1b");
      call += 1;
      // SAFETY: Every simulated interaction synchronously calls the factory's typed done callback.
      const disposable = component as Component & { dispose?: () => void };
      disposable.dispose?.();
      // SAFETY: The simulated Enter/Esc input above synchronously supplies the generic result.
      return resolution as T;
    },
  };

  await openShellsOverlay(ui, manager, "admin");
  assert.ok(components[0] instanceof ShellsOverlay);
  assert.ok(components[1] instanceof ShellOutputViewer);
  assert.ok(components[2] instanceof ShellsOverlay);
  assert.deepEqual(options[0], {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
  });
});

test("ShellOutputViewer tails with absolute cursors, toggles streams, and confirms stop", async () => {
  const running = shell("1");
  let reads = 0;
  const manager = managerFixture([running]);
  manager.read = (input) => {
    manager.readCalls.push({ stdoutOffset: input.stdoutOffset, stderrOffset: input.stderrOffset });
    reads += 1;
    return {
      shell: running,
      stdout: reads === 1 ? chunk("out", 0) : chunk("+", 3),
      stderr: reads === 1 ? chunk("err", 0) : chunk("!", 3),
    };
  };
  const component = new ShellOutputViewer(tui(), manager, "admin", running, theme, () => {});
  assert.match(rendered(component), /out/);
  component.handleInput("\t");
  assert.match(rendered(component), /err/);
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.deepEqual(manager.readCalls[1], { stdoutOffset: 3, stderrOffset: 3 });
  assert.match(rendered(component), /err!/);

  component.handleInput("x");
  assert.match(rendered(component), /x again to STOP/);
  component.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.stopCalls, ["1"]);
  component.dispose();
});

test("ShellOutputViewer reports dropped buffers and freezes output after eviction", async () => {
  const running = shell("1");
  let reads = 0;
  const manager = managerFixture([running]);
  manager.read = () => {
    reads += 1;
    if (reads === 1) {
      return {
        shell: running,
        stdout: chunk("retained", 10, true),
        stderr: chunk("", 0),
      };
    }
    throw new Error("Shell not found: 1");
  };
  const component = new ShellOutputViewer(tui(), manager, "admin", running, theme, () => {});
  assert.match(rendered(component), /earlier output dropped from buffer/);
  await new Promise((resolve) => setTimeout(resolve, 230));
  const frozen = rendered(component);
  assert.match(frozen, /retained/);
  assert.match(frozen, /record evicted; output frozen/);
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(reads, 2);
  component.dispose();
});

test("ShellOutputViewer close and dispose cancel polling", async () => {
  const running = shell("1");
  const manager = managerFixture([running]);
  let closed = 0;
  const component = new ShellOutputViewer(tui(), manager, "admin", running, theme, () => {
    closed += 1;
  });
  component.handleInput("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(closed, 1);
  assert.equal(manager.readCalls.length, 1);
  component.dispose();
});
