/**
 * Dock host: the pane becomes a real column beside the transcript.
 *
 * Pi internals this depends on (checked by `inspectHostRoot` before any
 * change): the private `layoutRoot` field of the fullscreen renderer and its
 * `VStack[ScrollView, dock]` structure. Install swaps entry 0 for an `HStack`
 * of the same transcript, a one-column border and the pane; uninstall puts the
 * original two entries back. Because Pi keeps mounting the same root object,
 * the change survives a fullscreen/regular round trip without reinstalling.
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
import { guardSurface, type GuardedSurface } from "./guard.ts";
import { inspectHostRoot, readLayoutRoot, type DockableLayout } from "./layout.ts";
import type { HostCallbacks, PaneSurface } from "../../lib/changes/view/surface.ts";
import type { PaneHost, PaneTui } from "./types.ts";

const BORDER_IDLE = "\u001b[2m│\u001b[22m";
const BORDER_ACTIVE = "\u001b[1m┃\u001b[22m";

class PaneBody implements Component, Focusable {
  focused = false;
  readonly capturesViewportInput = true;
  readonly surface: GuardedSurface;
  readonly requestFocus: () => void;

  constructor(surface: GuardedSurface, requestFocus: () => void) {
    this.surface = surface;
    this.requestFocus = requestFocus;
  }

  render(width: number): string[] {
    return this.surface.renderBody(width, this.focused);
  }

  handleInput(data: string): void {
    this.surface.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click") return undefined;
    this.surface.contain(() => this.requestFocus(), undefined);
    return { handled: true, render: true };
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

type Mounted = {
  layout: DockableLayout;
  row: HStack;
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

  const body = new PaneBody(surface, () => host.focus());
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
      const target: Mounted = { layout, row: new HStack(), appliedWidth: 0 };
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
