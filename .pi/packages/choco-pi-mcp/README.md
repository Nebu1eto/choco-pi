# choco-pi-mcp

`choco-pi-mcp` is choco-pi's local, TypeScript-source fork of `pi-mcp-adapter` 2.26.1. It exposes `index.ts` as a Pi extension, `skills/` as Pi skills, and the `./types` and `./oauth` package exports.

Add `./packages/choco-pi-mcp` to the package list in `.pi/settings.json`. This package does not modify that file itself.

## MCP support

The fork keeps upstream's MCP SDK 2.0 client implementation. It supports the 2026-07-28 protocol revision, opt-in `protocolVersion: "auto"` negotiation with fallback to pre-2026 servers, and explicit legacy mode. The available transports are stdio, Streamable HTTP, and legacy HTTP+SSE. OAuth discovery, authorization, callback handling, secure credential storage, and token refresh remain included.

## Configuration files

On each load, `config.ts` checks these sources in increasing precedence:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. the Pi global override, normally `~/.pi/agent/mcp.json`
5. `<project>/.mcp.json`
6. `<project>/.pi/mcp.json`

The Pi global path follows the host package's `piConfig.name` and `piConfig.configDir`. `<APP_NAME>_CODING_AGENT_DIR` can replace the global agent directory, and `piConfig.configDir` can replace `.pi` for both default global and project paths.

The package reads additional files only when configured:

- `imports` entries, or `settings.hostConfigDiscovery: "on"`, can read Cursor (`~/.cursor/mcp.json`), Claude Code (`~/.claude/mcp.json`, `~/.claude.json`, or `~/.claude/claude_desktop_config.json`), Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`), Codex (`~/.codex/config.toml` or `~/.codex/config.json`), OpenCode (`~/.config/opencode/opencode.json` and the applicable project `opencode.json`), Windsurf (`~/.windsurf/mcp.json`), and VS Code (`<cwd>/.vscode/mcp.json`) configuration. Except OpenCode, the first existing candidate for each import kind is used.
- Each path in `settings.agentPluginPaths` can add `<plugin>/plugin.json` and `<plugin>/mcp.json`.

See `VENDORED.md` for provenance, dependency versions, and verification details.
