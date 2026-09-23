# choco-pi

[한국어](README.ko.md)

choco-pi is a project-aware profile for the [Pi](https://pi.dev/) coding agent. It adds operating rules, implementation and review workflows, subagents, code intelligence, research and automation tools, and a Nord terminal interface. Its packages, skills, and agent definitions load from this checkout; optional tools such as the `agent-browser` CLI, MCP servers, and search backends are external.

Keep OAuth tokens, API keys, and machine-local configuration outside Git.

## Requirements

- Node.js 24 or later
- pnpm `11.11.0` exactly
- Pi `0.87.1`, matching the SDK packages pinned by this checkout
- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) for browser automation. Versions 0.34.0, 0.35.2, 0.36.0, 0.37.1, and 0.38.1 are tested; other versions run with an advisory warning.
- Optional: macOS 14 or later for computer use (see [Set up computer use](#set-up-computer-use-macos))

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
npm install --prefix ~/.local/pi-0.87.1 --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
```

Create an executable shim at `~/.local/pi-shim/pi`:

```sh
#!/bin/sh
PI_SKIP_VERSION_CHECK=1 exec "$HOME/.local/pi-0.87.1/node_modules/.bin/pi" "$@"
```

Place the shim before `/opt/homebrew/bin` in your shell configuration:

```sh
export PATH="$HOME/.local/pi-shim:$PATH"
```

Pi 0.87.1's `cli.js` launcher enables Node's compile cache. When diagnosing
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

Besides Pi's built-in Anthropic and OpenAI Codex logins, choco-pi adds a Synthetic provider and discovers Callstack Apex models from [`apex-provider.json`](.pi/extensions/apex-provider.json).

## Set up computer use (macOS)

The computer-use tools (`observe_ui`, `act_ui`, and related tools) work through
a native helper app, `pi-computer-use.app`. The helper reads accessibility
trees, captures windows, and delivers input. Prebuilt helper binaries for Apple
silicon and Intel are committed under
`.pi/packages/choco-pi-computer-use/prebuilt/macos`, so installation downloads
nothing. Other operating systems cannot install the helper.

### Requirements

- macOS 14 or later
- An interactive Pi session for the first permission grant
- Only for building from source: Xcode or the Command Line Tools, which provide `xcrun swiftc`

### 1. Install the helper

When an interactive Pi session starts and `pi-computer-use.app` is missing, Pi
installs it from the prebuilt binary. To install it ahead of time, or to
reinstall it, run this from the checkout:

```sh
node .pi/packages/choco-pi-computer-use/scripts/setup-helper.mjs
```

The script prints the path it installed to. It does the following:

- Installs to `~/Applications/pi-computer-use.app`. An existing `/Applications/pi-computer-use.app` is updated in place when `/Applications` is writable. Set `PI_COMPUTER_USE_HELPER_APP_PATH` to use another location, and set the same variable for Pi.
- Wraps the binary in an app bundle with the identifier `com.injaneity.pi-computer-use`, code-signs it, and registers it with LaunchServices.
- Signs with the first identity available: `PI_COMPUTER_USE_CODESIGN_IDENTITY`; a "Developer ID Application" identity in your keychain; a self-signed identity named `pi-computer-use Local Signing (com.injaneity.pi-computer-use)`, which the script creates with `openssl` and imports into your login keychain; or an ad-hoc signature. macOS may drop permission grants after an ad-hoc-signed update. `PI_COMPUTER_USE_NO_SIGN=1` skips signing.
- Leaves an installed helper that is already current unchanged and only registers it again.

### 2. Grant permissions

The helper needs two macOS permissions. Screen Recording lets the agent see
windows; Accessibility lets it act on them. When either is missing, Pi shows
the current status and this menu:

- **Open Accessibility Settings (missing)**
- **Open Screen Recording Settings (missing)**
- **Recheck (restarts helper)**
- **Cancel**

Open each pane and turn on `pi-computer-use.app` under System Settings →
Privacy & Security → Accessibility and Screen Recording. Then choose
**Recheck**. Pi restarts the helper, because a running process can keep a stale
permission answer, and reports `pi-computer-use is ready.` when both are
granted.

Grant the permissions to `pi-computer-use.app`, not to your terminal. If Pi
warns that the helper is not running as the installed `pi-computer-use.app`,
restart Pi before granting; grants made then would attach to the launching
app. In a non-interactive run, such as print mode, setup stops with
instructions instead of a menu, so grant the permissions once from an
interactive session.

### 3. Verify

Run `/computer-use` to see the effective configuration and which configuration
files were loaded. Pi checks the permissions again when a session starts and
before each computer-use tool call, so a missing grant appears as the menu above.

### Update the helper

- Pi installs the helper only when the app is missing; it never replaces an existing one. After pulling a change under `prebuilt/macos`, run the setup script again and restart Pi.
- Pi checks the helper protocol version (currently 7) when it connects. It relaunches a mismatched helper once; if the version still differs, it stops with a "helper mismatch after relaunch" error. Run the setup script again.
- Replacing the helper re-signs the app, and macOS may invalidate earlier grants. If Pi reports a missing permission while the toggle is on, turn the toggle off and on again.
- When only ad-hoc signing is available, the script refuses to replace an installed helper, because macOS may reset its permissions. Install a Developer ID identity, or set `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1` and grant the permissions again.

### Build from source

The script always uses the prebuilt binary for your architecture when it
exists. Only when it is missing does `PI_COMPUTER_USE_ALLOW_BUILD=1` (or
`--allow-build`) let the script compile the Swift sources in
`.pi/packages/choco-pi-computer-use/native/macos` with `xcrun swiftc`. Without
that setting, a missing prebuilt is an error.

### Configure computer use

Settings come from `~/.pi/agent/extensions/pi-computer-use.json`, then the
projects `.pi/computer-use.json`, then environment variables; later sources
win. Neither file is created for you. This example shows the defaults:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "foreground_grant": []
}
```

| Key                | Environment variable                                 | Effect                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_use`      | `PI_COMPUTER_USE_BROWSER_USE`                        | Allows the agent to control browser windows.                                                                                                                                                                                                                                           |
| `managed_browser`  | `PI_COMPUTER_USE_MANAGED_BROWSER`                    | Browser Pi starts when it needs a managed browser: `chrome` or `helium`.                                                                                                                                                                                                               |
| `headless`         | `PI_COMPUTER_USE_HEADLESS`                           | Delivers actions through Accessibility only, without pointer or keyboard events.                                                                                                                                                                                                       |
| `cursor_overlay`   | `PI_COMPUTER_USE_CURSOR_OVERLAY`                     | Shows the agents cursor on screen while it acts.                                                                                                                                                                                                                                       |
| `foreground_grant` | `PI_COMPUTER_USE_FOREGROUND_GRANT` (comma-separated) | Bundle IDs, or `"*"`, that the agent may activate, raise, and send keyboard and mouse events to. Without a grant, input goes to the app in the background, and an action that needs focus fails with `foreground_required` instead of taking focus. No tool call can change this list. |

### Remove the helper

1. Quit Pi. If the helper is still running, stop it with `pkill -f pi-computer-use.app/Contents/MacOS/bridge`.
2. Delete `~/Applications/pi-computer-use.app` (or `/Applications/pi-computer-use.app`).
3. Remove `pi-computer-use` from the Accessibility and Screen Recording lists in System Settings.
4. Optionally, delete the `pi-computer-use Local Signing` identity from your login keychain in Keychain Access.

## Features

### Operating rules and workflows

- [`.pi/SYSTEM.md`](.pi/SYSTEM.md) sets shared rules for scope, authority, evidence, and completion. [`.pi/model-guidance.md`](.pi/model-guidance.md) adds per-model guidance and [`.pi/writing-policy.md`](.pi/writing-policy.md) governs response prose.
- Root and path-scoped `AGENTS.md` files are loaded as the agent works in subdirectories.
- Workflow skills cover direct implementation (`task-inline`), parallel units (`task`), dynamically decomposed work (`task-dynamic`), urgent fixes (`task-hotfix`), adversarial review (`review`), environment readiness (`check`), signed local commits (`commit`), and prose (`effective-writing`). Implementation workflows hold a checkout mutation lease, validate against an acceptance ledger, and never push.
- `/preferences` sets the response language, response style (`concise` or `explanatory`), and agent persona (`unset`, `critical`, or `pessimistic`), which controls how strictly the agent tests its own claims and plans.

### Agents and orchestration

- Specialist roles in [`.pi/agents`](.pi/agents) (`advisor`, `explore`, `general`, `handoff`, `implementer`, `planner`, `reviewer`) run as background subagents, as scheduled runs, in isolated Git worktrees, or as dependency-ordered workflows through `workflow_run`. `/agents` manages them.
- A fleet panel shows running subagents and managed background shells together. Shells are owner-scoped and managed with `shell_start` and `/shells`.
- `/btw` opens a parallel read-only side conversation.
- The blocking `advisor` tool gives root or child agents a fresh, read-only second opinion from a configured higher-intelligence model using a bounded excerpt of the live session. It is disabled by default and skips consults when the advisor and session models match. Configure `enabled`, `model`, `effort`, and `maxUses` in `/preferences` under Agent → Advisor Agent.

### Sessions, context, and goals

- Project conversations can be listed, created, read, steered, and awaited from another session (`/sessions`, `/session-new`, `/session-read`, `/session-send`, `/session-wait`).
- `/goal` keeps a persistent objective across turns and compaction.
- `/rewind` rolls back files, rewinds, or forks the session at a checkpointed turn.
- Compaction summaries are produced locally and reconciled with retained messages. [`context-cap.json`](.pi/extensions/context-cap.json) caps usable context per model and sets the compaction threshold.
- New sessions are named automatically. `sessionAutoNameModel` selects the naming model (default `synthetic/hf:Qwen/Qwen3.8-27B`); set `sessionAutoName` to `false` to disable naming.

### Code intelligence and Code Mode

- choco-pi-lsp provides LSP navigation and diagnostics, lint integration, ast-grep and tree-sitter search and rules, and semantic tools such as `symbol_search`, `module_report`, and `read_symbol`. `/lsp on|off|status` and the `/lens-*` commands control it at runtime.
- Code Mode's `exec` tool runs restricted JavaScript that composes several tool calls in one step; its notebook mode keeps persistent Deno TypeScript state. choco-pi-codex also supplies Codex-style tools such as `apply_patch` and `exec_command`, and Responses compaction. `/codex` opens its settings.
- Most tools are deferred and found through `tool_search`, keeping the always-loaded tool list small. Pi's built-in `grep` tool is disabled; source discovery goes through `symbol_search`, `module_report`, targeted symbol reads, navigation, and AST search.

### Research and integrations

- Web research uses one deferred `web_search` tool regardless of the conversation model. Search credentials and billing come from the selected search backend (OpenAI, Exa, Kagi, Synthetic, or Brave), not from the conversation provider. See [Web search](docs/web-search.md) for providers, routing, privacy, and fallback behavior.
- `fetch_content` extracts page content and `source_check` verifies claims against cited passages. `/search` browses stored results; `/websearch` and `/curator` drive the search curator workflow.
- MCP servers start lazily, support OAuth (`/mcp-auth`) and elicitation, and can be batched with `mcpScript`. Native Figma tools read files, components, variables, and renders.
- `agent_browser` automates web pages through the optional `agent-browser` CLI.
- On macOS, computer-use tools inspect and operate desktop applications through a native helper that requires Accessibility and Screen Recording permissions. [Set up computer use](#set-up-computer-use-macos) covers installation, permissions, and configuration.
- Claude Code-compatible lifecycle hooks run from Pi settings. `/hooks` browses them and `/add-dir` adds a working directory and runs `DirectoryAdded` hooks.

### Models and usage

- `/effort` sets reasoning effort and `/fast` sets the session Fast mode preference. `modelThinkingLevels` in settings assigns a default thinking level per model.
- choco-pi defaults `PI_CACHE_RETENTION` to `long`, requesting one-hour prompt-cache retention from providers that support it. An explicit value wins.
- `/usage` (alias `/quota`) shows provider usage and reset times; `/synthetic:quotas` shows Synthetic quotas.

### Interface

- Fullscreen TUI with Nord themes, a status line, and a `/status` dialog with Status, Context, Usage, and Preferences tabs.
- Mermaid diagrams render in the terminal. When a response draws a diagram with box or arrow characters, the next request carries a hidden reminder to use Mermaid instead.
- Fuzzy `@` file mentions, slash-command completion anywhere in the prompt, and inline image support that respects terminal multiplexers.

## Common commands

| Command                                           | Purpose                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `/status`                                         | Show session, cost, model, context, MCP, and environment state    |
| `/preferences` (`/pref`)                          | Configure agent, advisor, language, style, persona, and interface |
| `/context all`                                    | Inspect prompt, tools, MCP, agents, files, skills, and token use  |
| `/usage` (`/quota`)                               | Show supported provider usage and reset information               |
| `/effort [level]`, `/fast [on\|off\|status]`      | Set reasoning effort or the session Fast mode preference          |
| `/check`                                          | Validate the installed profile and required resources             |
| `/task-inline <task>`                             | Implement one ordinary change directly                            |
| `/task <task>`                                    | Run independent implementation units in parallel                  |
| `/task-dynamic <task>`                            | Explicitly enable dynamically decomposed nested work              |
| `/task-hotfix <task>`                             | Apply an urgent production fix directly                           |
| `/review [target]`                                | Review session, branch, or pull request changes yourself          |
| `/review-agent [target]`                          | Run a fresh, report-only adversarial review                       |
| `/commit [guidance]`                              | Create a verified local commit without pushing                    |
| `/rewind`                                         | Roll back, rewind, or fork at a checkpointed turn                 |
| `/agents`, `/btw`                                 | Manage agents or open a read-only side conversation               |
| `/shells`                                         | List, read, or stop managed shells                                |
| `/sessions`, `/session-new`                       | List project conversations or start an independent one            |
| `/session-read`, `/session-send`, `/session-wait` | Read, steer, or wait on another conversation                      |
| `/goal [objective]`                               | Create, inspect, or manage a persistent goal                      |
| `/hooks`, `/add-dir`                              | Browse hooks or add a working directory                           |
| `/mcp`, `/mcp-auth`                               | Inspect MCP server state or authenticate a server                 |
| `/search`, `/websearch`, `/curator`               | Browse stored search results or run the search curator            |
| `/lsp`                                            | Turn LSP usage on or off, or show its state                       |
| `/codex`, `/computer-use`                         | Configure the Codex adapter or show computer-use configuration    |
| `/apex-refresh`                                   | Refresh Callstack Apex models                                     |
| `/clear`, `/exit`, `/delete`                      | Start a fresh session, quit, or permanently delete this session   |

## Installed packages

[`.pi/settings.json`](.pi/settings.json) loads these 17 local packages. An eighteenth package, [`choco-pi-acp`](.pi/packages/choco-pi-acp) 0.0.33, is not loaded by Pi; it runs as a separate ACP process for editors (see [Use choco-pi in Zed](#use-choco-pi-in-zed)).

| Package                                                                   |        Version | Purpose                                                      |
| ------------------------------------------------------------------------- | -------------: | ------------------------------------------------------------ |
| [`choco-pi-web-search`](.pi/packages/choco-pi-web-search)                 |          0.1.0 | Session-scoped routing for the canonical web search tool     |
| [`choco-pi-web-access`](.pi/packages/choco-pi-web-access)                 | 0.24.1-choco.0 | Web search, source checks, and content extraction            |
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
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | Native browser automation tools                              |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS desktop inspection and interaction                     |

## Configuration and customization

| File or directory                                                                                                                               | Purpose                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`.pi/settings.json`](.pi/settings.json)                                                                                                        | Loaded packages, theme, TUI mode, per-model thinking levels, and compaction |
| [`.pi/SYSTEM.md`](.pi/SYSTEM.md)                                                                                                                | Profile-wide agent behavior and authority rules                             |
| [`.pi/model-guidance.md`](.pi/model-guidance.md)                                                                                                | Model routing and model-specific policy                                     |
| [`.pi/writing-policy.md`](.pi/writing-policy.md) and [`.pi/review-policy.md`](.pi/review-policy.md)                                             | Response prose and review policy                                            |
| [`AGENTS.md`](AGENTS.md) and [package example](.pi/packages/choco-pi-subagents/AGENTS.md)                                                       | Root and path-scoped repository rules                                       |
| [`.pi/agents`](.pi/agents), [`.pi/skills`](.pi/skills), and [`.pi/prompts`](.pi/prompts)                                                        | Agent roles, workflow skills, and slash-command prompts                     |
| [`.pi/subagents.json`](.pi/subagents.json)                                                                                                      | Subagent concurrency, depth, fleet view, and worktree isolation             |
| [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json)                                                                                            | Code Mode, Codex tools, notebook, and compaction settings                   |
| [`.pi/zentui.json`](.pi/zentui.json)                                                                                                            | TUI colors, components, and icons                                           |
| [`.pi/models.json`](.pi/models.json) and [`.pi/keybindings.json`](.pi/keybindings.json)                                                         | Provider model overrides and key bindings                                   |
| [`context-cap.json`](.pi/extensions/context-cap.json)                                                                                           | Model-specific context caps and compaction thresholds                       |
| [`apex-provider.json`](.pi/extensions/apex-provider.json)                                                                                       | Callstack Apex provider discovery defaults                                  |
| [`review.json`](.pi/extensions/review.json)                                                                                                     | Local review interface configuration                                        |
| Global `~/.pi/agent/advisor.json` with project override `.pi/advisor.json`                                                                      | Advisor enablement, model, effort, and per-turn cap                         |
| `~/.pi/agent/mcp.json` from [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                                      | Untracked MCP server and OAuth configuration                                |
| Package [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md) and [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) files | Package policy and recorded upstream differences                            |

`npm run install:profile` links the policy files, `subagents.json`, `choco-pi-codex.json`, `models.json`, `keybindings.json`, the agent definitions, and the three extension JSON files into `~/.pi/agent`; `zentui.json` is linked as `choco-pi-ui.json`.

### Example global settings

`npm run install:profile` builds `~/.pi/agent/settings.json` from
[`.pi/settings.json`](.pi/settings.json) and keeps any keys it does not manage.
Each run does three things:

- Writes `packages`, `extensions`, `skills`, and `prompts` as absolute checkout paths. Entries you added are kept after the choco-pi entries.
- Copies every other key in `.pi/settings.json` (`theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `modelThinkingLevels`, and `compaction`) over the global value. Change these in `.pi/settings.json`; edits made only in the global file are lost on the next install.
- Leaves the remaining keys alone. Set them yourself or through `/preferences`.

A complete global file looks like this. Replace `/path/to/choco-pi` with your
checkout path. `modelThinkingLevels` is shortened here; the installer copies the
full map. Secrets never belong in this file.

```json
{
  "packages": [
    "/path/to/choco-pi/.pi/packages/choco-pi-web-search",
    "/path/to/choco-pi/.pi/packages/choco-pi-web-access",
    "/path/to/choco-pi/.pi/packages/choco-pi-provider-synthetic",
    "/path/to/choco-pi/.pi/packages/choco-pi-ui",
    "/path/to/choco-pi/.pi/packages/choco-pi-shells",
    "/path/to/choco-pi/.pi/packages/choco-pi-hooks",
    "/path/to/choco-pi/.pi/packages/choco-pi-subagents",
    "/path/to/choco-pi/.pi/packages/choco-pi-advisor",
    "/path/to/choco-pi/.pi/packages/choco-pi-goal",
    "/path/to/choco-pi/.pi/packages/choco-pi-mcp",
    "/path/to/choco-pi/.pi/packages/choco-pi-lsp",
    "/path/to/choco-pi/.pi/packages/choco-pi-compaction",
    "/path/to/choco-pi/.pi/packages/choco-pi-codex",
    "/path/to/choco-pi/.pi/packages/choco-pi-agents-md",
    "/path/to/choco-pi/.pi/packages/choco-pi-agent-browser",
    "/path/to/choco-pi/.pi/packages/choco-pi-computer-use",
    "/path/to/choco-pi/.pi/packages/choco-pi-editor-context"
  ],
  "extensions": ["/path/to/choco-pi/.pi/extensions"],
  "skills": ["/path/to/choco-pi/.pi/skills"],
  "prompts": ["/path/to/choco-pi/.pi/prompts"],

  "theme": "nord-dark",
  "tuiMode": "fullscreen",
  "fullscreenExitOutput": "resume-hint",
  "fuzzyFileMentions": true,
  "modelThinkingLevels": {
    "anthropic/claude-opus-5-5": "medium",
    "anthropic/claude-sonnet-5": "xhigh",
    "openai-codex/gpt-6-sol": "medium"
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },

  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5-5",
  "defaultThinkingLevel": "low",
  "enabledModels": [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5",
    "openai-codex/gpt-6-sol"
  ],
  "cacheWarming": "streaming",
  "transport": "auto",
  "httpIdleTimeoutMs": 300000,
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "markdown": { "mermaid": "streaming" },
  "terminal": { "showTerminalProgress": true, "imageWidthCells": 60 },

  "agentLanguage": "English",
  "agentStyle": "concise",
  "agentPersona": "critical",
  "sessionAutoName": true,
  "sessionAutoNameModel": "synthetic/hf:Qwen/Qwen3.8-27B",

  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "$HOME/bin/notify-done.sh", "timeout": 5 }]
      }
    ]
  }
}
```

| Keys                                                                                                               | Set by                              | Notes                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages`, `extensions`, `skills`, `prompts`                                                                      | Installer                           | Absolute checkout paths; rerun the installer after moving the checkout.                                                                                                                                            |
| `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `modelThinkingLevels`, `compaction`               | Installer, from `.pi/settings.json` | `compaction.reserveTokens` is reserved for the model response and `compaction.keepRecentTokens` is kept without summarizing. Per-model context caps live in [`context-cap.json`](.pi/extensions/context-cap.json). |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`                                         | You                                 | Startup model and thinking level; `enabledModels` limits model cycling.                                                                                                                                            |
| `cacheWarming`, `transport`, `httpIdleTimeoutMs`, `quietStartup`, `enableInstallTelemetry`, `markdown`, `terminal` | You                                 | Pi runtime settings. `cacheWarming` is read only from the global file and accepts `off`, `streaming` (default), or `idle`.                                                                                         |
| `agentLanguage`, `agentStyle`, `agentPersona`, `sessionAutoName`, `sessionAutoNameModel`                           | You or `/preferences`               | choco-pi reads these only from the global file. `agentStyle` is `concise`, `explanatory`, or the name of a style file in `~/.pi/agent/agent-styles/`. `agentPersona` defaults to `critical`.                       |
| `hooks`                                                                                                            | You                                 | Claude Code hook format. choco-pi-hooks also reads hooks from `.claude` and `.agents` settings files, as described in its [README](.pi/packages/choco-pi-hooks/README.md).                                         |

The advisor has its own file, `~/.pi/agent/advisor.json`, which a project
`.pi/advisor.json` overrides key by key:

```json
{
  "enabled": true,
  "model": "anthropic/claude-fable-5-1",
  "effort": "low",
  "maxUses": 3
}
```

`effort` accepts `off` through `max`, and `maxUses` must be at least 1. Without
the file the advisor is disabled.

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

Every local package manifest except `choco-pi-web-search` declares the MIT license; `choco-pi-web-search` declares none. The repository has no root license file, so this README does not assign a license to the repository as a whole.

## References

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
