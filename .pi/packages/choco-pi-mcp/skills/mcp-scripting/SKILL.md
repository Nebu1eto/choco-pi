---
name: mcp-scripting
description: Discover Pi built-in MCP tools with tool_search and call activated tools through the exec bridge.
---

# MCP tools

Pi's `builtin:mcp` owns server connections and authentication. Use `/mcp` for server status and authentication. Native `figma_*` tools and `/figma-auth` remain independent.

1. Discover tools with `tool_search`; read the returned names and argument schemas.
2. Call an activated tool through the choco-pi `exec` bridge using its exact `mcp__<server>__<tool>` name: `await tools.mcp__server__tool(args)`.
3. Await each call, inspect its result, and handle failures before dependent calls. Compose independent calls with ordinary JavaScript and Promise utilities; use `text(result)` to emit bridge output.

Do not guess names or argument schemas. The adapter's `mcp`, `mcpScript`, `tools.search`, `tools.describe`, and `tools.call` APIs no longer exist. Pi's built-in codemode is disabled; MCP discovery uses deferred tools rather than the built-in codemode tool.
