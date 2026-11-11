/**
 * Overlay host: the fallback when the layout root is not the one the dock host
 * knows. A non-capturing overlay anchored top-right, limited to the transcript
 * rows so it never covers the editor or footer.
 *
 * Pi internals this depends on: the mount order of `tui.children` (transcript
 * document first, then the dock), used to measure how many rows the dock
 * takes, and the TUI re-reading `width` and `maxHeight` from the options
 * object every frame, which lets getters resize the overlay live.
 *
 * Pi does not remove `tui.showOverlay` overlays when a session ends, and it
 * refuses to change TUI mode while one is mounted, so the caller must
 * uninstall on `session_shutdown` and tell the user about the mode switch.
 */
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
import { fallbackLines, guardSurface, type GuardedSurface } from "./guard.ts";
import type { HostCallbacks, PaneSurface } from "../../lib/changes/view/surface.ts";
import type { PaneHost, PaneTui } from "./types.ts";

const BORDER_IDLE = "\u001b[2m│\u001b[22m";
const BORDER_ACTIVE = "\u001b[1m┃\u001b[22m";
const MIN_OVERLAY_ROWS = 3;

/** Rows above the dock: the terminal height minus everything mounted after the transcript. */
export function transcriptRows(tui: PaneTui): number {
  const columns = tui.terminal.columns;
  let dock = 0;
  for (const child of tui.children.slice(1)) dock += child.render(columns).length;
  return Math.max(MIN_OVERLAY_ROWS, tui.terminal.rows - dock);
}

class OverlayPane implements Component, Focusable {
  focused = false;
  dragging = false;
  /** A press on a line started a selection; drags extend it until the release. */
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
    // The view's calls are guarded one by one; this covers the host's own
    // drawing (the dock measurement renders Pi's other components).
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
    const visible = [...header, ...body.slice(this.scrollTop, this.scrollTop + this.bodyRows)];
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
    // The body row under the pointer, counted from the first visible one.
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
    // Any other left press is taken too, or Pi would start its own text selection
    // in the pane and copy it on release. pi-tui still sends the click here.
    if (event.type === "press" && event.button === "left") return { handled: true, render: false };
    if (event.type === "drag" && this.selecting) {
      // At most one row past either edge, so the selection scrolls the body a row at a time.
      const row = this.scrollTop + Math.max(-1, Math.min(this.bodyRows, visible));
      this.surface.pointer({ kind: "drag", row });
      // The view asks for a frame itself, and only when the selection changed.
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
    // pi-tui reads these while compositing, outside the pane's own render.
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
      // The width getter is re-read every frame.
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
