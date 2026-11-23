import type { ProtocolDictionary } from "./runtime-values.ts";
import { isRuntimeString } from "./runtime-values.ts";

import { Text } from "../clients/deps/pi-tui.ts";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export interface CompactResultLike<D = unknown> {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: D;
}

export interface CompactSummaryInput<D = unknown> {
  details: D | undefined;
  args: ProtocolDictionary;
  isError: boolean;
  text: string;
  lineCount: number;
}

export type CompactSummarizer<D = unknown> = (input: CompactSummaryInput<D>) => string;

export type CompactStyle = "brand" | "error" | "output";

interface CompactTextSelection {
  text: string;
  style: CompactStyle;
}

const CHOCO_PI_LSP_BLUE_FG = "\x1b[1m\x1b[38;2;96;165;250m";
const RESET_FG = "\x1b[39m\x1b[22m";

export function fullTextOf(result: CompactResultLike): string {
  return (result.content ?? [])
    .filter(
      (c): c is { type: string; text: string } => c.type === "text" && isRuntimeString(c.text),
    )
    .map((c) => c.text)
    .join("\n");
}

export function selectCompactText<D = unknown>(
  result: CompactResultLike<D>,
  args: ProtocolDictionary,
  expanded: boolean,
  summarize: CompactSummarizer<D>,
): CompactTextSelection {
  const text = fullTextOf(result);
  if (expanded) {
    return {
      text: text || "(no output)",
      style: result.isError ? "error" : "output",
    };
  }
  const lineCount = text ? text.split("\n").length : 0;
  let summary: string;
  try {
    summary = summarize({
      details: result.details,
      args,
      isError: result.isError === true,
      text,
      lineCount,
    });
  } catch {
    summary = text.split("\n")[0] ?? "";
  }
  return { text: summary, style: result.isError ? "error" : "brand" };
}

export function paintCompact(style: CompactStyle, text: string, theme: Theme): string {
  if (style === "brand") {
    return `${CHOCO_PI_LSP_BLUE_FG}${text}${RESET_FG}`;
  }
  const color: ThemeColor = style === "error" ? "error" : "toolOutput";
  return theme.fg(color, text);
}

export function compactRenderResult<D = unknown>(summarize: CompactSummarizer<D>) {
  return (
    result: CompactResultLike<D>,
    options: { expanded: boolean },
    theme: Theme,
    context: { lastComponent?: unknown; args?: unknown },
  ): Text => {
    const component =
      context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const { text, style } = selectCompactText(
      result,
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      (context.args ?? {}) as ProtocolDictionary,
      options.expanded === true,
      summarize,
    );
    component.setText(paintCompact(style, text, theme));
    return component;
  };
}

export function baseName<T>(p: T): string {
  if (!isRuntimeString(p) || p.length === 0) return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
