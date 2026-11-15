# Configuration and customization

[한국어](../ko/configuration.md)

This page lists the files that configure choco-pi, shows a complete global `settings.json`, and covers the advisor, Pi's built-in extensions, and MCP servers. In a standalone install, every path under `~/.pi/agent` is under `~/.choco-pi/agent` instead ([details](installation.md#separation-from-pi)).

| File or directory                                                                                                                                          | Purpose                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Global `~/.pi/agent/settings.json`; the checkout ships no `.pi/settings.json`                                                                              | Loaded packages, theme, TUI mode, per-model thinking levels, and compaction |
| [`profile/SYSTEM.md`](../../profile/SYSTEM.md)                                                                                                             | Profile-wide agent behavior and authority rules                             |
| [`profile/model-guidance.md`](../../profile/model-guidance.md)                                                                                             | Model routing and model-specific policy                                     |
| [`profile/writing-policy.md`](../../profile/writing-policy.md) and [`profile/review-policy.md`](../../profile/review-policy.md)                            | Response prose and review policy                                            |
| [`AGENTS.md`](../../AGENTS.md) and a [package example](../../packages/choco-pi-subagents/AGENTS.md)                                                        | Root and path-scoped repository rules                                       |
| [`profile/agents`](../../profile/agents), [`profile/skills`](../../profile/skills), and [`profile/prompts`](../../profile/prompts)                         | Agent roles, workflow skills, and slash-command prompts                     |
| [`profile/subagents.json`](../../profile/subagents.json)                                                                                                   | Subagent concurrency, depth, fleet view, and worktree isolation             |
| [`profile/choco-pi-codex.json`](../../profile/choco-pi-codex.json)                                                                                         | Code Mode, Codex tools, notebook, and compaction settings                   |
| [`profile/zentui.json`](../../profile/zentui.json)                                                                                                         | TUI colors, components, and icons                                           |
| [`profile/models.json`](../../profile/models.json) and [`profile/keybindings.json`](../../profile/keybindings.json)                                        | Provider model overrides and key bindings                                   |
| [`apex-provider.json`](../../profile/extensions/apex-provider.json)                                                                                        | Callstack Apex provider discovery defaults                                  |
| [`review.json`](../../profile/extensions/review.json)                                                                                                      | Local review interface configuration                                        |
| Global `~/.pi/agent/advisor.json`, with the project override `.pi/advisor.json`                                                                            | Advisor enablement, model, effort, and per-turn cap                         |
| `~/.pi/agent/mcp.json` (standalone: `~/.choco-pi/agent/mcp.json`), based on [`profile/mcp.example.json`](../../profile/mcp.example.json)                   | Untracked MCP server configuration in Pi's built-in format                  |
| Each package's [`AGENTS.md`](../../packages/choco-pi-agent-browser/AGENTS.md) and [`VENDORED.md`](../../packages/choco-pi-agent-browser/VENDORED.md) files | Package policy and recorded differences from upstream                       |

`npm run install:profile` (`choco-pi self setup` for the standalone command) links the policy files, `subagents.json`, `choco-pi-codex.json`, `models.json`, `keybindings.json`, the agent definitions, and the two extension JSON files (`extensions/apex-provider.json` and `extensions/review.json`) into `~/.pi/agent`; `zentui.json` is linked as `choco-pi-ui.json`. It also migrates an existing `~/.pi/agent/extensions/background-compaction.json` to the current layout: it derives the backend switches again from the OpenAI and Anthropic compaction modes, and keeps `enabled` and the other keys. It does not create the file if it is missing.

Since Pi 1.0.3, `Home`/`End` move the editor cursor. Use `Ctrl+Home`/`Ctrl+End` to jump to the top or bottom of the transcript.

## Example global settings

`npm run install:profile` rewrites `~/.pi/agent/settings.json` and keeps the keys it does not manage; `choco-pi self setup` runs the same installer on `~/.choco-pi/agent/settings.json`. Because the checkout ships no `.pi/settings.json`, the profile policy comes from this global file itself: its `packages` entries under the checkout's `packages` directory, and its `extensions` built-in policy.

When the file lists no bundled packages, the installer starts from the profile defaults in `scripts/install-profile.ts`. These include per-model thinking levels (`modelThinkingLevels`) and, for the profile installed into Pi, the maintainer's model scope (`enabledModels`). The standalone `choco-pi self setup` writes no `enabledModels` scope ([why](installation.md#first-run-settings)). A first install keeps an `enabledModels` you already set, and merges the default thinking levels under yours, so your entries win. Each run:

- Writes `packages`, `skills`, and `prompts` as absolute checkout paths, and gives `extensions` the [built-in policy](#built-in-extensions) as well. Entries you added are kept after the choco-pi entries, except packages that a bundled package supersedes.
- Keeps `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`, and `modelThinkingLevels` as they are set in the global file. Change them there or through `/preferences`.
- Leaves the remaining keys alone. Set them yourself or through `/preferences`.

If a checkout adds a `.pi/settings.json`, that file takes precedence: the installer and `/check` read it instead, copy its `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, and `compaction` over the global values, and merge its `modelThinkingLevels` under your global entries.

A complete global file looks like this. Replace `/path/to/choco-pi` with your checkout path, or, for the standalone command, with the absolute path of `~/.choco-pi/app`. The `defaultModel`, `modelThinkingLevels`, and `enabledModels` values are the maintainer's current settings. Never put secrets in this file.

```json
{
  "packages": [
    "/path/to/choco-pi/packages/choco-pi-web-search",
    "/path/to/choco-pi/packages/choco-pi-web-access",
    "/path/to/choco-pi/packages/choco-pi-provider-synthetic",
    "/path/to/choco-pi/packages/choco-pi-ui",
    "/path/to/choco-pi/packages/choco-pi-shells",
    "/path/to/choco-pi/packages/choco-pi-hooks",
    "/path/to/choco-pi/packages/choco-pi-subagents",
    "/path/to/choco-pi/packages/choco-pi-advisor",
    "/path/to/choco-pi/packages/choco-pi-goal",
    "/path/to/choco-pi/packages/choco-pi-mcp",
    "/path/to/choco-pi/packages/choco-pi-lsp",
    "/path/to/choco-pi/packages/choco-pi-compaction",
    "/path/to/choco-pi/packages/choco-pi-codex",
    "/path/to/choco-pi/packages/choco-pi-agents-md",
    "/path/to/choco-pi/packages/choco-pi-agent-browser",
    "/path/to/choco-pi/packages/choco-pi-computer-use",
    "/path/to/choco-pi/packages/choco-pi-editor-context"
  ],
  "extensions": [
    "/path/to/choco-pi/profile/extensions",
    "-builtin:codemode",
    "-builtin:tool-search"
  ],
  "skills": ["/path/to/choco-pi/profile/skills"],
  "prompts": ["/path/to/choco-pi/profile/prompts"],

  "theme": "nord-dark",
  "tuiMode": "fullscreen",
  "fullscreenExitOutput": "resume-hint",
  "fuzzyFileMentions": true,
  "modelThinkingLevels": {
    "anthropic/claude-fable-5": "high",
    "anthropic/claude-opus-5": "medium",
    "anthropic/claude-opus-4-6": "high",
    "anthropic/claude-sonnet-5": "xhigh",
    "openai/gpt-6-astra": "low",
    "openai-codex/gpt-6-astra": "low",
    "openai/gpt-5.6-sol": "low",
    "openai-codex/gpt-5.6-sol": "low",
    "openai/gpt-daybreak-blue-latest": "high",
    "openai/gpt-5.6-terra": "high",
    "openai-codex/gpt-5.6-terra": "high",
    "openai/gpt-5.6-luna": "xhigh",
    "openai-codex/gpt-5.6-luna": "xhigh",
    "synthetic/hf:moonshotai/Kimi-K3": "high",
    "anthropic/claude-fable-5-1": "low",
    "anthropic/claude-opus-5-5": "medium",
    "anthropic/claude-sonnet-5-5": "medium",
    "anthropic/claude-haiku-5-5": "medium",
    "openai/gpt-6-sol": "low",
    "openai-codex/gpt-6-sol": "low",
    "openai/gpt-6.1-sol": "low",
    "openai-codex/gpt-6.1-sol": "low",
    "openai/gpt-6.1-terra": "high",
    "openai-codex/gpt-6.1-terra": "high",
    "openai/gpt-6-luna": "high",
    "openai-codex/gpt-6-luna": "high",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash": "low",
    "synthetic/hf:zai-org/GLM-5.3": "high",
    "synthetic/hf:zai-org/GLM-5.3-Flash": "high",
    "anthropic/claude-mythos-5-1": "low",
    "anthropic/claude-fable-5-2": "high",
    "anthropic/claude-mythos-5-2": "high",
    "synthetic/hf:moonshotai/Kimi-K3.1-Pro": "high",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017": "high"
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
    "anthropic/claude-mythos-5-2",
    "anthropic/claude-fable-5-2",
    "anthropic/claude-mythos-5-1",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6.1-sol",
    "openai-codex/gpt-6.1-terra",
    "openai-codex/gpt-6-sol",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-6-luna",
    "synthetic/hf:moonshotai/Kimi-K3.1-Pro",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "synthetic/hf:zai-org/GLM-5.3",
    "synthetic/hf:zai-org/GLM-5.3-Flash",
    "xai/grok-4.6",
    "xai/grok-4.7"
  ],
  "cacheWarming": "streaming",
  "transport": "auto",
  "httpIdleTimeoutMs": 300000,
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "markdown": { "mermaid": "streaming" },
  "terminal": { "showTerminalProgress": true, "imageWidthCells": 60 },

  "agentLanguage": "English",
  "agentStyle": "balanced",
  "agentPersona": "pessimistic",
  "agentOnUsageLimit": "none",
  "sessionAutoName": true,
  "sessionAutoNameModel": "openai/gpt-6-luna",

  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "$HOME/bin/notify-done.sh", "timeout": 5 }]
      }
    ]
  }
}
```

| Keys                                                                                                                              | Set by                | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`, `extensions`, `skills`, `prompts`                                                                                     | Installer             | Absolute checkout paths; rerun the installer after you move the checkout.                                                                                                                                                                                                                                                                                                                      |
| `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`                                                     | You                   | `compaction.reserveTokens` sets how far below the context window compaction starts (summaries use the model's output limit), and `compaction.keepRecentTokens` sets how much recent context is kept without summarizing. Context limits are `/preferences` presets.                                                                                                                            |
| `modelThinkingLevels`                                                                                                             | You                   | Keyed by the exact `provider/modelId`. A checkout `.pi/settings.json`, when present, only adds entries for models you have not set.                                                                                                                                                                                                                                                            |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`                                                        | You                   | The startup model and thinking level; `enabledModels` limits model cycling.                                                                                                                                                                                                                                                                                                                    |
| `cacheWarming`, `transport`, `httpIdleTimeoutMs`, `quietStartup`, `enableInstallTelemetry`, `markdown`, `terminal`                | You                   | Pi runtime settings. `cacheWarming` is read only from the global file and accepts `off`, `streaming`, or `idle` (the default).                                                                                                                                                                                                                                                                 |
| `agentLanguage`, `agentStyle`, `agentPersona`, `agentOnUsageLimit`, `sessionAutoName`, `sessionAutoNameModel`, `promptSuggestion` | You or `/preferences` | choco-pi reads these only from the global file. `agentStyle` is `balanced` (the default), `concise`, `explanatory`, or the name of a style file in `~/.pi/agent/agent-styles/`. Defaults: `agentPersona` is `pessimistic`, `agentOnUsageLimit` is `none` (the other values are `fallback` and `auto-resume`), `sessionAutoNameModel` is `openai/gpt-6-luna`, and `promptSuggestion` is `true`. |
| `hooks`                                                                                                                           | You                   | Claude Code hook format. choco-pi-hooks also reads hooks from `.claude` and `.agents` settings files, as its [README](../../packages/choco-pi-hooks/README.md) describes.                                                                                                                                                                                                                      |

## Advisor settings

The advisor has its own file, `~/.pi/agent/advisor.json`. A project `.pi/advisor.json` overrides it key by key:

```json
{
  "enabled": true,
  "model": "anthropic/claude-fable-5-2",
  "effort": "low",
  "maxUses": 3
}
```

`effort` accepts `off` through `max`, and `maxUses` must be at least 1. Without the file, the advisor is disabled. The [advisor README](../../packages/choco-pi-advisor/README.md) lists the defaults and limits.

## Built-in extensions

Pi 1.5 ships built-in `codemode`, `tool-search`, `mcp`, and `llama.cpp` extensions. choco-pi uses Pi's built-in MCP but disables `codemode` and `tool-search` with `"extensions": ["-builtin:codemode", "-builtin:tool-search"]`, because it has its own `exec` code-mode bridge and its own `tool_search`. The profile installer writes this policy into the global settings and removes any other built-in exclusions.

MCP servers are configured in the agent directory's `mcp.json`, in Pi's built-in format: `~/.pi/agent/mcp.json` for the profile installed into Pi, and `~/.choco-pi/agent/mcp.json` for the standalone command. To convert a file written for the retired `pi-mcp-adapter` fork, run `node scripts/translate-mcp-config.ts` from the checkout, or `choco-pi self exec node ~/.choco-pi/app/scripts/translate-mcp-config.ts` for the standalone command. The script prints a redacted dry-run diff and writes only with `--apply`, keeping a timestamped backup.
