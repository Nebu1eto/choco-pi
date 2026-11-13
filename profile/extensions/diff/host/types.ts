import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
  TuiInputListener,
  TuiMode,
} from "@earendil-works/pi-tui";
import { isFunction } from "../../lib/runtime-values.ts";

/**
 * The part of Pi's TUI the pane uses. The handle Pi hands to widget factories
 * is a proxy over whichever renderer is current, so `mode` and `terminal` are
 * read live on every call.
 */
export interface PaneTui {
  readonly mode: TuiMode;
  readonly terminal: { readonly columns: number; readonly rows: number };
  readonly children: readonly Component[];
  setFocus(component: Component | null): void;
  getFocusedComponent(): Component | null;
  requestRender(force?: boolean): void;
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
  addInputListener(listener: TuiInputListener): () => void;
}

/** Both hosts implement this, so the pane's view code does not know which one it runs in. */
export interface PaneHost {
  readonly kind: "dock" | "overlay";
  /** Mounts the pane; false when the host cannot mount it in the current layout. */
  install(): boolean;
  /** Removes everything `install` added. Safe to call more than once. */
  uninstall(): void;
  setWidth(width: number): void;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
  requestRender(): void;
}

type FocusQueryingTui = TUI & { getFocusedComponent(): Component | null };

// TuiBase declares getFocusedComponent publicly, but the TUI interface Pi
// passes to extensions omits it, so confirm it at runtime before relying on it.
function canQueryFocus(tui: TUI): tui is FocusQueryingTui {
  return "getFocusedComponent" in tui && isFunction(tui.getFocusedComponent);
}

/** Narrow the TUI handle from a widget factory to what the pane needs. */
export function toPaneTui(tui: TUI): PaneTui | undefined {
  return canQueryFocus(tui) ? tui : undefined;
}
