# choco-pi

[한국어](README.ko.md)

choco-pi is a project-aware Pi profile that supplies operating rules, workflows, local packages, and development tools.

Keep OAuth tokens, API keys, and machine-local configuration outside Git.

## Requirements

- Node.js 24 or later
- pnpm `11.11.0` exactly
- Pi `0.86.1`, matching the SDK packages pinned by this checkout
- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.34.0 for browser automation

If `pnpm --version` does not print `11.11.0`, install the required version with
`npm install --global pnpm@11.11.0`, then check again. The vendored-package
installer refuses a different pnpm version before changing package trees.

## Initial installation

Clone the repository to a stable path. The profile installer records absolute
paths into Pi's user configuration, so moving the checkout later requires
running it again from the new location. First follow
[Install Pi without Homebrew](#install-pi-without-homebrew), then install the
profile:

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

npm install --global pnpm@11.11.0
pnpm --version

pnpm install --frozen-lockfile --ignore-scripts
npm run install:vendored
npm run install:profile
pi
```

### Install Pi without Homebrew

Homebrew's `pi-coding-agent` formula lags the supported release. Install Pi in
a versioned local prefix instead:

```sh
npm install --prefix ~/.local/pi-0.86.1 --ignore-scripts @earendil-works/pi-coding-agent@0.86.1
```

Create an executable shim at `~/.local/pi-shim/pi`:

```sh
#!/bin/sh
PI_SKIP_VERSION_CHECK=1 exec "$HOME/.local/pi-0.86.1/node_modules/.bin/pi" "$@"
```

Place the shim before `/opt/homebrew/bin` in your shell configuration:

```sh
export PATH="$HOME/.local/pi-shim:$PATH"
```

Pi 0.86.1's `cli.js` launcher enables Node's compile cache. When diagnosing
unusual module-load errors, set `NODE_DISABLE_COMPILE_CACHE=1` to disable it.

When Pi opens, run `/login` and select a provider. The installation scripts do
not authenticate, open a login flow, or copy credentials into the repository.

The root install and all six vendored-package installs use their committed
lockfiles. `npm run install:vendored` installs each package in its isolated
workspace and attempts to restore that package's previous dependency tree if
its install fails. An interrupted process can leave a
`node_modules.bootstrap-lock` claim directory and a
`node_modules.bootstrap-backup*` dependency backup. The installer does not
automatically prune this recoverable state or guarantee rollback after an
interrupt such as SIGINT; inspect and preserve it before retrying rather than
deleting it blindly.

`npm run install:profile` preserves existing runtime and authentication state
plus user-added packages, writes absolute checkout paths, and links tracked
profile resources into `~/.pi/agent`. It does not link MCP configuration. If a
target already contains unrelated content, the installer stops; review the
conflict, then use `npm run install:profile -- --backup` to preserve and replace
it when appropriate.

## Updating and reloading

Stop active Pi sessions before replacing their dependency trees. After pulling
repository changes, keep the same Node and pnpm versions, then rerun the frozen
root install, vendored install, and profile install:

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm run install:vendored
npm run install:profile
```

Restart Pi after an update. For edits under `.pi` during an existing Pi session,
run `/reload` to reload extensions, skills, prompts, themes, and linked profile
files.

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
| Agents             | Configurable specialist roles plus fresh-context, read-only advisor consults           |
| Sessions and goals | Independent conversations and persistent goals across compaction                       |
| Code intelligence  | LSP navigation, semantic indexing, AST search, diagnostics, and Code Mode              |
| Integrations       | MCP, web research, browser automation, macOS computer use, and Claude-compatible hooks |
| Interface          | Nord TUI, unified subagent and shell fleet panel, context and usage views, and Mermaid |

The blocking `advisor` tool gives root or child agents a fresh, read-only second opinion from a configured higher-intelligence model using a bounded excerpt of the live session. It is disabled by default and skips consults when the advisor and session models match. Configure `enabled`, `model`, `effort`, and `maxUses` in `/preferences` under Agent → Advisor Agent.

Pi's built-in `grep` tool is disabled. Source discovery follows the LSP and Code Mode path: `symbol_search`, `module_report`, targeted symbol reads, navigation, and AST search.

## Common commands

| Command                     | Purpose                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `/status`                   | Show session, model, provider, context, and loaded profile state           |
| `/preferences`              | Configure agent, advisor, language, response style, and interface settings |
| `/context all`              | Inspect prompt, tools, MCP, agents, files, skills, and token use           |
| `/usage`                    | Show supported provider usage and reset information                        |
| `/check`                    | Validate the installed profile and required resources                      |
| `/task-inline <task>`       | Implement one ordinary change directly                                     |
| `/task <task>`              | Run independent implementation units in parallel                           |
| `/task-dynamic <task>`      | Explicitly enable dynamically decomposed nested work                       |
| `/review [target]`          | Open the local human review interface                                      |
| `/review-agent [target]`    | Run a fresh, report-only adversarial review                                |
| `/commit [guidance]`        | Create a verified local commit without pushing                             |
| `/sessions`, `/session-new` | List project conversations or start an independent one                     |
| `/goal [objective]`         | Create, inspect, or manage a persistent goal                               |
| `/hooks`                    | Inspect effective Claude-compatible hook configuration                     |
| `/mcp`                      | Inspect MCP configuration, authentication, and server state                |

## Installed packages

[`.pi/settings.json`](.pi/settings.json) loads these 16 local packages.

| Package                                                                   |        Version | Purpose                                                      |
| ------------------------------------------------------------------------- | -------------: | ------------------------------------------------------------ |
| [`choco-pi-provider-synthetic`](.pi/packages/choco-pi-provider-synthetic) |          0.1.0 | Synthetic provider, authentication, usage, and search        |
| [`choco-pi-ui`](.pi/packages/choco-pi-ui)                                 |          0.1.0 | TUI, status line, preferences, and Nord themes               |
| [`choco-pi-shells`](.pi/packages/choco-pi-shells)                         |          0.1.0 | Owner-scoped background shell processes                      |
| [`choco-pi-hooks`](.pi/packages/choco-pi-hooks)                           |          0.1.0 | Claude Code-compatible lifecycle hooks                       |
| [`choco-pi-subagents`](.pi/packages/choco-pi-subagents)                   |          0.1.0 | Sub-agents, workflows, sessions, and fleet UI                |
| [`choco-pi-advisor`](.pi/packages/choco-pi-advisor)                       |          0.1.0 | Read-only advisor consults through sub-agents                |
| [`choco-pi-editor-context`](.pi/packages/choco-pi-editor-context)         |          0.1.0 | Editor-context protocol, storage, and injection              |
| [`choco-pi-goal`](.pi/packages/choco-pi-goal)                             |          0.1.0 | Persistent Codex-style goals                                 |
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |          0.1.0 | Lazy MCP servers, Figma tools, and elicitation               |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |          0.1.0 | LSP, lint, structural analysis, and semantic tools           |
| [`choco-pi-compaction`](.pi/packages/choco-pi-compaction)                 |          0.1.0 | Local compaction summaries reconciled with retained messages |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |          0.1.0 | Codex tools, Code Mode, and Responses compaction             |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |          0.1.0 | Descendant `AGENTS.md` instruction loading                   |
| [`choco-pi-web-access`](.pi/packages/choco-pi-web-access)                 | 0.24.1-choco.0 | Web search, source checks, and content extraction            |
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | Native browser automation tools                              |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS desktop inspection and interaction                     |

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
| Global `~/.pi/agent/advisor.json` with project override `.pi/advisor.json`                                                                      | Advisor enablement, model, effort, and per-turn cap           |
| `~/.pi/agent/mcp.json` from [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                                      | Untracked MCP server and OAuth configuration                  |
| Package [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md) and [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) files | Package policy and recorded upstream differences              |

### Example global settings

Pi reads `cacheWarming` from `~/.pi/agent/settings.json` only; a project-level
value is ignored. This example reflects the maintainer's current global file
(package paths shortened, secrets never live here):

```json
{
  "packages": [
    "/path/to/choco-pi/.pi/packages/choco-pi-provider-synthetic",
    "/path/to/choco-pi/.pi/packages/choco-pi-ui"
  ],
  "defaultProvider": "anthropic",
  "defaultModel": "claude-fable-5-1",
  "defaultThinkingLevel": "low",
  "cacheWarming": "streaming",
  "agentLanguage": "English",
  "agentStyle": "concise",
  "agentPersona": "pessimistic",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "httpIdleTimeoutMs": 300000,
  "transport": "auto"
}
```

## Use choco-pi in Zed

`.pi/packages/choco-pi-acp` connects Zed to choco-pi over the Agent Client Protocol,
and `.pi/packages/choco-pi-editor-context` syncs the focused file, cursor, and
selection into the targeted Pi session through Zed Tasks. Start with the
[Zed setup guide](docs/zed-setup.md); the
[compatibility baseline](docs/zed-acp-compatibility.md),
[command parity inventory](docs/zed-command-parity.md), and
[runtime E2E evidence](docs/zed-e2e-evidence.md) record what was verified.

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
