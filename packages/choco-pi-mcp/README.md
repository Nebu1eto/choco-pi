# choco-pi-mcp

`choco-pi-mcp` loads choco-pi's native Figma tools (`figma/index.ts`) and the `figma` and `mcp-scripting` skills. Despite its name, it no longer contains an MCP client: Pi's built-in MCP owns server configuration, authentication, `/mcp`, and the `mcp__<server>__<tool>` tools.

The profile installer lists it by absolute path (`<checkout>/packages/choco-pi-mcp`) in the agent directory's `settings.json`. Its `chocoPi.supersedes` entry makes the profile installer remove `pi-mcp-adapter` and `pi-mono-figma` from the global profile.

- Figma authentication: `/figma-auth`; usage is in [`skills/figma/SKILL.md`](skills/figma/SKILL.md).
- MCP server configuration: `~/.pi/agent/mcp.json` in Pi's built-in format (`$CHOCO_PI_HOME/agent/mcp.json` under the standalone `choco-pi` launcher). `node scripts/translate-mcp-config.ts` (from the repository root) converts a configuration written for the retired adapter.

[`VENDORED-figma.md`](VENDORED-figma.md) records the Figma fork. [`VENDORED.md`](VENDORED.md) records the retired `pi-mcp-adapter` fork and its removal.
