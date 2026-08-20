/**
 * Color names that tool components use.
 * Structurally compatible with ThemeColor from @earendil-works/pi-coding-agent,
 * so a pi-coding-agent Theme instance satisfies this interface as-is.
 */
export type ToolThemeColor =
  | "accent"
  | "dim"
  | "error"
  | "muted"
  | "success"
  | "warning"
  | "toolTitle"
  | "toolOutput";

/**
 * Minimal theme interface for tool components.
 *
 * Structurally compatible with the `Theme` class from @earendil-works/pi-coding-agent.
 * Pass a pi-coding-agent Theme directly — no wrapper needed.
 */
export interface ToolTheme {
  fg(color: ToolThemeColor, text: string): string;
  bold(text: string): string;
}

/**
 * Options controlling how a tool result is rendered.
 * Structurally compatible with ToolRenderResultOptions from @earendil-works/pi-coding-agent.
 */
export interface ToolRenderOptions {
  /** Whether the result view is expanded */
  expanded: boolean;
  /** Whether this is a partial/streaming result */
  isPartial: boolean;
}
