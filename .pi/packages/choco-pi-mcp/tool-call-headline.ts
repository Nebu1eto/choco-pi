/**
 * Splits an `mcp …` summary line into the bullet header and the detail shown
 * under the tree branch, so a call reads `MCP linear` / `save_document` rather
 * than repeating the raw prefixed tool name.
 *
 * Kept in its own module so it loads under Node's strip-only TypeScript mode:
 * the renderer it serves declares parameter properties, which that loader
 * rejects, and this function is worth testing directly.
 */
export interface McpCallHeadline {
  header: string;
  detail?: string;
}

export function splitMcpCallHeadline(title: string): McpCallHeadline {
  const call = title.match(/^mcp call (\S+)(?: @ (\S+))?$/);
  if (call) {
    const [, target, explicitServer] = call;
    const prefixed = target.match(/^mcp__([^_]+)_(.+)$/);
    const server = explicitServer ?? prefixed?.[1];
    const tool = prefixed?.[2] ?? target;
    return server ? { header: `MCP ${server}`, detail: tool } : { header: "MCP", detail: tool };
  }
  const action = title.match(/^mcp (\S+)(?: (.+))?$/);
  if (action) {
    const [, verb, rest] = action;
    return rest ? { header: `MCP ${verb}`, detail: rest } : { header: `MCP ${verb}` };
  }
  return { header: title };
}
