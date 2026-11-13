/**
 * Dock host: the pane becomes a real column beside the transcript.
 *
 * Pi internals this depends on (checked by `inspectHostRoot` before any
 * change): the private `layoutRoot` field of the fullscreen renderer and its
 * `VStack[ScrollView, dock]` structure. Install swaps entry 0 for an `HStack`
 * of the same transcript, a one-column border and the pane; uninstall puts the
 * original two entries back. Because Pi keeps mounting the same root object,
 * the change survives a fullscreen/regular round trip without reinstalling.
 *
 * Mouse: pi-tui gives a component coordinates local to it, and a scrolled
 * component its own rows, so a body event's `y` is the body row. It offers an
 * event to every component under the pointer, innermost first, until one
 * handles it; the row (`PaneRow`) is therefore asked after the transcript's
 * own components declined, which is how a press beside the pane is seen.
 *
 * Wheel: pi-tui scrolls the scroll views under the pointer only when no
 * component handled the wheel event, and then passes whatever the innermost
 * view could not take on to the transcript, whatever that view's overscroll
 * setting. The row therefore scrolls the pane itself for a wheel anywhere on
 * the pane's columns and reports it handled, so the transcript never moves.
 */
import type {
  Component,
  Focusable,
  StackEntry,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { HStack, ScrollView, VStack } from "@earendil-works/pi-tui";
import { BORDER_WIDTH, canHostPane, widthFromBorderColumn } from "./geometry.ts";
import { guardSurface, pinRows, type GuardedSurface } from "./guard.ts";
import { inspectHostRoot, readLayoutRoot, type DockableLayout } from "./layout.ts";
import type { HostCallbacks, PaneSurface } from "../../lib/changes/view/surface.ts";
import type { PaneHost, PaneTui } from "./types.ts";

const BORDER_IDLE = "\u001b[2m│\u001b[22m";
const BORDER_ACTIVE = "\u001b[1m┃\u001b[22m";

type Viewport = { top: number; height: number };

/**
 * A left press the pane takes without acting on it. Pi starts a text selection
 * on a press nothing takes and copies it when the button is released; inside
 * the pane a press selects diff lines or leads to a click instead.
 */
const TAKEN_PRESS: TuiMouseEventResult = { handled: true, render: false };

class PaneBody implements Component, Focusable {
  focused = false;
  readonly capturesViewportInput = true;
  /** A press on a line started a selection; drags extend it until the release. */
  selecting = false;
  /** Screen row of the first visible body row, as of that press. */
  private viewportTop = 0;
  readonly surface: GuardedSurface;
  readonly requestFocus: () => void;
  readonly viewport: () => Viewport;

  constructor(surface: GuardedSurface, requestFocus: () => void, viewport: () => Viewport) {
    this.surface = surface;
    this.requestFocus = requestFocus;
    this.viewport = viewport;
  }

  render(width: number): string[] {
    const lines = this.surface.renderBody(width, this.focused);
    // pi-tui clamps the scroll position after this render, without drawing
    // again; clamping the same way puts the pinned row on the first visible line.
    const { top, height } = this.viewport();
    const first = Math.max(0, Math.min(top, lines.length - height));
    return pinRows(lines, first, this.surface.stickyRows(first, height));
  }

  handleInput(data: string): void {
    this.surface.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    switch (event.type) {
      case "press": {
        if (event.button !== "left") return undefined;
        const pressed = this.surface.contain(() => {
          this.viewportTop = event.screenY - (event.y - this.viewport().top);
          return this.surface.pointer({ kind: "press", row: event.y, extend: event.shift });
        }, false);
        // Not on a line: the press is still taken, or Pi would start its own text
        // selection here and copy it on release. pi-tui sends the click to whoever took it.
        if (!pressed) return TAKEN_PRESS;
        this.selecting = true;
        this.surface.contain(() => this.requestFocus(), undefined);
        return { handled: true, capture: true, render: true };
      }
      case "drag": {
        if (!this.selecting) return undefined;
        this.surface.contain(() => {
          // The body scrolls under a held button, so the row is read from the screen: at
          // most one row past either edge, which scrolls the selection a row at a time.
          const { top, height } = this.viewport();
          const visible = Math.max(-1, Math.min(height, event.screenY - this.viewportTop));
          this.surface.pointer({ kind: "drag", row: top + visible });
        }, undefined);
        // The view asks for a frame itself, and only when the selection changed.
        return { handled: true };
      }
      case "release":
        if (!this.selecting) return undefined;
        this.selecting = false;
        return { handled: true };
      case "click":
        this.surface.contain(() => this.requestFocus(), undefined);
        if (event.button === "left") this.surface.pointer({ kind: "click", row: event.y });
        return { handled: true, render: true };
      default:
        return undefined;
    }
  }

  invalidate(): void {
    this.surface.invalidate();
  }
}

class PaneHeader implements Component {
  readonly surface: GuardedSurface;
  readonly body: PaneBody;

  constructor(surface: GuardedSurface, body: PaneBody) {
    this.surface = surface;
    this.body = body;
  }

  render(width: number): string[] {
    return this.surface.renderHeader(width, this.body.focused);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press" && event.button === "left") return TAKEN_PRESS;
    if (event.type !== "click") return undefined;
    this.surface.contain(() => this.body.requestFocus(), undefined);
    return { handled: true, render: true };
  }

  invalidate(): void {}
}

/** The one-column drag handle between the transcript and the pane. */
export class BorderHandle implements Component {
  dragging = false;
  readonly rows: () => number;
  readonly onDrag: (screenX: number) => void;
  readonly onFrame: () => void;

  constructor(rows: () => number, onDrag: (screenX: number) => void, onFrame: () => void) {
    this.rows = rows;
    this.onDrag = onDrag;
    this.onFrame = onFrame;
  }

  render(_width: number): string[] {
    this.onFrame();
    const glyph = this.dragging ? BORDER_ACTIVE : BORDER_IDLE;
    return Array.from({ length: Math.max(1, this.rows()) }, () => glyph);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The wheel scrolls the pane; the row does that. A press with another button
    // includes a horizontal wheel, which pi-tui reports as a press with no
    // release: taking it would leave the border the target of the next press.
    if (event.type === "wheel") return undefined;
    if (event.type === "press" && event.button !== "left") return undefined;
    if (event.type === "press" && event.button === "left") {
      this.dragging = true;
      return { handled: true, capture: true, render: true };
    }
    if (event.type === "drag" && this.dragging) {
      this.onDrag(event.screenX);
      return { handled: true, render: true };
    }
    if (event.type === "release" && this.dragging) {
      this.dragging = false;
      this.onDrag(event.screenX);
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  invalidate(): void {}
}

/**
 * The transcript, the border and the pane side by side. A left press on the
 * transcript's columns gives keyboard focus back to what had it before the
 * pane, and is left unhandled so Pi still starts its text selection there. On
 * the pane's columns the row takes what nothing in the pane took (the space
 * under a short list): the press, so that Pi selects and copies nothing in
 * the pane, and the click, which focuses the pane. A wheel on the pane's
 * columns, header and border included, scrolls the pane and nothing else.
 * Other buttons, which include a horizontal wheel, are left to pi-tui, which
 * does nothing with them.
 */
class PaneRow extends HStack {
  readonly paneColumn: (width: number) => number;
  readonly leavePane: () => void;
  readonly enterPane: () => void;
  readonly scrollPane: (lines: number) => void;

  constructor(
    paneColumn: (width: number) => number,
    leavePane: () => void,
    enterPane: () => void,
    scrollPane: (lines: number) => void,
  ) {
    super();
    this.paneColumn = paneColumn;
    this.leavePane = leavePane;
    this.enterPane = enterPane;
    this.scrollPane = scrollPane;
  }

  // pi-tui does not export the result type its containers return.
  handleMouse(event: TuiMouseEvent): ReturnType<HStack["handleMouse"]> {
    if (event.type === "wheel") {
      if (event.x < this.paneColumn(event.width)) return undefined;
      this.scrollPane(event.wheelDelta ?? 0);
      return this.taken(event, true);
    }
    if (event.button !== "left") return undefined;
    const inPane = event.x >= this.paneColumn(event.width);
    if (event.type === "press" && !inPane) this.leavePane();
    if (!inPane || (event.type !== "press" && event.type !== "click")) return undefined;
    if (event.type === "click") this.enterPane();
    return this.taken(event, event.type === "click");
  }

  private taken(event: TuiMouseEvent, render: boolean): ReturnType<HStack["handleMouse"]> {
    return {
      handled: true,
      render,
      // The row itself took the event: the shape pi-tui's containers report for a child.
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }
}

type Mounted = {
  layout: DockableLayout;
  row: PaneRow;
  appliedWidth: number;
};

export function createDockHost(
  tui: PaneTui,
  view: PaneSurface,
  callbacks: HostCallbacks,
): PaneHost {
  let mounted: Mounted | undefined;
  let focusBefore: Component | null = null;
  let relayoutQueued = false;
  const surface = guardSurface(view, callbacks);

  const body = new PaneBody(
    surface,
    () => host.focus(),
    () => ({ top: scroll.scrollTop, height: scroll.viewportHeight }),
  );
  const header = new PaneHeader(surface, body);
  const scroll = new ScrollView(body, { follow: "none", overscroll: "contain", scrollbar: "auto" });
  const paneBox = new VStack([
    { component: header, basis: "auto", grow: 0, shrink: 0 },
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
  ]);
  const border = new BorderHandle(
    () => surface.contain(() => tui.terminal.rows, 1),
    (screenX) =>
      surface.contain(
        () => callbacks.resizeTo(widthFromBorderColumn(tui.terminal.columns, screenX)),
        undefined,
      ),
    () =>
      surface.contain(() => {
        // Terminal resizes change the clamp; re-apply the width after this frame.
        if (!mounted || relayoutQueued || mounted.appliedWidth === callbacks.width()) return;
        relayoutQueued = true;
        queueMicrotask(() => {
          relayoutQueued = false;
          if (!mounted) return;
          const target = mounted;
          // Runs outside any pi-tui call, so nothing above would catch a throw.
          surface.contain(() => {
            layoutRow(target, callbacks.width());
            tui.requestRender();
          }, undefined);
        });
      }, undefined),
  );

  surface.attachScroller({
    top: () => scroll.scrollTop,
    viewportHeight: () => scroll.viewportHeight,
    scrollTo: (top) => scroll.scrollTo(top),
    scrollBy: (lines) => {
      scroll.scrollBy(lines);
    },
  });

  const fits = (viewport: { width: number }) => canHostPane(viewport.width);

  function layoutRow(target: Mounted, width: number): void {
    target.appliedWidth = width;
    target.row.clear();
    target.row.addChild(target.layout.transcript, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    target.row.addChild(border, { basis: BORDER_WIDTH, grow: 0, shrink: 0, visible: fits });
    target.row.addChild(paneBox, { basis: width, grow: 0, shrink: 0, visible: fits });
  }

  function restoreEntries(root: VStack, entries: readonly StackEntry[]): void {
    root.clear();
    for (const entry of entries) root.addChild(entry.component, entry);
  }

  const host: PaneHost = {
    kind: "dock",
    install() {
      if (mounted) return true;
      if (tui.mode !== "fullscreen") return false;
      const layout = inspectHostRoot(readLayoutRoot(tui));
      if (!layout) return false;
      const row = new PaneRow(
        (width) =>
          surface.contain(
            () => (canHostPane(width) ? width - callbacks.width() - BORDER_WIDTH : width),
            width,
          ),
        () =>
          surface.contain(() => {
            if (host.isFocused()) host.unfocus();
          }, undefined),
        () => surface.contain(() => host.focus(), undefined),
        // The pane's own scroll view clamps to its content.
        (lines) =>
          surface.contain(() => {
            scroll.scrollBy(lines);
          }, undefined),
      );
      const target: Mounted = { layout, row, appliedWidth: 0 };
      layoutRow(target, callbacks.width());
      const [transcriptEntry, dockEntry] = layout.entries;
      restoreEntries(layout.root, [{ ...transcriptEntry, component: target.row }, dockEntry]);
      mounted = target;
      tui.requestRender();
      return true;
    },
    uninstall() {
      if (!mounted) return;
      const target = mounted;
      host.unfocus();
      mounted = undefined;
      // Restore only while our row is still in place; if something else has
      // since rebuilt the root, writing old entries back would break it.
      if (target.layout.root.children[0] === target.row) {
        restoreEntries(target.layout.root, target.layout.entries);
      }
      target.row.clear();
      border.dragging = false;
      body.selecting = false;
      tui.requestRender();
    },
    setWidth(width) {
      if (!mounted || mounted.appliedWidth === width) return;
      layoutRow(mounted, width);
      tui.requestRender();
    },
    focus() {
      if (!mounted) return;
      const current = tui.getFocusedComponent();
      if (current !== body) focusBefore = current;
      tui.setFocus(body);
      tui.requestRender();
    },
    unfocus() {
      if (tui.getFocusedComponent() === body) tui.setFocus(focusBefore);
      focusBefore = null;
      tui.requestRender();
    },
    isFocused() {
      return mounted !== undefined && tui.getFocusedComponent() === body;
    },
    requestRender() {
      tui.requestRender();
    },
  };
  return host;
}
