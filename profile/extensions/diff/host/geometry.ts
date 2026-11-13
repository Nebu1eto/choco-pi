/**
 * Width rules shared by every pane host.
 *
 * `width` always means the pane's content columns. Both hosts draw one more
 * column to its left: the border, which is also the drag handle.
 */
export { KEYBOARD_RESIZE_STEP } from "../../lib/changes/view/surface.ts";

export const MIN_PANE_WIDTH = 24;
export const MIN_TRANSCRIPT_WIDTH = 40;
export const BORDER_WIDTH = 1;
export const DEFAULT_PANE_WIDTH = 56;

/** Widest pane that still leaves the transcript its minimum width. */
export function maxPaneWidth(columns: number): number {
  return columns - MIN_TRANSCRIPT_WIDTH - BORDER_WIDTH;
}

/** Whether a terminal this wide can show the pane next to a usable transcript. */
export function canHostPane(columns: number): boolean {
  return maxPaneWidth(columns) >= MIN_PANE_WIDTH;
}

/** Clamp a requested width to the terminal; never below the pane minimum. */
export function clampPaneWidth(width: number, columns: number): number {
  const requested = Number.isFinite(width) ? Math.floor(width) : DEFAULT_PANE_WIDTH;
  return Math.max(MIN_PANE_WIDTH, Math.min(requested, maxPaneWidth(columns)));
}

/**
 * Pane width implied by the border sitting at absolute column `borderColumn`
 * (zero-based): everything to the right of the border belongs to the pane.
 */
export function widthFromBorderColumn(columns: number, borderColumn: number): number {
  return columns - borderColumn - BORDER_WIDTH;
}
