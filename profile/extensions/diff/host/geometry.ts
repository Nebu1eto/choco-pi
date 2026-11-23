export { KEYBOARD_RESIZE_STEP } from "../../lib/changes/view/surface.ts";

export const MIN_PANE_WIDTH = 24;
export const MIN_TRANSCRIPT_WIDTH = 40;
export const BORDER_WIDTH = 1;
export const DEFAULT_PANE_WIDTH = 56;

export function maxPaneWidth(columns: number): number {
  return columns - MIN_TRANSCRIPT_WIDTH - BORDER_WIDTH;
}

export function canHostPane(columns: number): boolean {
  return maxPaneWidth(columns) >= MIN_PANE_WIDTH;
}

export function clampPaneWidth(width: number, columns: number): number {
  const requested = Number.isFinite(width) ? Math.floor(width) : DEFAULT_PANE_WIDTH;
  return Math.max(MIN_PANE_WIDTH, Math.min(requested, maxPaneWidth(columns)));
}

export function widthFromBorderColumn(columns: number, borderColumn: number): number {
  return columns - borderColumn - BORDER_WIDTH;
}
