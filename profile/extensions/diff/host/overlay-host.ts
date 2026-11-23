import type {
  Component,
  Focusable,
  OverlayHandle,
  OverlayOptions,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { BORDER_WIDTH, canHostPane, widthFromBorderColumn } from "./geometry.ts";
import { fallbackLines, guardSurface, pinRows, type GuardedSurface } from "./guard.ts";
import type { HostCallbacks, PaneSurface } from "../../lib/changes/view/surface.ts";
import type { PaneHost, PaneTui } from "./types.ts";

const BORDER_IDLE = "\u001b[2m│\u001b[22m";
const BORDER_ACTIVE = "\u001b[1m┃\u001b[22m";
const MIN_OVERLAY_ROWS = 3;

export function transcriptRows(tui: PaneTui): number {
  const columns = tui.terminal.columns;
  let dock = 0;
  for (const child of tui.children.slice(1)) dock += child.render(columns).length;
  return Math.max(MIN_OVERLAY_ROWS, tui.terminal.rows - dock);
}

class OverlayPane implements Component, Focusable {
  focused = false;
  dragging = false;
  selecting = false;
  scrollTop = 0;
  bodyRows = 0;
  private headerRows = 0;
  readonly tui: PaneTui;
  readonly surface: GuardedSurface;
  readonly callbacks: HostCallbacks;
  readonly requestFocus: () => void;

  constructor(
    tui: PaneTui,
    surface: GuardedSurface,
    callbacks: HostCallbacks,
    requestFocus: () => void,
  ) {
    this.tui = tui;
    this.surface = surface;
    this.callbacks = callbacks;
    this.requestFocus = requestFocus;
  }

  render(width: number): string[] {
    const drawn = this.surface.contain(() => this.draw(width), undefined);
    return drawn ?? fallbackLines(this.surface.renderFailure, width);
  }

  private draw(width: number): string[] {
    const height = transcriptRows(this.tui);
    const inner = Math.max(1, width - BORDER_WIDTH);
    const header = this.surface.renderHeader(inner, this.focused).slice(0, height);
    const body = this.surface.renderBody(inner, this.focused);
    this.bodyRows = Math.max(0, height - header.length);
    this.headerRows = header.length;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, body.length - this.bodyRows));
    const pinned = pinRows(
      body,
      this.scrollTop,
      this.surface.stickyRows(this.scrollTop, this.bodyRows),
    );
    const visible = [...header, ...pinned.slice(this.scrollTop, this.scrollTop + this.bodyRows)];
    while (visible.length < height) visible.push("");
    const glyph = this.dragging ? BORDER_ACTIVE : BORDER_IDLE;
    return visible.map((line) => glyph + truncateToWidth(line, inner, "…", true));
  }

  handleInput(data: string): void {
    this.surface.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.surface.contain(() => this.mouse(event), { handled: true });
  }

  private mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scrollTop = Math.max(0, this.scrollTop + (event.wheelDelta ?? 0));
      return { handled: true, render: true };
    }
    if (event.type === "press" && event.button === "left" && event.x === 0) {
      this.dragging = true;
      return { handled: true, capture: true, render: true };
    }
    if ((event.type === "drag" || event.type === "release") && this.dragging) {
      if (event.type === "release") this.dragging = false;
      this.callbacks.resizeTo(widthFromBorderColumn(this.tui.terminal.columns, event.screenX));
      return { handled: true, render: true };
    }
    const visible = event.y - this.headerRows;
    const onBody = event.x >= BORDER_WIDTH && visible >= 0 && visible < this.bodyRows;
    if (event.type === "press" && event.button === "left" && onBody) {
      const row = this.scrollTop + visible;
      if (this.surface.pointer({ kind: "press", row, extend: event.shift })) {
        this.selecting = true;
        this.requestFocus();
        return { handled: true, capture: true, render: true };
      }
    }
    if (event.type === "press" && event.button === "left") return { handled: true, render: false };
    if (event.type === "drag" && this.selecting) {
      const row = this.scrollTop + Math.max(-1, Math.min(this.bodyRows, visible));
      this.surface.pointer({ kind: "drag", row });
      return { handled: true };
    }
    if (event.type === "release" && this.selecting) {
      this.selecting = false;
      return { handled: true };
    }
    if (event.type === "click") {
      this.requestFocus();
      if (event.button === "left" && onBody) {
        this.surface.pointer({ kind: "click", row: this.scrollTop + visible });
      }
      return { handled: true, render: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.surface.invalidate();
  }
}

export function createOverlayHost(
  tui: PaneTui,
  view: PaneSurface,
  callbacks: HostCallbacks,
): PaneHost {
  let handle: OverlayHandle | undefined;
  const surface = guardSurface(view, callbacks);
  const pane = new OverlayPane(tui, surface, callbacks, () => host.focus());

  surface.attachScroller({
    top: () => pane.scrollTop,
    viewportHeight: () => pane.bodyRows,
    scrollTo: (top) => {
      pane.scrollTop = Math.max(0, top);
    },
    scrollBy: (lines) => {
      pane.scrollTop = Math.max(0, pane.scrollTop + lines);
    },
  });

  const options: OverlayOptions = {
    anchor: "top-right",
    margin: 0,
    nonCapturing: true,
    get width() {
      return surface.contain(() => callbacks.width(), 1) + BORDER_WIDTH;
    },
    get maxHeight() {
      return surface.contain(() => transcriptRows(tui), 3);
    },
    visible: (columns) => surface.contain(() => canHostPane(columns), false),
  };

  const host: PaneHost = {
    kind: "overlay",
    install() {
      if (handle) return true;
      if (tui.mode !== "fullscreen") return false;
      handle = tui.showOverlay(pane, options);
      tui.requestRender();
      return true;
    },
    uninstall() {
      if (!handle) return;
      const current = handle;
      handle = undefined;
      pane.dragging = false;
      pane.selecting = false;
      current.hide();
      tui.requestRender();
    },
    setWidth() {
      tui.requestRender();
    },
    focus() {
      handle?.focus();
      tui.requestRender();
    },
    unfocus() {
      if (handle?.isFocused()) handle.unfocus();
      tui.requestRender();
    },
    isFocused() {
      return handle?.isFocused() ?? false;
    },
    requestRender() {
      tui.requestRender();
    },
  };
  return host;
}
