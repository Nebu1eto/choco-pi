# choco-pi

[한국어](README.ko.md)

choco-pi is an opinionated, project-aware profile for the [Pi coding agent](https://pi.dev/). It combines a custom agent contract, reusable workflows, model and provider controls, sub-agents, independent conversations, compaction settings, MCP, web access, browser automation, and a Nord-based terminal interface.

The repository tracks shareable configuration only. OAuth tokens and API keys remain in Pi's user-level credential store and must not be committed.

## Requirements

- Pi 0.84.1 or later
- Node.js 24 or later
- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.33.2 for native browser automation

Before installing the profile globally, run Pi from the repository root so it loads [`.pi/settings.json`](.pi/settings.json), the custom system prompt, project extensions, agents, skills, and prompt templates.

After cloning or copying the repository, start Pi from its root:

```sh
cd choco-pi
pi
```

Pi installs the packages pinned in [`.pi/settings.json`](.pi/settings.json). If npm defers native install scripts, approve only the two packages used by the configured extensions:

```sh
cd .pi/npm
npm install-scripts approve --allow-scripts-pin @ast-grep/cli tree-sitter-bash
npm rebuild @ast-grep/cli tree-sitter-bash
```

Run `/reload` after changing files under `.pi`.

## Global profile

This checkout is also the source of the current machine's global Pi profile under `~/.pi/agent`:

- `settings.json` installs the same pinned packages and references this checkout's `extensions`, `skills`, and `prompts` directories.
- `SYSTEM.md`, `writing-policy.md`, `review-policy.md`, `subagents.json`, agent definitions, and provider configuration files are symbolic links to this checkout.
- Pi launched from another directory therefore receives choco-pi as its user-level default. A trusted project's own `.pi` settings and `SYSTEM.md` can still override the global defaults through Pi's normal precedence rules.

Keep this checkout at a stable path because the global profile points to it. Restart Pi or run `/reload` after changing the source files.

## What this profile provides

| Area | Behavior |
|---|---|
| Agent contract | Replaces Pi's base prompt with [`.pi/SYSTEM.md`](.pi/SYSTEM.md) and injects the active `provider/model` on every turn |
| Project awareness | Applies root context at startup and loads path-scoped descendant `AGENTS.md` files when work enters those paths |
| Writing | Applies the repository writing policy to normal responses and persisted documents without a separate skill command |
| Workflows | Provides direct implementation, parallel implementation, hotfix, review, environment check, and local commit workflows |
| Agents | Provides configurable `general`, `planner`, `implementer`, `reviewer`, and `handoff` leaf roles |
| Conversations | Creates and coordinates independent Pi sessions with create, list, read, wait, queue, and steer operations |
| Context | Applies model-specific soft context caps and supports OpenAI Responses server-side compaction through `pi-codex-conversion` |
| Providers | Configures OpenAI Codex OAuth, Anthropic OAuth, Synthetic, and discovery-based Callstack Apex support |
| Tools | Adds MCP, web search, content extraction, LSP diagnostics, browser automation, goals, and side conversations |
| Interface | Uses `nord-dark`, `pi-zentui`, provider usage views, model effort controls, and familiar session aliases |

## Installed packages

Versions are pinned in [`.pi/settings.json`](.pi/settings.json).

| Package | Version | Purpose |
|---|---:|---|
| [`@aliou/pi-synthetic`](https://github.com/aliou/pi-synthetic) | 0.24.3 | Synthetic provider and authentication |
| [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | 0.15.0 | Claude Code-style sub-agents, background execution, steering, resume, and fleet UI |
| [`pi-codex-goal`](https://pi.dev/packages/pi-codex-goal) | 0.2.0 | Persistent Codex-style goals |
| [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | 2.21.2 | Lazy MCP server loading |
| [`pi-lens`](https://pi.dev/packages/pi-lens) | 3.8.74 | LSP, lint, and AST diagnostics |
| [`@howaboua/pi-codex-conversion`](https://pi.dev/packages/@howaboua/pi-codex-conversion) | 3.0.12 | Codex-compatible tools and OpenAI Responses compaction |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | 0.20.0 | Web search and document extraction |
| [`pi-btw`](https://pi.dev/packages/pi-btw) | 0.4.1 | Side conversations during an active task |
| [`pi-zentui`](https://pi.dev/packages/pi-zentui) | 0.18.1 | Editor, message framing, and status line |
| [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) | 0.3.0 | Native `agent-browser` integration |
| [`@howaboua/pi-markdown-workflows`](https://pi.dev/packages/@howaboua/pi-markdown-workflows) | 0.2.20 | Descendant `AGENTS.md` loading and Markdown workflows |
| [`@maddeye/pi-nord`](https://pi.dev/packages/@maddeye/pi-nord?name=nord&type=theme) | 1.0.0 | Nord themes |

## Commands

### Session and model controls

| Command | Description |
|---|---|
| `/exit` | Gracefully exit Pi; alias for `/quit` |
| `/clear` | Start a fresh session while preserving the current session history; alias for `/new` |
| `/effort [level]` | Select or directly set a reasoning effort supported by the active model; values complete after a space |
| `/fast [on\|off\|status]` | Control OpenAI Codex Fast mode; no argument toggles the current state |
| `/context-cap` | Show the soft context cap applied to the active model |
| `/rewind` | Restore files and the Git index from an automatic turn checkpoint |
| `/usage` | Show Claude Code, OpenAI Codex, and Synthetic usage in one view |
| `/apex-refresh` | Rediscover Callstack Apex models immediately |

Fast mode adds `service_tier: "priority"` only to OpenAI Codex requests. It can consume usage or API credit faster than the standard tier. The hidden llama.cpp provider remains available, but choco-pi removes `/llama` from the visible command list and command path.

While editing a prompt, press `Ctrl+S` to stash the current input, cursor position, and collapsed large-paste content, then clear the editor. While a stash exists, a restore hint appears above the editor. Press `Ctrl+S` again on an empty editor to restore the prompt and clear the hint. The stash lasts only for the current Pi process.

### Workflow commands

| Command | Workflow |
|---|---|
| `/check [scope]` | Verify the base choco-pi environment and task-specific optional capabilities |
| `/task-inline <task>` | Implement directly in the main agent; this is the default modifying workflow |
| `/task <task>` | Plan and execute independent implementation units with sub-agents |
| `/task-hotfix <task>` | Apply a narrow urgent fix directly in the main agent |
| `/review [target]` | Run a report-only adversarial review with a fresh reviewer |
| `/commit [guidance]` | Create one verified local commit without pushing |

`/task` is reserved for work with at least two independent units that benefit from parallel execution. File count alone does not justify it. Direct and hotfix workflows do not delegate implementation.

Every commit uses the harness `/commit` skill. It stages only the intended changes, follows repository-specific policy when present, and otherwise uses a scoped conventional subject, an optional terse body of at most two bullets, and `Assisted-by` and `Signed-off-by` trailers. It does not grant permission to push, open a pull request, publish, or deploy.

### Independent conversation commands

| Command | Description |
|---|---|
| `/session-new` | Choose a model, reasoning effort, optional name, and initial user prompt for a new conversation |
| `/sessions [limit]` | List conversations for the current project |
| `/session-send <id> <queue\|steer> <message>` | Send a queued or steering message to another conversation |
| `/session-read <id> [limit] [include-tools]` | Read recent transcript items and the current cursor |
| `/session-wait <id> [seconds] [after-cursor]` | Wait for progress after a cursor and for the target to become idle |

The agent can call the same operations through `session_create`, `session_send`, `session_list`, `session_read`, and `session_wait`.

Each conversation has its own Pi session ID and reloads project context, extensions, skills, and provider authentication. Same-process messages use the Pi session API directly. Cross-process messages use an owner-scoped heartbeat and a durable, sequenced mailbox under `~/.pi/agent/choco-pi/session-bridge/`.

- `steer` requires an active target and is delivered at Pi's next safe steering point.
- `queue` is FIFO and remains pending while the target is inactive.
- Session discovery and messaging are restricted to the current working directory.
- `session_create` returns immediately. Its cursor may be `null` until the first response.
- Pi writes a new session's JSONL after its first assistant response. If the creating process exits before that response, the not-yet-persisted session can be lost. Existing JSONL records and queued mailbox messages remain available.

## Agent behavior and project context

[`.pi/SYSTEM.md`](.pi/SYSTEM.md) is the shared operating contract. It defines communication, instruction precedence, intent routing, authority boundaries, evidence requirements, delegation, review, continuity, and completion rules. It is project-neutral: repository-specific commands and domain rules belong in that repository's `AGENTS.md` or skills.

[`runtime-model-prompt.ts`](.pi/extensions/runtime-model-prompt.ts) replaces `{{PI_CURRENT_MODEL}}` with the active `provider/model` on each turn. Parent and child sessions receive their own model identifier after model changes. Provider credentials are never added to the prompt.

[`runtime-writing-prompt.ts`](.pi/extensions/runtime-writing-prompt.ts) injects [`.pi/writing-policy.md`](.pi/writing-policy.md) into main and child prompts. The policy covers evidence, claim strength, native-language style, document structure, English output, Japanese output, and final review.

Pi loads context files from the startup path. `@howaboua/pi-markdown-workflows` adds descendant instructions when the agent reads or works in a deeper path. For example, accessing `packages/api/src/service.ts` can add, in order:

```text
packages/AGENTS.md
packages/api/AGENTS.md
packages/api/src/AGENTS.md
```

Previously loaded instructions remain in the session and are refreshed after changes. The package also provides `/workflows`, `/skills`, `/learn`, and a confirmed `workflows_create` path for reusable Markdown procedures.

## Sub-agents

Built-in package roles are disabled through [`.pi/subagents.json`](.pi/subagents.json), with unknown role names rejected instead of falling back. choco-pi provides five model-neutral, project-aware leaf roles under [`.pi/agents`](.pi/agents):

| Role | Use | Write access |
|---|---|---:|
| `general` | General scoped work | Yes |
| `planner` | Dependency, conflict, and verification planning | No |
| `implementer` | One assigned implementation unit | Yes |
| `reviewer` | Fresh-context evidence-based review | No |
| `handoff` | Concise report of verified state | No |

Use `/agents` to inspect roles, running agents, transcripts, schedules, and operational defaults. An `Agent` call can select `model` and `thinking` when the role does not pin them. Resolution follows explicit invocation, role configuration, then parent/runtime defaults.

Use `steer_subagent` to redirect a running agent after its current tool, `get_subagent_result` to retrieve a background result, and an `Agent` call with `resume: <id>` for a completed agent's same-unit follow-up. New calls start with fresh conversation context; each custom role appends its instructions to the current parent system prompt and inherits skills.

All custom roles disable ambient child extensions, so the declared native tools cannot be replaced by a model adapter. Writer roles use the current checkout by default and may run concurrently only after the orchestrator assigns disjoint direct and indirect ownership scopes. `isolation: "worktree"` remains explicit opt-in isolation.

## Checkpoints, review, and Git boundaries

[`file-checkpoints.ts`](.pi/extensions/file-checkpoints.ts) records staged, unstaged, and untracked state at the start of each agent turn through a temporary Git index. It does not modify the real index. `/rewind` creates a safety checkpoint before restoring the selected state. Ignored files and conversation history are not changed; checkpoint objects are retained under `refs/choco-pi/checkpoints/`.

[`review`](.pi/skills/review/SKILL.md) and [`.pi/review-policy.md`](.pi/review-policy.md) define a report-only adversarial review. The reviewer receives an exact diff or revision, tries to disprove its assumptions, and reports only reproducible or decisively traced findings. A review does not authorize fixes.

Modifying workflows record the starting revision, inspect the dirty tree, maintain an acceptance ledger, and acquire a checkout mutation lease. Work stays in the current checkout unless the user requests a worktree or isolation is required by repository policy.

## Context and compaction

Models with a native context window of at least 1,000,000 tokens use a 600,000-token soft cap and start automatic compaction after 550,000 tokens. Local fallback summaries retain the most recent 20,000 tokens.

Configure project-specific caps in [`.pi/extensions/context-cap.json`](.pi/extensions/context-cap.json). The global default is available at `~/.pi/agent/extensions/context-cap.json`; project configuration takes precedence.

```json
{
  "defaultCap": 600000,
  "defaultCompactAt": 550000,
  "appliesOver": 999999,
  "models": {
    "provider/model": {
      "cap": 600000,
      "compactAt": 550000
    },
    "provider/model-with-native-window": null
  }
}
```

- A number applies that exact soft cap; an object sets both the cap and compaction threshold.
- `null` disables both overrides for that model. Either object field can also be `null` to disable only that override.
- `/context-cap` reports the effective value for the current session.

For OpenAI Codex, enable native Responses compaction with `/codex openai`. The example in [`examples/pi-codex-conversion.json`](examples/pi-codex-conversion.json) can be copied to `~/.pi/agent/pi-codex-conversion.json`:

```json
{
  "compaction": {
    "responsesCompaction": true
  }
}
```

This path uses OpenAI `remote_compaction_v2` checkpoints for OpenAI Codex and explicitly configured compatible Responses providers. Unsupported or failed remote requests fall back to Pi compaction when safe. choco-pi does not install `pi-openai-server-compaction` because its current Pi compatibility range does not match this profile.

## Provider authentication

Pi stores OAuth tokens and API keys in `~/.pi/agent/auth.json` with mode `0600`. Do not copy this file into the repository.

Start Pi and authenticate the configured providers:

```text
/login openai-codex
/login anthropic
/login synthetic
```

- `openai-codex` uses browser OAuth for an eligible ChatGPT account.
- `anthropic` offers Claude account authentication through the browser.
- `synthetic` accepts a Synthetic API key.

Synthetic also reads the `SYNTHETIC_API_KEY` environment variable.

Check authentication without printing credential values:

```sh
pi auth check --provider openai-codex --json
pi auth check --provider anthropic --json
pi --approve --list-models synthetic
```

Pi's `auth` subcommand does not load project-defined providers, so use model listing rather than `pi auth check` for Synthetic and Callstack Apex.

## Callstack Apex discovery

Set the OpenAI-compatible API base in [`.pi/extensions/apex-provider.json`](.pi/extensions/apex-provider.json), or use `~/.pi/agent/extensions/apex-provider.json` as the global default. Project configuration takes precedence. The base must include the API prefix but not `/models`. For a model endpoint at `https://apex.example/v1/models`, use:

```json
{
  "baseUrl": "https://apex.example/v1",
  "api": "openai-completions",
  "defaults": {
    "contextWindow": 128000,
    "maxTokens": 16384,
    "reasoning": false,
    "input": ["text"]
  },
  "overrides": {}
}
```

Keep the URL outside Git by setting `CALLSTACK_APEX_BASE_URL`. Supply the key through `CALLSTACK_APEX_API_KEY`, or restart Pi after setting the base URL and run `/login callstack-apex`.

After setting `CALLSTACK_APEX_BASE_URL` and `CALLSTACK_APEX_API_KEY` in the shell, verify discovery without printing either value:

```sh
pi --approve --list-models callstack-apex
```

The extension requests `${baseUrl}/models` with Bearer authentication. It accepts the standard OpenAI `{ "data": [...] }` response, a direct array, or `{ "models": [...] }`. It imports model names, context windows, output limits, input modalities, reasoning flags, and supported features when supplied. Missing fields use `defaults`; entries in `overrides` take precedence.

Use `openai-completions` unless Apex has been confirmed to support the Responses API. Selecting `openai-responses` does not enable server-side compaction by itself. Run `/apex-refresh` after login or whenever the model catalog changes; successful discovery is cached for up to four hours.

## MCP, goals, web access, and side conversations

- Add project MCP servers to [`.mcp.json`](.mcp.json); the default file contains no servers. `/mcp` shows configuration and runtime state.
- `/create-goal <objective>` creates a persistent goal. `/goal` shows its state and usage.
- `web_search` and `fetch_content` provide search and document extraction through `pi-web-access`.
- `/btw <question>` starts a side conversation while the main agent is working.
- `/btw:model` and `/btw:thinking` select the side conversation model and effort.
- `/btw:inject` and `/btw:summarize` bring selected side-conversation context into the main session.

## TUI and browser automation

The default theme is `nord-dark`. `pi-zentui` supplies the editor, framed user messages, and status line; `/zentui` configures those regions and stores user preferences in `~/.pi/agent/zentui.json`.

`pi-agent-browser-native` provides the `agent_browser` tool but does not bundle the browser runtime. Install the compatible executable separately:

```sh
npm install --global --allow-scripts=agent-browser agent-browser@0.33.2
agent-browser install
agent-browser --version
npm exec --yes --package pi-agent-browser-native@0.3.0 -- pi-agent-browser-doctor
```

The agent can then open pages, capture interactive snapshots, click, type, take screenshots, and use authenticated browser profiles. `ffmpeg` is required only for WebM recording. choco-pi keeps the extension's optional Exa and Brave search integrations disabled and uses `pi-web-access` for normal web search.

## Usage reporting

`/usage` queries Claude Code, OpenAI Codex, and Synthetic in parallel. It displays current utilization and reset or regeneration times without printing credentials or raw provider error bodies.

Claude Code and OpenAI Codex usage depend on Pi OAuth credentials and provider endpoints also used by their CLIs. API-key authentication may not expose account quotas. Synthetic reports five-hour request usage and weekly credits; separately purchased subscription credit is outside that quota response.

## Repository layout

```text
.pi/
  SYSTEM.md                 Shared choco-pi operating contract
  settings.json             Packages, theme, and compaction settings
  subagents.json            Sub-agent runtime and fallback settings
  agents/                   Project-aware leaf roles
  extensions/               Provider, session, context, usage, and UI behavior
  prompts/                  Familiar slash-command templates
  skills/                   Workflow implementations
  scripts/                  Shared workflow utilities
  writing-policy.md         Always-on writing rules
  review-policy.md          Shared adversarial review rules
.mcp.json                   Project MCP configuration
examples/                   Optional user-level configuration examples
```

Run the baseline check after installation or configuration changes:

```text
/check
```

The check validates Node and Pi versions, settings, installed package versions, required harness resources, command aliases, and the optional browser runtime without reading credentials.

## Security and authority

- Keep OAuth tokens, API keys, environment overrides, MCP traces, Pi package installs, and sub-agent runtime data outside Git.
- choco-pi assumes a high-trust local development environment and does not add an approval workflow.
- Local project files and explicitly scoped local databases can be modified when the task authorizes changes.
- Remote databases, remote services, paths outside the working folder, and unrelated temporary locations require explicit user authority before writing.
- A request to commit does not authorize push, pull request creation, deployment, publication, or other remote mutation.

## References

- [Pi](https://pi.dev/)
- [Pi providers and authentication](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi package management](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi compaction](https://pi.dev/docs/latest/compaction)
- [Synthetic extension](https://github.com/aliou/pi-synthetic)
- [Callstack Apex introduction](https://www.callstack.com/blog/introducing-apex-a-fast-specialized-model-for-react-native)
- [OpenAI Codex source](https://github.com/openai/codex)
