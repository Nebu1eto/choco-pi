// Wheel over the docked /diff pane, driven through pi-tui's real alt-screen
// input path: raw SGR mouse bytes in, the dock host's components and pi-tui's
// own wheel routing in between. A wheel anywhere on the pane's columns scrolls
// the pane and never the transcript; a wheel on the transcript is unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import type { Component, ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import {
  Container,
  ScrollView,
  stripTerminalSequences,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { createDockHost } from "../.pi/extensions/diff/host/dock-host.ts";
import type {
  PaneScroller,
  PaneSurface,
  PointerGesture,
} from "../.pi/extensions/lib/changes/view/surface.ts";

const COLUMNS = 120;
const ROWS = 40;
const PANE_WIDTH = 40;
/** Zero-based columns: the border, then the pane's content. */
const BORDER_COLUMN = COLUMNS - PANE_WIDTH - 1;
const PANE_COLUMN = BORDER_COLUMN + 1;
const TRANSCRIPT_COLUMN = 10;
const HEADER_ROW = 0;
const BODY_ROW = 10;

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const WHEEL_LEFT = 66;
const WHEEL_RIGHT = 67;

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

/** A terminal that records nothing and hands its input callback to the test. */
class FakeTerminal implements Terminal {
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.input = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  get columns(): number {
    return COLUMNS;
  }
  get rows(): number {
    return ROWS;
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

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
}

/** Pi's fullscreen layout (modes/interactive/chat-viewport.js) on a real alt-screen TUI, with the pane docked. */
function dockedPane(bodyLines: number, overrides: Partial<PaneSurface> = {}) {
  const document = new Container();
  document.addChild(new Lines(numbered("transcript", 200)));
  const transcript = new ScrollView(document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
  });
  const editor = new Lines(["editor"]);
  const dock = new VStack([
    { component: editor, shrink: 1, minSize: 3 },
    { component: new Lines(["footer"]), shrink: 1, minSize: 0 },
  ]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.setLayoutRoot(root);
  tui.setFocus(editor);

  const scrollers: PaneScroller[] = [];
  const gestures: PointerGesture[] = [];
  const surface: PaneSurface = {
    renderHeader: (width) => ["header".slice(0, width)],
    renderBody: () => numbered("line", bodyLines),
    handleKey: () => {},
    pointer: (gesture) => {
      gestures.push(gesture);
      return gesture.kind !== "click";
    },
    attachScroller: (scroller) => scrollers.push(scroller),
    invalidate: () => {},
    ...overrides,
  };
  const resizes: number[] = [];
  const host = createDockHost(tui, surface, {
    width: () => PANE_WIDTH,
    resizeTo: (width) => resizes.push(width),
  });
  tui.start();
  assert.equal(host.install(), true);
  tui.renderNow();
  const pane = scrollers[0];
  assert.ok(pane, "the dock host attaches the pane's scroller");

  /** Send raw SGR mouse bytes (zero-based cell) through the terminal, then draw the frame. */
  const send = (button: number, x: number, y: number, release = false): void => {
    terminal.input(`\u001b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
    tui.renderNow();
  };
  const state = () => ({ transcript: transcript.scrollTop, pane: pane.top() });
  const maxPaneTop = () => Math.max(0, bodyLines - pane.viewportHeight());
  return { root, tui, host, transcript, editor, pane, send, state, maxPaneTop, gestures, resizes };
}

type Docked = ReturnType<typeof dockedPane>;

function withPane(
  bodyLines: number,
  run: (docked: Docked) => void,
  overrides: Partial<PaneSurface> = {},
): void {
  const docked = dockedPane(bodyLines, overrides);
  try {
    // The transcript sits mid-way, so a leaked wheel in either direction would move it.
    docked.transcript.scrollTo(100);
    docked.tui.renderNow();
    assert.equal(docked.transcript.scrollTop, 100);
    run(docked);
  } finally {
    docked.host.uninstall();
    docked.tui.stop();
  }
}

test("wheel up on a pane already at its top moves neither the pane nor the transcript", () => {
  withPane(100, ({ send, state }) => {
    assert.deepEqual(state(), { transcript: 100, pane: 0 });
    send(WHEEL_UP, PANE_COLUMN + 5, BODY_ROW);
    send(WHEEL_UP, PANE_COLUMN + 5, BODY_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 0 });
  });
});

test("wheel down on a pane at its bottom moves neither the pane nor the transcript", () => {
  withPane(100, ({ pane, tui, send, state, maxPaneTop }) => {
    pane.scrollTo(1000);
    tui.renderNow();
    const bottom = maxPaneTop();
    assert.ok(bottom > 0);
    assert.deepEqual(state(), { transcript: 100, pane: bottom });
    send(WHEEL_DOWN, PANE_COLUMN + 5, BODY_ROW);
    send(WHEEL_DOWN, PANE_COLUMN + 5, BODY_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: bottom });
  });
});

test("wheel on the pane body scrolls the pane by the wheel delta", () => {
  withPane(100, ({ send, state }) => {
    send(WHEEL_DOWN, PANE_COLUMN + 5, BODY_ROW);
    send(WHEEL_DOWN, PANE_COLUMN + 5, BODY_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 2 });
    send(WHEEL_UP, PANE_COLUMN + 5, BODY_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 1 });
  });
});

test("wheel on a list shorter than the pane, and below its end, leaves the transcript alone", () => {
  withPane(3, ({ pane, send, state }) => {
    assert.ok(pane.viewportHeight() > 3);
    for (const row of [1, BODY_ROW, ROWS - 6]) {
      // Checked after every event: a leaked down and a leaked up would cancel out.
      for (const button of [WHEEL_DOWN, WHEEL_DOWN, WHEEL_UP]) {
        send(button, PANE_COLUMN + 5, row);
        assert.deepEqual(state(), { transcript: 100, pane: 0 });
      }
    }
  });
});

test("wheel on the pane header row scrolls the pane, not the transcript", () => {
  withPane(100, ({ send, state }) => {
    send(WHEEL_UP, PANE_COLUMN + 2, HEADER_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 0 });
    send(WHEEL_DOWN, PANE_COLUMN + 2, HEADER_ROW);
    send(WHEEL_DOWN, PANE_COLUMN + PANE_WIDTH - 1, HEADER_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 2 });
  });
});

test("wheel on the border scrolls the pane, not the transcript", () => {
  withPane(100, ({ send, state, resizes }) => {
    send(WHEEL_UP, BORDER_COLUMN, BODY_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 0 });
    send(WHEEL_DOWN, BORDER_COLUMN, BODY_ROW);
    send(WHEEL_DOWN, BORDER_COLUMN, HEADER_ROW);
    assert.deepEqual(state(), { transcript: 100, pane: 2 });
    assert.deepEqual(resizes, []);
  });
});

test("wheel on the transcript columns still scrolls the transcript and not the pane", () => {
  withPane(100, ({ send, state }) => {
    send(WHEEL_UP, TRANSCRIPT_COLUMN, BODY_ROW);
    assert.deepEqual(state(), { transcript: 99, pane: 0 });
    send(WHEEL_DOWN, TRANSCRIPT_COLUMN, BODY_ROW);
    send(WHEEL_DOWN, BORDER_COLUMN - 1, HEADER_ROW);
    assert.deepEqual(state(), { transcript: 101, pane: 0 });
  });
});

test("wheel on the pane does not take keyboard focus", () => {
  withPane(100, ({ tui, editor, host, send }) => {
    send(WHEEL_DOWN, PANE_COLUMN + 5, BODY_ROW);
    send(WHEEL_DOWN, BORDER_COLUMN, BODY_ROW);
    assert.equal(tui.getFocusedComponent(), editor);
    assert.equal(host.isFocused(), false);
  });
});

test("a horizontal wheel inside the pane changes nothing and leaves no press target behind", () => {
  withPane(100, ({ tui, editor, host, pane, send, state, gestures, resizes }) => {
    pane.scrollTo(5);
    tui.renderNow();
    const before = state();
    const cells: [number, number][] = [
      [PANE_COLUMN + 5, BODY_ROW],
      [PANE_COLUMN + 5, HEADER_ROW],
      [BORDER_COLUMN, BODY_ROW],
    ];
    for (const [x, y] of cells) {
      send(WHEEL_LEFT, x, y);
      send(WHEEL_RIGHT, x, y);
    }
    assert.deepEqual(state(), before);
    assert.equal(gestures.length, 0, "no gesture reached the view");
    assert.deepEqual(resizes, []);
    assert.equal(tui.getFocusedComponent(), editor);
    assert.equal(tui.hasActiveSelection(), false);

    // Horizontal wheels never send a release. Had a pane component taken one, pi-tui
    // would send this press to it instead of the body (on the border: a resize drag).
    send(0, PANE_COLUMN + 5, BODY_ROW);
    send(0, PANE_COLUMN + 5, BODY_ROW, true);
    assert.deepEqual(
      gestures.map((gesture) => gesture.kind),
      ["press", "click"],
    );
    assert.deepEqual(resizes, []);
    assert.equal(host.isFocused(), true);
    assert.equal(state().transcript, before.transcript);
  });
});

/** A frame of the whole layout as pi-tui draws it now, one string per terminal row, escapes removed. */
function screen(root: Component): string[] {
  return renderLayoutFrame(root, COLUMNS, ROWS, () => {}).lines.map((row) =>
    stripTerminalSequences(row),
  );
}

test("a scrolled pane draws the view's pinned rows over its first visible body rows", () => {
  const asked: number[] = [];
  withPane(
    60,
    ({ root, pane, send }) => {
      assert.match(screen(root)[HEADER_ROW + 1] ?? "", /line 0\b/u, "nothing pinned at the top");
      send(WHEEL_DOWN, PANE_COLUMN, BODY_ROW);
      const top = pane.top();
      assert.ok(top > 0);
      const rows = screen(root);
      assert.match(rows[HEADER_ROW + 1] ?? "", new RegExp(`PINNED ${top}\\b`, "u"));
      assert.match(rows[HEADER_ROW + 2] ?? "", new RegExp(`HUNK ${top}\\b`, "u"));
      assert.match(rows[HEADER_ROW + 3] ?? "", new RegExp(`line ${top + 2}\\b`, "u"));
      assert.equal(asked.at(-1), top);
    },
    {
      stickyRows: (top) => {
        asked.push(top);
        return top > 0 ? [`PINNED ${top}`, `HUNK ${top}`] : [];
      },
    },
  );
});

test("when the body shrinks under a scrolled pane the pinned row still lands on the first visible row", () => {
  let count = 60;
  withPane(
    60,
    ({ root, tui, pane, maxPaneTop }) => {
      pane.scrollTo(maxPaneTop());
      tui.renderNow();
      // The first frame after the shrink: pi-tui clamps the scroll position only after the body drew.
      count = 45;
      const rows = screen(root);
      const pinned = rows.flatMap((row, index) => (row.includes("PINNED") ? [index] : []));
      assert.deepEqual(pinned, [HEADER_ROW + 1], rows.join("\n"));
    },
    {
      renderBody: () => numbered("line", count),
      stickyRows: (top) => (top > 0 ? [`PINNED ${top}`] : []),
    },
  );
});
