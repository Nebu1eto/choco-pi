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

const TAKEN_PRESS: TuiMouseEventResult = { handled: true, render: false };

class PaneBody implements Component, Focusable {
  focused = false;
  readonly capturesViewportInput = true;
  selecting = false;
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
        if (!pressed) return TAKEN_PRESS;
        this.selecting = true;
        this.surface.contain(() => this.requestFocus(), undefined);
        return { handled: true, capture: true, render: true };
      }
      case "drag": {
        if (!this.selecting) return undefined;
        this.surface.contain(() => {
          const { top, height } = this.viewport();
          const visible = Math.max(-1, Math.min(height, event.screenY - this.viewportTop));
          this.surface.pointer({ kind: "drag", row: top + visible });
        }, undefined);
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
        if (!mounted || relayoutQueued || mounted.appliedWidth === callbacks.width()) return;
        relayoutQueued = true;
        queueMicrotask(() => {
          relayoutQueued = false;
          if (!mounted) return;
          const target = mounted;
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
