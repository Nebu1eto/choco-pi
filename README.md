# choco-pi

[한국어](README.ko.md)

choco-pi is a project-aware Pi profile that supplies operating rules, workflows, local packages, and development tools.

Keep OAuth tokens, API keys, and machine-local configuration outside Git.

## Requirements

- Pi `>=0.84.2 <0.85`
- Node.js 24 or later
- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.34.0 for browser automation

## Quick start

```sh
cd choco-pi
npm run install:profile
pi
```

The installer preserves runtime and authentication state plus user-added packages, writes absolute checkout paths, and links tracked profile resources into `~/.pi/agent`.
It does not link MCP configuration, and it stops on conflicting targets unless you rerun `npm run install:profile -- --backup`; keep the checkout at a stable path.
Rerun the installer after updating the checkout, and run `/reload` after editing files under `.pi`.

## Authentication

Authenticate from a Pi session:

```text
/login openai-codex
/login anthropic
/login synthetic
```

Pi stores credentials outside the repository; do not copy credential files into Git.

## Capabilities

| Area               | Purpose                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| Policy             | Shared operating rules plus root and path-scoped `AGENTS.md` instructions              |
| Workflows          | Direct, parallel, dynamic, review, check, and commit procedures                        |
| Agents             | Configurable planning, implementation, exploration, review, and handoff roles          |
| Sessions and goals | Independent conversations and persistent goals across compaction                       |
| Code intelligence  | LSP navigation, semantic indexing, AST search, diagnostics, and Code Mode              |
| Integrations       | MCP, web research, browser automation, macOS computer use, and Claude-compatible hooks |
| Interface          | Nord TUI, context and usage views, preferences, and Mermaid rendering                  |

Pi's built-in `grep` tool is disabled. Source discovery follows the LSP and Code Mode path: `symbol_search`, `module_report`, targeted symbol reads, navigation, and AST search.

## Common commands

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `/status`                   | Show session, model, provider, context, and loaded profile state    |
| `/preferences`              | Configure agent language, response style, and interface preferences |
| `/context all`              | Inspect prompt, tools, MCP, agents, files, skills, and token use    |
| `/usage`                    | Show supported provider usage and reset information                 |
| `/check`                    | Validate the installed profile and required resources               |
| `/task-inline <task>`       | Implement one ordinary change directly                              |
| `/task <task>`              | Run independent implementation units in parallel                    |
| `/task-dynamic <task>`      | Explicitly enable dynamically decomposed nested work                |
| `/review [target]`          | Open the local human review interface                               |
| `/review-agent [target]`    | Run a fresh, report-only adversarial review                         |
| `/commit [guidance]`        | Create a verified local commit without pushing                      |
| `/sessions`, `/session-new` | List project conversations or start an independent one              |
| `/goal [objective]`         | Create, inspect, or manage a persistent goal                        |
| `/hooks`                    | Inspect effective Claude-compatible hook configuration              |
| `/mcp`                      | Inspect MCP configuration, authentication, and server state         |

## Installed packages

[`.pi/settings.json`](.pi/settings.json) loads these 13 local packages.

| Package                                                                   |        Version | Purpose                                               |
| ------------------------------------------------------------------------- | -------------: | ----------------------------------------------------- |
| [`choco-pi-provider-synthetic`](.pi/packages/choco-pi-provider-synthetic) |          0.1.0 | Synthetic provider, authentication, usage, and search |
| [`choco-pi-ui`](.pi/packages/choco-pi-ui)                                 |          0.1.0 | TUI, status line, preferences, and Nord themes        |
| [`choco-pi-shells`](.pi/packages/choco-pi-shells)                         |          0.1.0 | Owner-scoped background shell processes               |
| [`choco-pi-hooks`](.pi/packages/choco-pi-hooks)                           |          0.1.0 | Claude Code-compatible lifecycle hooks                |
| [`choco-pi-subagents`](.pi/packages/choco-pi-subagents)                   |          0.1.0 | Sub-agents, workflows, sessions, and fleet UI         |
| [`choco-pi-goal`](.pi/packages/choco-pi-goal)                             |          0.1.0 | Persistent Codex-style goals                          |
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |          0.1.0 | Lazy MCP servers, Figma tools, and elicitation        |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |          0.1.0 | LSP, lint, structural analysis, and semantic tools    |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |          0.1.0 | Codex tools, Code Mode, and Responses compaction      |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |          0.1.0 | Descendant `AGENTS.md` instruction loading            |
| [`choco-pi-web-access`](.pi/packages/choco-pi-web-access)                 | 0.24.1-choco.0 | Web search, source checks, and content extraction     |
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | Native browser automation tools                       |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS desktop inspection and interaction              |

## Configuration and customization

| File or directory                                                                                                                               | Purpose                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`.pi/settings.json`](.pi/settings.json)                                                                                                        | Loaded packages, theme, model effort, and compaction settings |
| [`.pi/SYSTEM.md`](.pi/SYSTEM.md)                                                                                                                | Profile-wide agent behavior and authority rules               |
| [`AGENTS.md`](AGENTS.md) and [package example](.pi/packages/choco-pi-subagents/AGENTS.md)                                                       | Root and path-scoped repository rules                         |
| [`.pi/agents`](.pi/agents)                                                                                                                      | Agent role definitions and defaults                           |
| [`context-cap.json`](.pi/extensions/context-cap.json)                                                                                           | Model-specific context caps and compaction thresholds         |
| [`apex-provider.json`](.pi/extensions/apex-provider.json)                                                                                       | Callstack Apex provider discovery defaults                    |
| [`review.json`](.pi/extensions/review.json)                                                                                                     | Local review interface configuration                          |
| `~/.pi/agent/mcp.json` from [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                                      | Untracked MCP server and OAuth configuration                  |
| Package [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md) and [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) files | Package policy and recorded upstream differences              |

## Development verification

Run the root verification gates:

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm test
```

Runtime and TUI changes also require verification in a fresh Pi process. Package policies may require additional checks.

## Security and authority

Credentials and local overrides must remain untracked. Remote writes, deployments, pull requests, publication, and other external mutations require explicit approval.

## License status

The local package manifests declare MIT licenses. The repository has no separate root license file, so this README does not assign a license to the repository as a whole.

## References

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
