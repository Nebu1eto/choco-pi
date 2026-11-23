import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
  TuiInputListener,
  TuiMode,
} from "@earendil-works/pi-tui";
import { isFunction } from "../../lib/runtime-values.ts";

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

export interface PaneHost {
  readonly kind: "dock" | "overlay";
  install(): boolean;
  uninstall(): void;
  setWidth(width: number): void;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
  requestRender(): void;
}

type FocusQueryingTui = TUI & { getFocusedComponent(): Component | null };

function canQueryFocus(tui: TUI): tui is FocusQueryingTui {
  return "getFocusedComponent" in tui && isFunction(tui.getFocusedComponent);
}

export function toPaneTui(tui: TUI): PaneTui | undefined {
  return canQueryFocus(tui) ? tui : undefined;
}
