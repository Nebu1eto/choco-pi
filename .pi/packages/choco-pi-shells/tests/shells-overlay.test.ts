import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  ShellOutputViewer,
  SHELL_VIEWER_MAX_CHARS,
  SHELL_VIEWER_MAX_LINES,
} from "../src/ui/shell-viewer.ts";
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

test("ShellOutputViewer retains bounded incremental state under noisy output", () => {
  const exited = shell("1", "exited");
  const manager = managerFixture([exited]);
  const noisy =
    "oldest-marker\n" +
    Array.from({ length: SHELL_VIEWER_MAX_LINES + 100 }, (_, index) => `line-${index}\n`).join("") +
    "newest-tail";
  manager.read = () => ({ shell: exited, stdout: chunk(noisy), stderr: chunk("") });

  const component = new ShellOutputViewer(tui(3_000), manager, "admin", exited, theme, () => {});
  const output = rendered(component);
  assert.ok((output.match(/line-\d+/g) ?? []).length <= SHELL_VIEWER_MAX_LINES);
  assert.doesNotMatch(output, /oldest-marker/);
  assert.match(output, /newest-tail/);
  assert.match(output, /earlier output omitted from viewer/);
  component.dispose();

  const longLineManager = managerFixture([exited]);
  longLineManager.read = () => ({
    shell: exited,
    stdout: chunk(`oldest-marker${"x".repeat(SHELL_VIEWER_MAX_CHARS)}\nnewest-tail`),
    stderr: chunk(""),
  });
  const longLineComponent = new ShellOutputViewer(
    tui(),
    longLineManager,
    "admin",
    exited,
    theme,
    () => {},
  );
  const longLineOutput = rendered(longLineComponent);
  assert.doesNotMatch(longLineOutput, /oldest-marker/);
  assert.match(longLineOutput, /newest-tail/);
  assert.match(longLineOutput, /earlier output omitted from viewer/);
  longLineComponent.dispose();
});

test("ShellOutputViewer drains retained output after a terminal shell", async () => {
  const exited = shell("1", "exited");
  const manager = managerFixture([exited]);
  const noisy = `oldest-marker\n${"x".repeat(SHELL_VIEWER_MAX_CHARS + 100)}\nnewest-tail`;
  manager.read = (input) => {
    manager.readCalls.push({ stdoutOffset: input.stdoutOffset, stderrOffset: input.stderrOffset });
    const startOffset = input.stdoutOffset ?? 0;
    const data = noisy.slice(startOffset, startOffset + (input.maxBytes ?? noisy.length));
    return {
      shell: exited,
      stdout: {
        data,
        startOffset,
        nextOffset: startOffset + data.length,
        endOffset: noisy.length,
        dropped: false,
      },
      stderr: chunk(""),
    };
  };

  const component = new ShellOutputViewer(tui(3_000), manager, "admin", exited, theme, () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const output = rendered(component, 120);
  assert.ok(manager.readCalls.length >= 2);
  assert.doesNotMatch(output, /oldest-marker/);
  assert.match(output, /newest-tail/);
  assert.match(output, /earlier output omitted from viewer/);
  component.dispose();
});

test("ShellOutputViewer preserves UTF-8 multiline tails and strips terminal controls", () => {
  const exited = shell("1", "exited");
  const manager = managerFixture([exited]);
  manager.read = () => ({
    shell: exited,
    stdout: chunk("安全\x1b[2Jvisible\x07\x01\x1b[?1049h\n色\x1b[31mred\x1b[0m\n最終行🙂"),
    stderr: chunk(""),
  });

  const component = new ShellOutputViewer(tui(), manager, "admin", exited, theme, () => {});
  const output = rendered(component, 120);

  assert.match(output, /安全visible/);
  assert.match(output, /色red/);
  assert.match(output, /最終行🙂/);
  assert.ok(
    [...output].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x0a || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f));
    }),
  );
  assert.doesNotMatch(output, /\[\?1049h/);
  component.dispose();
});

test("ShellOutputViewer keeps rendered lines within the 70% viewport budget", () => {
  for (const rows of [20, 30, 41]) {
    for (const withNotice of [false, true]) {
      const exited = shell("1", "exited");
      const manager = managerFixture([exited]);
      manager.read = () => {
        if (withNotice) throw new Error("temporary read failure");
        return { shell: exited, stdout: chunk("output"), stderr: chunk("") };
      };
      const component = new ShellOutputViewer(tui(rows), manager, "admin", exited, theme, () => {});

      const lines = component.render(80);
      assert.ok(lines.length <= Math.floor(rows * 0.7), `${rows} rows, notice=${withNotice}`);
      assert.match(stripTerminalSequences(lines.at(-1) ?? ""), /^╰─+╯$/);
      if (withNotice) assert.match(lines.join("\n"), /Read failed: temporary read failure/);
      component.dispose();
    }
  }
});

test("ShellOutputViewer keeps a rejected stop visible across a successful poll", async () => {
  const running = shell("1");
  let reads = 0;
  const manager = managerFixture([running]);
  manager.read = () => {
    reads += 1;
    return { shell: running, stdout: chunk(""), stderr: chunk("") };
  };
  manager.stop = async () => {
    throw new Error("permission denied");
  };
  const component = new ShellOutputViewer(tui(), manager, "admin", running, theme, () => {});

  component.handleInput("x");
  component.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(rendered(component), /Stop failed: permission denied/);

  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.ok(reads >= 2);
  assert.match(rendered(component), /Stop failed: permission denied/);
  component.dispose();
});

test("ShellsOverlay keeps a rejected stop visible across successful list refreshes", async () => {
  const manager = managerFixture([shell("1")]);
  manager.stop = async () => {
    throw new Error("permission denied");
  };
  const component = new ShellsOverlay(tui(), manager, "admin", theme, () => {});

  component.handleInput("x");
  component.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(rendered(component), /Stop failed: permission denied/);
  assert.match(rendered(component), /Stop failed: permission denied/);
  component.dispose();
});

test("ShellsOverlay sanitizes and one-line bounds shell metadata", () => {
  const named = shell("1");
  named.name = `named\x1b[31m-red\x1b[0m\nnext\x07${"n".repeat(100)}`;
  named.ownerId = `owner\x1b[2J\nnext\x07${"o".repeat(100)}`;
  const commanded = shell("2");
  commanded.name = undefined;
  commanded.command = `command\x1b[31m-red\x1b[0m\nnext\x07${"c".repeat(100)}`;
  const component = new ShellsOverlay(
    tui(),
    managerFixture([named, commanded]),
    "admin",
    theme,
    () => {},
  );

  const lines = component.render(64);
  const sanitizedLines = lines.map((line) => stripTerminalSequences(line));
  assert.ok(
    sanitizedLines.every((line) =>
      Array.from(line).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
      }),
    ),
  );
  assert.ok(lines.every((line) => visibleWidth(line) <= 64));
  const output = sanitizedLines.join("\n");
  assert.match(output, /named-rednext/);
  assert.match(output, /command-rednext/);
  assert.equal(output.includes("\x1b"), false);
  assert.equal(output.includes("\x07"), false);
  component.dispose();
});
