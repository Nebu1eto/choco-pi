// The mouse escape guard on pi-tui's real input path: raw bytes into a real
// StdinBuffer (10 ms escape timeout, as in Pi), its sequences into a real
// TuiAltScreen or TuiMainScreen, its listeners and the focused component.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, ProgramStatus, Terminal, TUI } from "@earendil-works/pi-tui";
import { Input, StdinBuffer, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import {
  createMouseEscapeGuardExtension,
  installMouseEscapeGuard,
  type RawInput,
} from "../.pi/extensions/mouse-escape-guard.ts";
import {
  containsMouseReport,
  HOLD_MS,
  isMouseReport,
  MOUSE_WINDOW_MS,
} from "../.pi/extensions/lib/mouse-escape-guard.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const ESC = "\u001b";
const WHEEL = `${ESC}[<65;10;5M`;
const SPLIT_TAIL = "[<67;192;37M";

class FakeTerminal implements Terminal {
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.input = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

/** Stands in for the focused /diff pane: records every key it is given. */
class Recorder implements Component {
  readonly inputs: string[] = [];
  render(): string[] {
    return [];
  }
  invalidate(): void {}
  handleInput(data: string): void {
    this.inputs.push(data);
  }
}

class FakeStdin extends EventEmitter implements RawInput {
  prependListener(event: "data", listener: (chunk: string | Buffer) => void): this {
    return super.prependListener(event, listener);
  }
  removeListener(event: "data", listener: (chunk: string | Buffer) => void): this {
    return super.removeListener(event, listener);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keep the event loop busy, as a render while scrolling does. */
function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

function uiFor(tui: TUI) {
  return {
    onTerminalInput: (
      handler: (data: string) => { consume?: boolean; data?: string } | undefined,
    ) => tui.addInputListener(handler),
    setWidget: (
      _key: string,
      content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined,
    ): void => {
      if (content !== undefined && !Array.isArray(content)) {
        content(tui, reinterpretHostValue<Theme>({}));
      }
    },
  };
}

function harness(screen: "fullscreen" | "main", focus: "editor" | "pane", guarded = true) {
  const terminal = new FakeTerminal();
  const tui =
    screen === "fullscreen"
      ? new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false })
      : new TuiMainScreen(terminal, false, undefined);
  const editor = new Input();
  let escapes = 0;
  editor.onEscape = () => {
    escapes += 1;
  };
  const pane = new Recorder();
  tui.addChild(editor);
  tui.addChild(pane);
  tui.setFocus(focus === "editor" ? editor : pane);
  tui.start();
  // What the TUI receives from the stdin buffer, before any extension listener.
  const parsed: string[] = [];
  tui.addInputListener((data) => {
    parsed.push(data);
    return undefined;
  });
  const stdin = new FakeStdin();
  const buffer = new StdinBuffer({ escapeTimeout: 10 });
  buffer.on("data", (sequence) => terminal.input(sequence));
  // ProcessTerminal's own stdin listener, registered before any extension's.
  stdin.on("data", (chunk: string) => buffer.process(chunk));
  const installed = guarded
    ? installMouseEscapeGuard({ mode: "tui", ui: uiFor(tui) }, stdin)
    : undefined;
  if (guarded) assert.ok(installed, "the guard installs on a real TUI");
  // A listener registered after the guard, like the /diff pane's double-Esc listener.
  const later: string[] = [];
  tui.addInputListener((data) => {
    later.push(data);
    return undefined;
  });
  const send = (chunk: string) => stdin.emit("data", chunk);
  const delivered = () => (focus === "editor" ? [] : pane.inputs);
  return {
    tui,
    editor,
    pane,
    stdin,
    parsed,
    later,
    send,
    delivered,
    escapes: () => escapes,
    close: () => {
      installed?.dispose();
      buffer.destroy();
      tui.stop();
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** The reproduced split: ESC read alone, the loop busy past the escape timeout, the tail read later. */
async function splitWheelReport(h: Harness): Promise<void> {
  h.send(WHEEL);
  h.send(ESC);
  busy(15);
  await sleep(0);
  h.send(SPLIT_TAIL);
  await sleep(HOLD_MS * 3);
}

for (const screen of ["fullscreen", "main"] as const) {
  for (const focus of ["editor", "pane"] as const) {
    test(`a split wheel report delivers neither Escape nor text (${screen}, ${focus} focus)`, async () => {
      const h = harness(screen, focus);
      try {
        await splitWheelReport(h);
        // The split really happened: a bare ESC, then the tail as single characters.
        const escIndex = h.parsed.indexOf(ESC);
        assert.ok(escIndex >= 0, "the stdin buffer flushed a bare ESC");
        assert.deepEqual(h.parsed.slice(escIndex), [ESC, ...SPLIT_TAIL]);
        assert.equal(h.escapes(), 0);
        assert.equal(h.editor.getValue(), "");
        const focused = focus === "pane" ? h.pane.inputs.filter((data) => data !== WHEEL) : [];
        assert.deepEqual(focused, []);
        assert.deepEqual(
          h.later.filter((data) => data !== WHEEL),
          [],
        );
      } finally {
        h.close();
      }
    });
  }
}

test("without the guard the same split aborts and types the tail (the reproduced bug)", async () => {
  const h = harness("fullscreen", "editor", false);
  try {
    await splitWheelReport(h);
    assert.equal(h.escapes(), 1);
    assert.equal(h.editor.getValue(), SPLIT_TAIL);
  } finally {
    h.close();
  }
});

test("a broken report flushed as ESC [<digits is dropped with its rest", async () => {
  const h = harness("fullscreen", "editor");
  try {
    h.send(`${ESC}[<64;19`);
    await sleep(70); // past the stdin buffer's 50 ms timeout for an unfinished sequence
    h.send("1;47M");
    await sleep(HOLD_MS * 3);
    assert.ok(h.parsed.includes(`${ESC}[<64;19`));
    assert.equal(h.escapes(), 0);
    assert.equal(h.editor.getValue(), "");
  } finally {
    h.close();
  }
});

test("an Escape without recent mouse input is delivered at once", async () => {
  const h = harness("fullscreen", "pane");
  try {
    h.send(ESC);
    await sleep(20); // the stdin buffer's 10 ms, well short of the guard's hold
    assert.deepEqual(h.pane.inputs, [ESC]);
    assert.deepEqual(h.later, [ESC]);
  } finally {
    h.close();
  }
});

test("an Escape long after mouse input is delivered at once", async () => {
  const h = harness("fullscreen", "pane");
  try {
    h.send(WHEEL);
    await sleep(MOUSE_WINDOW_MS + 50);
    h.send(ESC);
    await sleep(20);
    assert.deepEqual(h.pane.inputs, [ESC]);
  } finally {
    h.close();
  }
});

test("a held Escape with no report after it is delivered once, after the hold", async () => {
  const h = harness("fullscreen", "pane");
  try {
    h.send(WHEEL);
    h.send(ESC);
    await sleep(20);
    assert.deepEqual(h.pane.inputs, [], "held while a report may follow");
    await sleep(HOLD_MS + 40);
    assert.deepEqual(h.pane.inputs, [ESC]);
    assert.deepEqual(h.later, [ESC], "listeners after the guard see it exactly once");
    await sleep(HOLD_MS * 2);
    assert.deepEqual(h.pane.inputs, [ESC]);
  } finally {
    h.close();
  }
});

test("a held Escape reaches the editor's Escape handler once", async () => {
  const h = harness("fullscreen", "editor");
  try {
    h.send(WHEEL);
    h.send(ESC);
    await sleep(HOLD_MS * 3);
    assert.equal(h.escapes(), 1);
    assert.equal(h.editor.getValue(), "");
  } finally {
    h.close();
  }
});

test("a key after a held Escape goes on after it, separately", async () => {
  const h = harness("fullscreen", "pane");
  try {
    h.send(WHEEL);
    h.send(ESC);
    await sleep(20);
    h.send("a");
    assert.deepEqual(h.pane.inputs, [ESC, "a"]);
    await sleep(HOLD_MS * 3);
    assert.deepEqual(h.pane.inputs, [ESC, "a"]);
  } finally {
    h.close();
  }
});

test("a held Escape followed by a typed [ and a letter delivers all three in order", async () => {
  const h = harness("fullscreen", "pane");
  try {
    h.send(WHEEL);
    h.send(ESC);
    await sleep(20);
    h.send("[");
    h.send("x");
    assert.deepEqual(h.pane.inputs, [ESC, "[", "x"]);
  } finally {
    h.close();
  }
});

test("double Escape delivers two Escapes, with and without recent mouse input", async () => {
  for (const scrolled of [false, true]) {
    const h = harness("fullscreen", "pane");
    try {
      if (scrolled) h.send(WHEEL);
      h.send(ESC);
      await sleep(20);
      h.send(ESC);
      await sleep(HOLD_MS * 3);
      assert.deepEqual(h.pane.inputs, [ESC, ESC], `scrolled: ${scrolled}`);
      assert.deepEqual(h.later, [ESC, ESC], `scrolled: ${scrolled}`);
    } finally {
      h.close();
    }
  }
});

test("a whole report passes as before", async () => {
  const guarded = harness("main", "pane");
  const plain = harness("main", "pane", false);
  try {
    guarded.send(WHEEL);
    plain.send(WHEEL);
    await sleep(HOLD_MS * 2);
    assert.deepEqual(guarded.pane.inputs, [WHEEL]);
    assert.deepEqual(guarded.pane.inputs, plain.pane.inputs);
  } finally {
    guarded.close();
    plain.close();
  }
});

test("dispose drops a held Escape and detaches from stdin and the TUI", async () => {
  const h = harness("fullscreen", "pane", false);
  const stdinListeners = h.stdin.listenerCount("data");
  const installed = installMouseEscapeGuard({ mode: "tui", ui: uiFor(h.tui) }, h.stdin);
  try {
    assert.ok(installed);
    assert.equal(h.stdin.listenerCount("data"), stdinListeners + 1);
    h.send(WHEEL);
    h.send(ESC);
    await sleep(20);
    installed.dispose();
    installed.dispose();
    assert.equal(h.stdin.listenerCount("data"), stdinListeners);
    await sleep(HOLD_MS * 3);
    assert.deepEqual(h.pane.inputs, []);
    // Detached: the next scroll and Escape behave as without the guard.
    h.send(WHEEL);
    h.send(ESC);
    await sleep(20);
    assert.deepEqual(h.pane.inputs, [ESC]);
  } finally {
    h.close();
  }
});

test("the guard stays off outside the TUI and without a replayable TUI", () => {
  const stdin = new FakeStdin();
  const tui = new TuiMainScreen(new FakeTerminal(), false, undefined);
  assert.equal(installMouseEscapeGuard({ mode: "rpc", ui: uiFor(tui) }, stdin), undefined);
  const noWidget = {
    onTerminalInput: () => () => {},
    setWidget: (): void => {},
  };
  assert.equal(installMouseEscapeGuard({ mode: "tui", ui: noWidget }, stdin), undefined);
  assert.equal(stdin.listenerCount("data"), 0);
});

test("session start replaces the previous guard and shutdown removes it", () => {
  const stdin = new FakeStdin();
  const handlers = new Map<string, (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue>();
  createMouseEscapeGuardExtension(stdin)(
    reinterpretHostValue<ExtensionAPI>({
      on: (event: string, handler: (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue) =>
        handlers.set(event, handler),
    }),
  );
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  assert.ok(start && shutdown);
  const tui = new TuiMainScreen(new FakeTerminal(), false, undefined);
  const ctx = { mode: "tui", ui: uiFor(tui) };
  start({ type: "session_start" }, ctx);
  start({ type: "session_start" }, ctx);
  assert.equal(stdin.listenerCount("data"), 1);
  shutdown({ type: "session_shutdown" }, ctx);
  assert.equal(stdin.listenerCount("data"), 0);
  shutdown({ type: "session_shutdown" }, ctx);
  assert.equal(stdin.listenerCount("data"), 0);
});

test("prependListener does not switch a paused stream to flowing", () => {
  const stream = new PassThrough();
  assert.equal(stream.readableFlowing, null);
  const listener = () => {};
  stream.prependListener("data", listener);
  assert.equal(stream.readableFlowing, null);
  stream.removeListener("data", listener);
});

test("report recognition", () => {
  assert.equal(isMouseReport(WHEEL), true);
  assert.equal(isMouseReport(`${WHEEL}x`), false);
  assert.equal(isMouseReport(ESC), false);
  assert.equal(containsMouseReport(SPLIT_TAIL), true);
  assert.equal(containsMouseReport(`ab${WHEEL}`), true);
  assert.equal(containsMouseReport("[<67;192"), false);
});
