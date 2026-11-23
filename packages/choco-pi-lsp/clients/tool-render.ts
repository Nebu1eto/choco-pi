import { isString } from "./runtime-guards.ts";

import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "./deps/pi-tui.ts";
import { stripAnsi } from "./sanitize.ts";
import { fitLines } from "./tui-fit.ts";

const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

interface CompactLineResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function fullTextOf(result: CompactLineResultLike): string {
  return (result.content ?? [])
    .filter((c): c is { type: string; text: string } => c.type === "text" && isString(c.text))
    .map((c) => c.text)
    .join("\n");
}

export function buildCompactToolLine(summaryText: string, isError: boolean, theme: Theme): string {
  const glyph = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const detailColor = isError ? "error" : "toolOutput";
  const sepIndex = summaryText.indexOf(" — ");
  if (sepIndex === -1) {
    return `${glyph} ${theme.fg(detailColor, summaryText)}`;
  }
  const namePart = summaryText.slice(0, sepIndex);
  const detailPart = summaryText.slice(sepIndex + " — ".length);
  const styledName = theme.fg("toolTitle", theme.bold(namePart));
  const styledDash = theme.fg("dim", "—");
  const styledDetail = theme.fg(detailColor, detailPart);
  return `${glyph} ${styledName} ${styledDash} ${styledDetail}`;
}

function captureComponentText(component: Component): string {
  try {
    const lines = component.render(4096);
    return stripAnsi(lines.join(" ")).trim();
  } catch {
    return "";
  }
}

export function wrapToolForCompactLine<T extends ToolDefinition<any, any, any>>(tool: T): T {
  const originalRenderResult = tool.renderResult;
  if (!originalRenderResult) return tool;
  const originalRenderCall = tool.renderCall;

  const renderCall: ToolDefinition<any, any, any>["renderCall"] = (args, theme, context) => {
    if (!context.expanded && context.isPartial === false) {
      return EMPTY_COMPONENT;
    }
    if (originalRenderCall) return originalRenderCall(args, theme, context);
    const line = theme.fg("toolTitle", theme.bold(tool.name));
    return {
      render: (width: number) => fitLines([line], width),
      invalidate: () => {},
    };
  };

  const renderResult: ToolDefinition<any, any, any>["renderResult"] = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) {
      return originalRenderResult(result, options, theme, context);
    }
    let summaryText: string;
    try {
      const probeContext = { ...context, lastComponent: undefined };
      const component = originalRenderResult(
        result,
        { ...options, expanded: false },
        theme,
        probeContext,
      );
      summaryText = captureComponentText(component);
    } catch {
      summaryText = "";
    }

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const resultLike = result as CompactLineResultLike;
    if (!summaryText) {
      summaryText = stripAnsi(fullTextOf(resultLike).split("\n")[0] ?? "").trim();
    }

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const contextIsError = (context as { isError?: boolean } | undefined)?.isError;
    const isError = contextIsError ?? resultLike.isError === true;
    const line = buildCompactToolLine(summaryText, isError === true, theme);
    return {
      render: (width: number) => fitLines([line], width),
      invalidate: () => {},
    };
  };

  return { ...tool, renderCall, renderResult };
}

export function wrapToolsForCompactLine<T extends ToolDefinition<any, any, any>>(
  tools: readonly T[],
): T[] {
  return tools.map((tool) => wrapToolForCompactLine(tool));
}
