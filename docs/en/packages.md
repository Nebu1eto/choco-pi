# Installed packages

[한국어](../ko/packages.md)

The profile loads the 17 local packages in this table. The agent directory's `settings.json` lists them by absolute path under `packages`. An eighteenth package, [`@choco-pi/acp`](../../packages/choco-pi-acp) 1.0.0-alpha.1, is not loaded by Pi: it runs as a separate ACP process for editors (see [Use choco-pi in Zed](zed-setup.md)).

| Package                                                                      |       Version | Purpose                                                         |
| ---------------------------------------------------------------------------- | ------------: | --------------------------------------------------------------- |
| [`@choco-pi/web-search`](../../packages/choco-pi-web-search)                 | 1.0.0-alpha.1 | Session-scoped routing for the canonical web search tool        |
| [`@choco-pi/web-access`](../../packages/choco-pi-web-access)                 | 1.0.0-alpha.1 | Web search, source checks, and content extraction               |
| [`@choco-pi/provider-synthetic`](../../packages/choco-pi-provider-synthetic) | 1.0.0-alpha.1 | Synthetic provider, authentication, usage, and search           |
| [`@choco-pi/ui`](../../packages/choco-pi-ui)                                 | 1.0.0-alpha.1 | TUI, status line, preferences, and Nord themes                  |
| [`@choco-pi/shells`](../../packages/choco-pi-shells)                         | 1.0.0-alpha.1 | Background shell processes scoped to the session that owns them |
| [`@choco-pi/hooks`](../../packages/choco-pi-hooks)                           | 1.0.0-alpha.1 | Claude Code-compatible lifecycle hooks                          |
| [`@choco-pi/subagents`](../../packages/choco-pi-subagents)                   | 1.0.0-alpha.1 | Subagents, workflows, sessions, and the fleet UI                |
| [`@choco-pi/advisor`](../../packages/choco-pi-advisor)                       | 1.0.0-alpha.1 | Read-only advisor consults through subagents                    |
| [`@choco-pi/editor-context`](../../packages/choco-pi-editor-context)         | 1.0.0-alpha.1 | Editor-context protocol, storage, and injection                 |
| [`@choco-pi/goal`](../../packages/choco-pi-goal)                             | 1.0.0-alpha.1 | Persistent Codex-style goals                                    |
| [`@choco-pi/mcp`](../../packages/choco-pi-mcp)                               | 1.0.0-alpha.1 | Native Figma tools (MCP itself is built into Pi)                |
| [`@choco-pi/lsp`](../../packages/choco-pi-lsp)                               | 1.0.0-alpha.1 | LSP, lint, structural analysis, and semantic tools              |
| [`@choco-pi/compaction`](../../packages/choco-pi-compaction)                 | 1.0.0-alpha.1 | Local compaction summaries reconciled with retained messages    |
| [`@choco-pi/codex`](../../packages/choco-pi-codex)                           | 1.0.0-alpha.1 | Codex tools, Code Mode, and Responses compaction                |
| [`@choco-pi/agents-md`](../../packages/choco-pi-agents-md)                   | 1.0.0-alpha.1 | Loading of `AGENTS.md` instructions from subdirectories         |
| [`@choco-pi/agent-browser`](../../packages/choco-pi-agent-browser)           | 1.0.0-alpha.1 | Native browser automation tools                                 |
| [`@choco-pi/computer-use`](../../packages/choco-pi-computer-use)             | 1.0.0-alpha.1 | macOS desktop inspection and interaction                        |
