import assert from "node:assert/strict";
import test from "node:test";
import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  StackEntry,
  TuiInputListener,
  TuiMode,
  TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { Container, HStack, ScrollView, VStack, isFocusable } from "@earendil-works/pi-tui";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { createDockHost } from "../.pi/extensions/diff/host/dock-host.ts";
import {
  canHostPane,
  clampPaneWidth,
  maxPaneWidth,
  MIN_PANE_WIDTH,
  widthFromBorderColumn,
} from "../.pi/extensions/diff/host/geometry.ts";
import { inspectHostRoot, readLayoutRoot } from "../.pi/extensions/diff/host/layout.ts";
import { createOverlayHost } from "../.pi/extensions/diff/host/overlay-host.ts";
import type { PaneScroller, PaneSurface } from "../.pi/extensions/lib/changes/view/surface.ts";
import type { PaneTui } from "../.pi/extensions/diff/host/types.ts";

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

/** The fullscreen layout Pi 1.5.1 builds in modes/interactive/chat-viewport.js. */
function chatViewport() {
  const transcript = new ScrollView(new Container(), {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
  });
  const dock = new VStack([
    { component: new Lines(["editor"]), shrink: 1, minSize: 3 },
    { component: new Lines(["footer"]), shrink: 1, minSize: 0 },
  ]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { root, transcript, dock };
}

/** Copy of a stack's internal entries, read the same way production does. */
function entriesOf(stack: Component): StackEntry[] {
  const raw: RuntimeValue = "entries" in stack ? stack.entries : undefined;
  assert.ok(Array.isArray(raw));
  return raw.map((entry: StackEntry) => ({ ...entry }));
}

type OverlayRecord = { component: Component; options: OverlayOptions; hidden: boolean };

class FakeTui implements PaneTui {
  mode: TuiMode = "fullscreen";
  terminal = { columns: 120, rows: 40 };
  children: Component[] = [];
  layoutRoot: RuntimeValue;
  focused: Component | null;
  renders = 0;
  overlays: OverlayRecord[] = [];
  listeners: TuiInputListener[] = [];

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
  requestRender(): void {
    this.renders += 1;
  }
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    const record: OverlayRecord = { component, options: options ?? {}, hidden: false };
    this.overlays.push(record);
    let focused = false;
    let previous: Component | null = null;
    return {
      hide: () => {
        record.hidden = true;
      },
      setHidden: (hidden) => {
        record.hidden = hidden;
      },
      isHidden: () => record.hidden,
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
  addInputListener(listener: TuiInputListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
}

function fakeSurface() {
  const keys: string[] = [];
  const scrollers: PaneScroller[] = [];
  const surface: PaneSurface = {
    renderHeader: (width) => ["header".slice(0, width)],
    renderBody: () => ["a", "b", "c"],
    handleKey: (data) => keys.push(data),
    attachScroller: (scroller) => scrollers.push(scroller),
    invalidate: () => {},
  };
  return { surface, keys, scrollers };
}

function mouse(type: TuiMouseEvent["type"], screenX: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x: 0,
    y: 0,
    screenX,
    screenY: 5,
    width: 1,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test("inspectHostRoot accepts Pi's chat viewport layout", () => {
  const { root, transcript, dock } = chatViewport();
  const layout = inspectHostRoot(root);
  assert.ok(layout);
  assert.equal(layout.root, root);
  assert.equal(layout.transcript, transcript);
  assert.deepEqual(layout.entries, [
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
});

test("inspectHostRoot rejects a wrong child count", () => {
  const { transcript, dock } = chatViewport();
  assert.equal(inspectHostRoot(new VStack([transcript])), undefined);
  assert.equal(inspectHostRoot(new VStack([transcript, dock, new Lines(["x"])])), undefined);
});

test("inspectHostRoot rejects wrong classes", () => {
  const { transcript, dock } = chatViewport();
  assert.equal(inspectHostRoot(new HStack([transcript, dock])), undefined);
  assert.equal(inspectHostRoot(new VStack([new Lines(["t"]), dock])), undefined);
  assert.equal(inspectHostRoot({ children: [transcript, dock] }), undefined);
  assert.equal(inspectHostRoot("root"), undefined);
});

test("inspectHostRoot rejects a missing field and unknown entry options", () => {
  assert.equal(readLayoutRoot({}), undefined);
  assert.equal(inspectHostRoot(readLayoutRoot({ mode: "fullscreen" })), undefined);
  assert.equal(inspectHostRoot(undefined), undefined);
  const transcript = new ScrollView(new Container());
  const dock = new Lines(["dock"]);
  const withCallback = new VStack([
    { component: transcript, visible: () => true },
    { component: dock },
  ]);
  assert.equal(inspectHostRoot(withCallback), undefined);
});

test("dock install then uninstall restores the original entries exactly, twice", () => {
  const { root, transcript } = chatViewport();
  const before = entriesOf(root);
  const children = [...root.children];
  const editor = new Lines(["editor"]);
  const tui = new FakeTui(root, editor);
  const { surface } = fakeSurface();
  const host = createDockHost(tui, surface, { width: () => 40, resizeTo: () => {} });

  assert.equal(host.install(), true);
  assert.ok(root.children[0] instanceof HStack);
  assert.equal(root.children[1], children[1]);
  const row = root.children[0];
  assert.ok(row instanceof HStack);
  assert.equal(row.children[0], transcript);
  assert.equal(entriesOf(root)[0]?.grow, before[0]?.grow);
  assert.equal(tui.focused, editor, "opening never takes focus");

  host.uninstall();
  assert.deepEqual(entriesOf(root), before);
  assert.deepEqual(root.children, children);
  host.uninstall();
  assert.deepEqual(entriesOf(root), before);
  assert.deepEqual(root.children, children);
});

test("dock install refuses an unexpected root and outside fullscreen", () => {
  const editor = new Lines(["editor"]);
  const broken = new FakeTui(new VStack([new Lines(["a"])]), editor);
  assert.equal(
    createDockHost(broken, fakeSurface().surface, {
      width: () => 30,
      resizeTo: () => {},
    }).install(),
    false,
  );
  const { root } = chatViewport();
  const regular = new FakeTui(root, editor);
  regular.mode = "regular";
  const before = entriesOf(root);
  assert.equal(
    createDockHost(regular, fakeSurface().surface, {
      width: () => 30,
      resizeTo: () => {},
    }).install(),
    false,
  );
  assert.deepEqual(entriesOf(root), before);
});

test("dock focus and unfocus move keyboard focus to the pane and back", () => {
  const { root } = chatViewport();
  const editor = new Lines(["editor"]);
  const tui = new FakeTui(root, editor);
  const { surface, keys } = fakeSurface();
  const host = createDockHost(tui, surface, { width: () => 40, resizeTo: () => {} });
  host.install();
  host.focus();
  assert.notEqual(tui.focused, editor);
  assert.equal(host.isFocused(), true);
  tui.focused?.handleInput?.("j");
  assert.deepEqual(keys, ["j"]);
  host.unfocus();
  assert.equal(tui.focused, editor);
  host.focus();
  host.uninstall();
  assert.equal(tui.focused, editor, "uninstall returns focus");
});

test("width clamping keeps the pane and the transcript at their minimums", () => {
  assert.equal(maxPaneWidth(120), 79);
  assert.equal(clampPaneWidth(500, 120), 79);
  assert.equal(clampPaneWidth(3, 120), MIN_PANE_WIDTH);
  assert.equal(clampPaneWidth(50, 120), 50);
  assert.equal(clampPaneWidth(50.7, 120), 50);
  assert.equal(canHostPane(65), true);
  assert.equal(canHostPane(64), false);
});

test("border drag arithmetic: the pane takes every column right of the border", () => {
  assert.equal(widthFromBorderColumn(120, 70), 49);
  assert.equal(widthFromBorderColumn(120, 119), 0);
  const { root } = chatViewport();
  const tui = new FakeTui(root, new Lines(["editor"]));
  const resizes: number[] = [];
  const host = createDockHost(tui, fakeSurface().surface, {
    width: () => 40,
    resizeTo: (width) => resizes.push(width),
  });
  host.install();
  const row = root.children[0];
  assert.ok(row instanceof HStack);
  const border = row.children[1];
  assert.ok(border?.handleMouse);
  assert.deepEqual(border.handleMouse(mouse("press", 79)), {
    handled: true,
    capture: true,
    render: true,
  });
  border.handleMouse(mouse("drag", 60));
  border.handleMouse(mouse("drag", -5));
  border.handleMouse(mouse("release", 90));
  assert.deepEqual(resizes, [59, 124, 29]);
  border.handleMouse(mouse("drag", 10));
  assert.equal(resizes.length, 3, "drag after release is ignored");
});

test("overlay host is right-anchored, non-capturing, sized by getters, and hidden on uninstall", () => {
  const editor = new Lines(["editor"]);
  const tui = new FakeTui(undefined, editor);
  tui.children = [new Lines([]), new Lines(["e1", "e2"]), new Lines(["footer"])];
  let width = 30;
  const resizes: number[] = [];
  const host = createOverlayHost(tui, fakeSurface().surface, {
    width: () => width,
    resizeTo: (next) => resizes.push(next),
  });
  assert.equal(host.install(), true);
  const overlay = tui.overlays[0];
  assert.ok(overlay);
  assert.equal(overlay.options.anchor, "top-right");
  assert.equal(overlay.options.nonCapturing, true);
  assert.equal(overlay.options.width, 31);
  width = 50;
  assert.equal(overlay.options.width, 51);
  assert.equal(overlay.options.maxHeight, 37, "rows minus the three dock rows");
  assert.equal(tui.focused, editor);
  const lines = overlay.component.render(31);
  assert.equal(lines.length, 37);
  overlay.component.handleMouse?.({ ...mouse("press", 69), x: 0 });
  overlay.component.handleMouse?.(mouse("drag", 59));
  assert.deepEqual(resizes, [60]);
  host.uninstall();
  assert.equal(overlay.hidden, true);
  host.uninstall();
});
