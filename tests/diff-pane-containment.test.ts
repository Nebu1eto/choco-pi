// The pane hosts contain what the view throws inside pi-tui's render and input
// calls (Pi exits on an uncaught throw): a bounded fallback, one report, and
// the view is not called again after a render failure.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TuiInputListener,
  TuiMode,
} from "@earendil-works/pi-tui";
import {
  Container,
  HStack,
  ScrollView,
  VStack,
  isFocusable,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { createDockHost } from "../.pi/extensions/diff/host/dock-host.ts";
import { createOverlayHost } from "../.pi/extensions/diff/host/overlay-host.ts";
import type { HostCallbacks, PaneSurface } from "../.pi/extensions/lib/changes/view/surface.ts";
import type { PaneHost, PaneTui } from "../.pi/extensions/diff/host/types.ts";

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

class FakeTui implements PaneTui {
  mode: TuiMode = "fullscreen";
  terminal = { columns: 120, rows: 40 };
  children: Component[] = [];
  layoutRoot: RuntimeValue;
  focused: Component | null;
  overlays: Component[] = [];
  constructor(root: RuntimeValue, editor: Component) {
    this.layoutRoot = root;
    this.focused = editor;
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
  showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
    this.overlays.push(component);
    let focused = false;
    let previous: Component | null = null;
    return {
      hide: () => {},
      setHidden: () => {},
      isHidden: () => false,
      focus: () => {
        previous = this.focused;
        focused = true;
        this.setFocus(component);
      },
      unfocus: () => {
        focused = false;
        this.setFocus(previous);
      },
      isFocused: () => focused,
      getBounds: () => undefined,
    };
  }
  addInputListener(_listener: TuiInputListener): () => void {
    return () => {};
  }
}

type Failures = { render?: Error | "always"; key?: Error };

/** A bell or the start of an operating-system command: what a hostile message would carry. */
function hostileBytes(text: string): boolean {
  return text.includes("\u0007") || text.includes("\u001b]");
}

const HOSTILE = "bad \u001b]52;c;Zm9v\u0007 \u001b[31mred\nsecond line";

/** A surface whose calls can be made to throw, counting every call that reaches it. */
function breakableSurface() {
  const calls = { header: 0, body: 0, keys: 0 };
  const fail: Failures = {};
  const surface: PaneSurface = {
    renderHeader: (width) => {
      calls.header += 1;
      return ["header".slice(0, width)];
    },
    renderBody: () => {
      calls.body += 1;
      const failure = fail.render;
      if (failure === "always") throw new Error(HOSTILE);
      if (failure) {
        fail.render = undefined;
        throw failure;
      }
      return ["a", "b"];
    },
    handleKey: () => {
      calls.keys += 1;
      if (fail.key) throw fail.key;
    },
    attachScroller: () => {},
    invalidate: () => {},
  };
  return { surface, calls, fail };
}

function callbacksRecording() {
  const failures: Array<{ kind: string; message: string }> = [];
  const callbacks: HostCallbacks = {
    width: () => 40,
    resizeTo: () => {},
    failed: (kind, error) =>
      failures.push({ kind, message: error instanceof Error ? error.message : String(error) }),
  };
  return { callbacks, failures };
}

async function microtasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The dock host's body and header components, as pi-tui renders them. */
function dock() {
  const transcript = new ScrollView(new Container(), { follow: "end", primary: true });
  const editor = new Lines(["editor"]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    {
      component: new VStack([{ component: editor, shrink: 1, minSize: 3 }]),
      basis: "auto",
      grow: 0,
      shrink: 1,
      minSize: 1,
    },
  ]);
  const tui = new FakeTui(root, editor);
  const { surface, calls, fail } = breakableSurface();
  const { callbacks, failures } = callbacksRecording();
  const host: PaneHost = createDockHost(tui, surface, callbacks);
  assert.equal(host.install(), true);
  const row = root.children[0];
  assert.ok(row instanceof HStack);
  const paneBox = row.children[2];
  assert.ok(paneBox instanceof VStack);
  const header = paneBox.children[0];
  assert.ok(header);
  host.focus();
  const body = tui.focused;
  assert.ok(body && body !== editor);
  host.unfocus();
  return { tui, host, header, body, editor, calls, fail, failures, surface, callbacks };
}

function overlay() {
  const editor = new Lines(["editor"]);
  const tui = new FakeTui(undefined, editor);
  tui.children = [new Lines([]), new Lines(["e1", "e2"]), new Lines(["footer"])];
  const { surface, calls, fail } = breakableSurface();
  const { callbacks, failures } = callbacksRecording();
  const host = createOverlayHost(tui, surface, callbacks);
  assert.equal(host.install(), true);
  const pane = tui.overlays[0];
  assert.ok(pane);
  return { tui, host, pane, calls, fail, failures, surface, callbacks };
}

test("dock: a render that throws gives one sanitised fallback line within the width, reported once", async () => {
  const pane = dock();
  pane.fail.render = new Error(HOSTILE);
  const lines = pane.body.render(30);
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0] ?? "") <= 30);
  // Later frames: the header carries the line, the body is empty.
  assert.deepEqual(pane.body.render(80), []);
  const line = pane.header.render(80)[0] ?? "";
  assert.equal(
    hostileBytes(line) || line.includes("\u001b[31m"),
    false,
    "the error's control bytes are gone",
  );
  assert.match(line, /could not be drawn: bad/u);
  assert.equal((lines[0] ?? "").includes("second line"), false, "first line only");
  await microtasks();
  assert.deepEqual(
    pane.failures.map((failure) => failure.kind),
    ["render"],
  );
});

test("dock: a render that throws on every frame is not called again and reported once", async () => {
  const pane = dock();
  pane.fail.render = "always";
  pane.body.render(40);
  const reached = pane.calls.body;
  const headers = pane.calls.header;
  for (let frame = 0; frame < 60; frame += 1) {
    pane.header.render(40);
    const body = pane.body.render(40);
    assert.ok(body.length <= 1);
  }
  assert.equal(pane.calls.body - reached, 0, "the failing path is not called after the failure");
  assert.equal(pane.calls.header - headers, 0, "nor any other view call");
  const header = pane.header.render(40);
  assert.equal(header.length, 1);
  assert.match(header[0] ?? "", /could not be drawn/u);
  await microtasks();
  assert.equal(pane.failures.length, 1);
});

test("dock: a key or click handler that throws is contained and reported as input", async () => {
  const pane = dock();
  pane.fail.key = new Error("key broke");
  assert.doesNotThrow(() => pane.body.handleInput?.("j"));
  await microtasks();
  assert.deepEqual(pane.failures, [{ kind: "input", message: "key broke" }]);
  pane.fail.key = undefined;
  pane.body.handleInput?.("k");
  assert.equal(pane.calls.keys, 2, "keys still reach the view after an input failure");
  const lines = pane.body.render(40);
  assert.deepEqual(lines, ["a", "b"], "and it still draws");
});

test("overlay: a failing render keeps the frame within the request and stops calling the view", async () => {
  const pane = overlay();
  pane.fail.render = "always";
  const first = pane.pane.render(31);
  assert.equal(first.length, 37, "the overlay's own height");
  assert.ok(first.every((line) => visibleWidth(line) <= 31));
  const reached = pane.calls.body;
  for (let frame = 0; frame < 60; frame += 1) pane.pane.render(31);
  assert.equal(pane.calls.body - reached, 0);
  assert.equal(
    first.some((line) => hostileBytes(line)),
    false,
  );
  await microtasks();
  assert.equal(pane.failures.length, 1);
  assert.equal(pane.failures[0]?.kind, "render");
});

test("overlay: the host's own drawing and size getters are contained too", async () => {
  const pane = overlay();
  // The dock measurement renders Pi's other components, outside the view.
  pane.tui.children = [
    new Lines([]),
    {
      render: () => {
        throw new Error("dock broke");
      },
      invalidate: () => {},
    },
  ];
  const lines = pane.pane.render(31);
  assert.ok(lines.length >= 1 && lines.every((line) => visibleWidth(line) <= 31));
  await microtasks();
  assert.deepEqual(
    pane.failures.map((failure) => failure.message),
    ["dock broke"],
  );
});

test("overlay: input that throws is contained", async () => {
  const pane = overlay();
  pane.fail.key = new Error("key broke");
  assert.doesNotThrow(() => pane.pane.handleInput?.("j"));
  await microtasks();
  assert.deepEqual(pane.failures, [{ kind: "input", message: "key broke" }]);
});
