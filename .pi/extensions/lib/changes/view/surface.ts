/** What a host needs from the changes view, and what the view needs from a host. */
import type { RuntimeValue } from "../../runtime-values.ts";

/** Vertical scrolling of the pane body, implemented by each host. */
export interface PaneScroller {
  top(): number;
  /** Body rows currently visible; 0 before the first layout. */
  viewportHeight(): number;
  scrollTo(top: number): void;
  scrollBy(lines: number): void;
}

/**
 * A left-button mouse gesture on the body. `row` counts body rows from the
 * first one drawn, scrolled-off rows included; a drag may name a row outside
 * the body. `extend` is Shift held on a press.
 */
export type PointerGesture = { kind: "press" | "drag" | "click"; row: number; extend?: boolean };

/** The host-independent pane content and key handling. */
export interface PaneSurface {
  renderHeader(width: number, focused: boolean): string[];
  renderBody(width: number, focused: boolean): string[];
  /**
   * The rows to draw over the first visible body rows when the first is `top`
   * (as of the last `renderBody`) in a viewport `height` rows tall: the open
   * file's row and its hunk's header once they scrolled off. Empty when
   * nothing is pinned; never all `height` rows.
   */
  stickyRows?(top: number, height: number): string[];
  handleKey(data: string): void;
  /**
   * True when the view acted on the gesture. A press it acts on starts a
   * line selection: the host sends it the drags that follow until the release.
   */
  pointer?(gesture: PointerGesture): boolean;
  attachScroller(scroller: PaneScroller): void;
  invalidate(): void;
}

/** Calls a host makes back into the pane controller. */
export interface HostCallbacks {
  /** Current pane width, already clamped to the terminal. */
  width(): number;
  /** The user dragged the border; `width` is unclamped. */
  resizeTo(width: number): void;
  /**
   * The host contained a throw from the view or from its own pi-tui callbacks.
   * A render failure is reported once per host and the view is not drawn
   * again; an input failure each time. Must not throw.
   */
  failed?(kind: "render" | "input", error: RuntimeValue): void;
}

/** Columns one press of a resize key moves the pane border. */
export const KEYBOARD_RESIZE_STEP = 4;
