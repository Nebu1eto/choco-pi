import type { RuntimeValue } from "../../runtime-values.ts";

export interface PaneScroller {
  top(): number;
  viewportHeight(): number;
  scrollTo(top: number): void;
  scrollBy(lines: number): void;
}

export type PointerGesture = { kind: "press" | "drag" | "click"; row: number; extend?: boolean };

export interface PaneSurface {
  renderHeader(width: number, focused: boolean): string[];
  renderBody(width: number, focused: boolean): string[];
  stickyRows?(top: number, height: number): string[];
  handleKey(data: string): void;
  pointer?(gesture: PointerGesture): boolean;
  attachScroller(scroller: PaneScroller): void;
  invalidate(): void;
}

export interface HostCallbacks {
  width(): number;
  resizeTo(width: number): void;
  failed?(kind: "render" | "input", error: RuntimeValue): void;
}

export const KEYBOARD_RESIZE_STEP = 4;
