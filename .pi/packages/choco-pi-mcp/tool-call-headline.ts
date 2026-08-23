/**
 * Splits an `mcp …` summary line into the bullet header and the detail shown
 * under the tree branch, so a call reads `MCP: linear` / `save_document` rather
 * than repeating the raw prefixed tool name.
 *
 * The header carries the same `MCP:` category prefix the working line shows
 * for these calls, so one tool reads the same in both places.
 *
 * Kept in its own module so it loads under Node's strip-only TypeScript mode:
 * the renderer it serves declares parameter properties, which that loader
 * rejects, and this function is worth testing directly.
 */
export interface McpCallHeadline {
  header: string;
  detail?: string;
}

export interface McpCallTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

export function formatMcpDisplayName(value: string, capitalize = true): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words || !capitalize) return words || value;
  return `${words[0]!.toUpperCase()}${words.slice(1).toLowerCase()}`;
}

export function formatMcpDirectToolHeadline(server: string, tool: string): string {
  return `mcp call ${tool} @ ${server}`;
}

export function splitMcpCallHeadline(title: string): McpCallHeadline {
  const call = title.match(/^mcp call (\S+)(?: @ (\S+))?$/);
  if (call) {
    const [, target, explicitServer] = call;
    const prefixed = target.match(/^mcp__([^_]+)_(.+)$/);
    const server = explicitServer ?? prefixed?.[1];
    const tool = formatMcpDisplayName(prefixed?.[2] ?? target);
    return server
      ? { header: `MCP: ${formatMcpDisplayName(server, false)}`, detail: tool }
      : { header: "MCP", detail: tool };
  }
  const action = title.match(/^mcp (\S+)(?: (.+))?$/);
  if (action) {
    const [, verb, rest] = action;
    const header = `MCP: ${formatMcpDisplayName(verb)}`;
    const detail = rest?.replace(/^mcp__/, "");
    return detail ? { header, detail: formatMcpDisplayName(detail, false) } : { header };
  }
  return { header: title };
}

/**
 * Styles a call in the shared choco-pi tool shape: a dim bullet with a bold
 * header, then detail rows under a `└` branch. An entry may carry embedded
 * newlines (pretty-printed JSON args); every visual line gets the branch
 * indent, not only the entry's first line.
 */
export function styleMcpCallLines(lines: string[], theme: McpCallTheme): string[] {
  const bold = (text: string) => (theme.bold ? theme.bold(text) : text);
  const [title = "mcp", ...rest] = lines;
  const { header, detail } = splitMcpCallHeadline(title);
  const branchLines = [...(detail === undefined ? [] : [detail]), ...rest].flatMap((entry) =>
    entry.split("\n"),
  );
  const styled = [`${theme.fg("dim", "•")} ${theme.fg("toolTitle", bold(header))}`];
  for (const [index, line] of branchLines.entries()) {
    const prefix = index === 0 ? "  └ " : "    ";
    const body = index === 0 ? theme.fg("accent", line) : theme.fg("muted", line);
    styled.push(`${theme.fg("dim", prefix)}${body}`);
  }
  return styled;
}

/**
 * The one-line title for the compact collapsed row, matching the bulleted
 * shape of the expanded render: `• MCP: linear save_document` instead of the
 * raw `mcp call mcp__linear_save_document` headline.
 */
export function formatMcpCallCompactTitle(title: string): string {
  const { header, detail } = splitMcpCallHeadline(title);
  return detail === undefined ? header : `${header} · ${detail}`;
}
