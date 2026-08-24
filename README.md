# choco-pi

[한국어](README.ko.md)

choco-pi is an opinionated, project-aware profile for the [Pi coding agent](https://pi.dev/). It combines custom operating rules, reusable workflows, model and provider controls, sub-agents, independent conversations, compaction settings, MCP, web search, browser automation, and a Nord-based terminal interface.

The repository tracks shareable configuration only. OAuth tokens and API keys remain in Pi's user-level credential store and must not be committed.

## Requirements

- Pi 0.84.1 or later
- Node.js 24 or later
- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.33.2 for native browser automation

After cloning or copying the repository, install the global profile and start Pi:

```sh
cd choco-pi
npm run install:profile
pi
```

The installer keeps credentials and runtime state intact, generates `~/.pi/agent/settings.json` with checkout-relative paths, and links the tracked public profile into `~/.pi/agent`. User-added packages in the global settings are preserved, but duplicate pins of tracked packages are replaced by the tracked one, and duplicate user-added pins keep only the newer version. It stops rather than replacing a conflicting file; inspect it, then rerun with `npm run install:profile -- --backup` to preserve the old file and install the tracked version.

Pi loads the local packages listed in [`.pi/settings.json`](.pi/settings.json). Run `/reload` after changing files under `.pi`.

## Global profile

This checkout is also the source of the current machine's global Pi profile under `~/.pi/agent`:

- `settings.json` loads the same local packages and references this checkout's `extensions`, `skills`, and `prompts` directories.
- `SYSTEM.md`, writing and review policy, sub-agent and UI configuration, agent definitions, and provider configuration files are symbolic links to this checkout. MCP configuration is the exception: it lives directly at `~/.pi/agent/mcp.json` and is not linked from here.
- Pi launched from another directory therefore receives choco-pi as its user-level default. A trusted project's own `.pi` settings and `SYSTEM.md` can still override the global defaults through Pi's normal precedence rules.

Keep this checkout at a stable path because the global profile points to it. Restart Pi or run `/reload` after changing the source files.

The tracked [`.pi/zentui.json`](.pi/zentui.json) renders the editor model in bold and reasoning effort in italics.

## What this profile provides

| Area              | Behavior                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Operating rules   | Replaces Pi's base prompt with [`.pi/SYSTEM.md`](.pi/SYSTEM.md) and injects the active `provider/model` on every turn                           |
| Project awareness | Applies root context at startup and loads path-scoped descendant `AGENTS.md` files when work enters those paths                                 |
| Writing           | Applies the repository writing policy to normal responses and persisted documents without a separate skill command                              |
| Workflows         | Provides direct implementation, parallel implementation, hotfix, review, environment check, and local commit workflows                          |
| Agents            | Provides configurable `general`, `planner`, `implementer`, `reviewer`, and `handoff` leaf roles                                                 |
| Conversations     | Creates and coordinates independent Pi sessions with create, list, read, wait, queue, and steer operations                                      |
| Context           | Applies model-specific soft caps, deferred tool loading, `/context` usage analysis, and OpenAI Responses server-side compaction                 |
| Providers         | Configures OpenAI Codex OAuth, Anthropic OAuth, Synthetic, and discovery-based Callstack Apex support                                           |
| Tools             | Adds BM25 `tool_search`, MCP, Synthetic web search, LSP diagnostics, browser automation through the global skill, goals, and side conversations |
| Interface         | Uses `nord-dark`, `choco-pi-ui`, provider usage views, model effort controls, and familiar session aliases                                      |

## Installed packages

The package paths are listed in [`.pi/settings.json`](.pi/settings.json); each local manifest records its version.

| Package                                                                   | Version | Purpose                                                                                                     |
| ------------------------------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------- |
| [`choco-pi-provider-synthetic`](.pi/packages/choco-pi-provider-synthetic) |   0.1.0 | Synthetic provider, authentication, usage, and web search                                                   |
| [`choco-pi-ui`](.pi/packages/choco-pi-ui)                                 |   0.1.0 | Editor, message framing, status line, and Nord themes                                                       |
| [`choco-pi-subagents`](.pi/packages/choco-pi-subagents)                   |   0.1.0 | Local fork of `@tintinweb/pi-subagents@0.17.1` with sub-agents, workflows, side conversations, and fleet UI |
| [`choco-pi-goal`](.pi/packages/choco-pi-goal)                             |   0.1.0 | Persistent Codex-style goals                                                                                |
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |   0.1.0 | Lazy MCP server loading                                                                                     |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |   0.1.0 | LSP, lint, AST, and semantic diagnostics                                                                    |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |   0.1.0 | Codex-compatible tools and OpenAI Responses compaction                                                      |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |   0.1.0 | Descendant `AGENTS.md` loading                                                                              |

Voice, notebook, and background-shell features are intentionally not included.

## Commands

### Session and model controls

| Command                                                                           | Description                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/exit`                                                                           | Gracefully exit Pi; alias for `/quit`                                                                                                                                                                                                              |
| `/delete`                                                                         | Permanently delete the current Pi session record and exit after confirmation                                                                                                                                                                       |
| `/clear`                                                                          | Start a fresh session while preserving the current session history; alias for `/new`                                                                                                                                                               |
| `/status`                                                                         | Show Pi version, session identity, model and provider, context window, context files, skills, MCP servers, agent roles, and theme; opens the Status/Context/Usage/Preferences tab view. Pi's own runtime settings stay on its built-in `/settings` |
| `/effort [level]`                                                                 | Select or directly set a reasoning effort supported by the active model; values complete after a space                                                                                                                                             |
| `/fast [on\|off\|status]`                                                         | Control OpenAI Codex Fast mode; no argument toggles the current state                                                                                                                                                                              |
| `/context [all]`                                                                  | Open the Context tab: prompt, active/deferred tools, MCP, agents, context files, skills, messages, and autocompact buffer usage. `all` opens it already expanded                                                                                   |
| `/rewind`, `/fork`                                                                | Open the checkpoint picker to rewind, roll back, or fork the session at a selected turn                                                                                                                                                            |
| `/review [session [turn <n>] \| branch <base> [target] \| resume \| pr <number>]` | Open the local human review view; no argument opens the target picker                                                                                                                                                                              |
| `/usage`, `/quota`                                                                | Show Claude Code, OpenAI Codex, and Synthetic usage in one view; opens the same tab view on its Usage tab                                                                                                                                          |
| `/preferences [args]`, `/pref`                                                    | Open the Preferences tab of the same view: agent language, agent style, and every choco-ui interface section. Accepts `agent`, `language <name>`, `style <name>`, the choco-ui direct toggles, and `format <template>`                             |
| `/apex-refresh`                                                                   | Rediscover Callstack Apex models immediately                                                                                                                                                                                                       |

Fast mode adds `service_tier: "priority"` only to OpenAI Codex requests. It can consume usage or API credit faster than the standard tier. The hidden llama.cpp provider remains available, but choco-pi removes `/llama` from the visible command list and command path.

`Ctrl+S` stashes the current input, cursor position, and collapsed paste content, then clears the editor. On an empty editor it restores the stash. The stash lasts only for the current Pi process.

MCP starts with only the `choco-pi-mcp` gateway in model context; cached MCP tools are not registered as direct tools. The model passes a natural-language capability to `tool_search`, which returns at most five BM25 matches with compact parameter summaries. MCP matches are called through `mcp`; Pi matches are activated additively for the session. This avoids large startup tool schemas and direct-tool warnings. Use `/context all` to inspect active and deferred inventories.

A path that a session reaches every time is loaded eagerly instead, because activating it mid-session rewrites the prompt prefix and re-bills the whole context: Pi's execution and discovery tools, sub-agent and workflow delegation, cross-session coordination, goal mode, web research, and the `choco-pi-lsp` funnel and diagnostics gate. `ALWAYS_ACTIVE_TOOL_NAMES` in [`tool-search.ts`](.pi/extensions/tool-search.ts) is the list. Sub-agents start from that same surface and reach the rest through `tool_search`.

### Workflow commands

| Command                  | Workflow                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `/check [scope]`         | Verify the base choco-pi environment and task-specific optional capabilities |
| `/task-inline <task>`    | Implement directly in the main agent; this is the default modifying workflow |
| `/task <task>`           | Plan and execute independent implementation units with sub-agents            |
| `/task-hotfix <task>`    | Apply a narrow urgent fix directly in the main agent                         |
| `/review-agent [target]` | Run a report-only agentic adversarial review with a fresh reviewer           |
| `/commit [guidance]`     | Create one verified local commit without pushing                             |

`/task` is reserved for work with at least two independent units that benefit from parallel execution. File count alone does not justify it. Direct and hotfix workflows do not delegate implementation.

Every commit uses the harness `/commit` skill. It stages only the intended changes, follows repository-specific policy when present, and otherwise uses a scoped conventional subject, an optional terse body of at most two bullets, and `Assisted-by` and `Signed-off-by` trailers. It does not grant permission to push, open a pull request, publish, or deploy.

### Independent conversation commands

| Command                                       | Description                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/session-new`                                | Choose a model, reasoning effort, optional name, and initial user prompt for a new conversation |
| `/sessions [limit]`                           | List conversations for the current project                                                      |
| `/session-send <id> <queue\|steer> <message>` | Send a queued or steering message to another conversation                                       |
| `/session-read <id> [limit] [include-tools]`  | Read recent transcript items and the current cursor                                             |
| `/session-wait <id> [seconds] [after-cursor]` | Wait for progress after a cursor and for the target to become idle                              |

The agent can call the same operations through `session_create`, `session_send`, `session_list`, `session_read`, and `session_wait`.

Each conversation has its own Pi session ID and reloads project context, extensions, skills, and provider authentication. Same-process messages use the Pi session API directly. Cross-process messages use an owner-scoped heartbeat and a durable, sequenced mailbox under `~/.pi/agent/choco-pi/session-bridge/`.

- `steer` requires an active target and is delivered at Pi's next safe steering point.
- `queue` is FIFO and remains pending while the target is inactive.
- Session discovery and messaging are restricted to the current working directory.
- `session_create` returns immediately. Its cursor may be `null` until the first response.
- Pi writes a new session's JSONL after its first assistant response. If the creating process exits before that response, the not-yet-persisted session can be lost. Existing JSONL records and queued mailbox messages remain available.

## Agent behavior and project context

[`.pi/SYSTEM.md`](.pi/SYSTEM.md) defines the shared operating rules: communication, instruction precedence, intent routing, authority boundaries, evidence, delegation, review, continuity, and completion. It is project-neutral: repository-specific commands and domain rules belong in that repository's `AGENTS.md` or skills.

[`runtime-model-prompt.ts`](.pi/extensions/runtime-model-prompt.ts) replaces `{{PI_CURRENT_MODEL}}` with the active `provider/model` on each turn, separately for parent and child sessions. Credentials are not included.

[`runtime-writing-prompt.ts`](.pi/extensions/runtime-writing-prompt.ts) injects [`.pi/writing-policy.md`](.pi/writing-policy.md) into main and child prompts.

Pi loads context files from the startup path. `choco-pi-agents-md` adds descendant `AGENTS.md` instructions when the agent reads or works in a deeper path. For example, accessing `packages/api/src/service.ts` can add, in order:

```text
packages/AGENTS.md
packages/api/AGENTS.md
packages/api/src/AGENTS.md
```

Loaded instructions persist in the session and refresh on change.

## Sub-agents

Built-in package roles are disabled through [`.pi/subagents.json`](.pi/subagents.json), with unknown role names rejected instead of falling back. choco-pi provides five model-neutral, project-aware leaf roles under [`.pi/agents`](.pi/agents):

| Role          | Use                                             | Write access |
| ------------- | ----------------------------------------------- | -----------: |
| `general`     | General scoped work                             |          Yes |
| `planner`     | Dependency, conflict, and verification planning |           No |
| `implementer` | One assigned implementation unit                |          Yes |
| `reviewer`    | Fresh-context evidence-based review             |           No |
| `handoff`     | Concise report of verified state                |           No |

Use `/agents` to inspect roles, running agents, transcripts, schedules, and operational defaults. A role's `default_model` and `default_thinking` apply on their own, so a spawn that omits `model` and `thinking` runs the role on its declared preference rather than inheriting the orchestrator's. An `Agent` call can still select both when the role does not pin them, and an explicit value wins — that is how the orchestrator moves a unit off an overloaded provider. Resolution order is frontmatter `model:`/`thinking:` pin, then the explicit invocation parameter, then the role's `default_*`, then parent/runtime defaults.

Use `steer_subagent` to redirect a running agent after its current tool, `get_subagent_result` to retrieve a background result, and an `Agent` call with `resume: <id>` for a completed agent's same-unit follow-up. New calls start with fresh conversation context; each custom role appends its instructions to the current parent system prompt and inherits skills.

All custom roles load the same extensions as the main agent and declare no `tools:` allowlist, so a subagent starts from the same lean tool surface the orchestrator has — code mode (`exec`), the choco-pi-lsp funnel, `tool_search` for everything deferred — rather than a hand-written subset. Because ambient child extensions now load, a model adapter can shadow a declared native tool in a child as it can in the main session. Nested delegation stays off regardless: `Agent`, `get_subagent_result` and `steer_subagent` are stripped from a child unless its role sets `allowed_subagents`. Writer roles use the current checkout by default and may run concurrently only when the orchestrator assigns disjoint direct and indirect ownership scopes. `isolation: "worktree"` is explicit opt-in.

## Checkpoints, review, and Git boundaries

[`file-checkpoints.ts`](.pi/extensions/file-checkpoints.ts) records staged, unstaged, and untracked state at the start of each agent turn. Every write goes to a scratch index seeded from a copy of the real one, so a capture never competes for `index.lock` with the agent, a sub-agent, or the user, and it still succeeds while a merge or rebase leaves the index unmerged. The raw index is stored as a blob, so staging, conflict stages, and flags such as `skip-worktree` come back byte for byte.

`/rewind` and `/fork` open the same picker over the user turns of the active branch. Press `r` to rewind the conversation to a turn without touching files, `b` to roll back both the conversation and the files, `f` to branch a new session from that turn, or Enter to choose from a dialog. A rollback captures a safety checkpoint first and reports the commit that holds it. It restores files and the index but never moves `HEAD`, and it asks first when commits landed after the selected turn. Turns recorded before a checkpoint existed stay selectable for rewind and fork, so the picker still works in a working tree without Git. Ignored files are never touched.

Each session keeps one ref under `refs/choco-pi/checkpoints/`, chaining its checkpoints so a single ref keeps them reachable, and turns that changed nothing reuse the previous checkpoint commit. A session that starts from existing entries — a fork, a clone, or a resume after its own ref expired — adopts those checkpoints under its own ref, so rolling back to a turn it inherited never depends on the session that recorded it. Refs untouched for 14 days are pruned at session start so `git gc` can reclaim the objects; set `CHOCO_PI_CHECKPOINT_RETENTION_DAYS` to change that window, or `0` to reclaim every idle checkpoint at once.

[`review`](.pi/skills/review/SKILL.md) and [`.pi/review-policy.md`](.pi/review-policy.md) define the `/review-agent` report-only adversarial review. The reviewer receives an exact diff or revision, tries to disprove its assumptions, and reports only reproducible or decisively traced findings. A review does not authorize fixes.

Modifying workflows record the starting revision, inspect the dirty tree, maintain an acceptance ledger, and acquire a checkout mutation lease. Work stays in the current checkout unless the user requests a worktree or isolation is required by repository policy.

## Interactive human code review

`/review` opens a local TUI for session checkpoints, a branch range, or a GitHub pull request. `/review session` compares the first available checkpoint with the current working tree, while `/review session turn <n>` isolates one turn. `/review branch <base>` reviews `merge-base(HEAD, base)..HEAD` plus current index, working-tree, and untracked changes. Supplying a target reviews `merge-base(target, base)..target`. `/review pr <number>` reviews the pull request's merge-base-to-head diff, and `/review resume` opens saved records. Open pull requests appear in argument completion and the target picker.

Preparing a pull request review fetches its diff and checks out a worktree, so a progress line appears above the prompt until the view opens.

The view orders files by local risk heuristics, folds generated or low-signal changes, renders unified or split diffs with syntax highlighting, searches changed lines, collects anchored inline comments, and tracks reviewed hunks. Pi also uses the same renderer for `write`, `edit`, and `apply_patch` tool output.

`/review` takes over the terminal as a full-screen mode rather than opening a floating dialog, reserving a header row and, at the bottom, the review state, the input, and two key rows. A line cursor addresses one diff line, and `Shift+↑` / `Shift+↓` extend it into a range, so a comment attaches to the selected line or the selected range and nothing else. Comment text is typed in the view's own input; the review never stacks a separate dialog over itself.

A committed comment renders in the diff itself, beneath its anchored line with its line or range label, so written remarks stay visible while reviewing instead of surviving only as a count in the footer. A folded hunk's placeholder reports how many comments it hides.

| Key                   | Action                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `j` / `k`, `↑` / `↓`  | Move the line cursor                                                                                    |
| `]` / `[`             | Move between hunks                                                                                      |
| `n` / `p`, `→` / `←`  | Move between files                                                                                      |
| `PageUp` / `PageDown` | Move the line cursor by a page                                                                          |
| `Shift+↑` / `Shift+↓` | Extend the selection to a line range; any plain move collapses it                                       |
| `Space`               | Fold or expand the current file or hunk                                                                 |
| `+` / `-`             | Reveal or hide context above and below the current hunk                                                 |
| `/`, then `N` / `P`   | Search changed lines and move between matches                                                           |
| `c`                   | Comment on the selected line or range; `Enter` submits, `Shift+Enter` inserts a newline, `Esc` discards |
| `a`                   | Ask an agent about the current line; `Enter` asks, `Shift+Enter` inserts a newline, `Esc` closes        |
| `Tab`                 | Complete a path in an input; from the review, open the chat                                             |
| `Shift+Tab`           | Move focus between the review and the chat                                                              |
| `Ctrl+O`              | Toggle tool output in the chat, as in the main session                                                  |
| `e` / `E`             | Open the line under the cursor or the project in the configured editor                                  |
| `v`                   | Toggle unified and split diff modes                                                                     |
| `m`                   | Mark the current hunk reviewed                                                                          |
| `S`                   | Finish and save; submit a pull request review or place a session instruction in the input editor        |
| `q`                   | Save and close without submitting                                                                       |

A range stays inside one hunk and one side, because a GitHub comment range cannot span either. Extension stops at a side boundary rather than skipping the intervening rows, so the highlighted rows and the submitted range are always the same lines. A comment inherits the side of the line it sits on: added lines comment on `RIGHT`, removed and context lines on `LEFT`, so remarking on deleted code works as expected. The cursor never enters a folded hunk; expanding one moves it to that hunk's first line.

Both inputs carry the prompt's own completion provider, rooted at the worktree under review rather than the process directory, so `Tab` completes a path from the code being reviewed and `@` searches the tree when `fd` is available. Each input keeps its own history, so `↑` recalls earlier comments in the comment box and earlier questions in the chat, and neither replays the other. History lives only as long as the review is open.

`choco-pi-ui` draws both inputs in the style it is configured to draw the session prompt with, whether that is the rails and the model, provider, and effort row of the `opencode` styles or the `minimalist` box, and the completion list renders inside that chrome. Without the UI package, the inputs keep pi-tui's plain editor and the key row carries the model and effort instead.

A folded file or hunk still occupies one selectable row, so `k` returns to it and `Space` expands it again. The bottom four rows are split between the comment or chat input, the current position and review state, and the keys available in the current mode.

`+` and `-` reveal and hide surrounding context above and below the current hunk from any line in it, ten lines at a time up to a hundred per edge, stopping at the file's boundary or before context already revealed from the next hunk. Revealed lines are read from the reviewed revision, never the working tree, and are a display overlay: the diff under review keeps its hunk identities, so reviewed state and existing comment anchors survive expanding and collapsing. Comments can be placed on revealed lines.

`a` opens a side chat about the line under the cursor. The chat runs as a separate agent session rooted at the review's worktree, with the same toolset and harness as the main agent; questions instruct it to answer as a reviewer without changing anything, and nothing it discusses enters the main conversation's context. Each question carries only the location — file, hunk header, side, line, and the focused line's text — never the diff body; the agent reads the code itself from the review worktree. `Shift+Tab` moves focus between the panes and `Esc` closes the chat. Below 120 columns the chat replaces the diff instead of splitting the screen.

The chat mirrors the main prompt's experience. Replies render through the same Markdown renderer and theme, tool calls collapse to a one-line title through the main transcript's own tool component with `Ctrl+O` toggling full output, and `PgUp`/`PgDn` scroll the transcript, and the model and thinking level — inherited from the main session — sit right under the input. A leading `/` opens the familiar command menu with argument completion: `/model` and `/effort` switch the chat's own session, `/reload` reloads its extensions, skills, prompts, and context files, the session's other extension commands, skills, and prompt templates run exactly as they would at the main prompt, and `/quit` or `/exit` saves the review and leaves, like `q`.

For a pull request, `S` asks for an overall summary and one outcome: comment, approve, request changes, or a pending draft to inspect on GitHub. A plain comment submits without another confirmation. Approvals, change requests, and pending drafts show the submission plan and require explicit confirmation before any API write. If the pull request head moved, the plan relocates anchored comments against the new pull request base-to-head diff and reports every relocation; comments that no longer map uniquely are demoted to file-level notes with the reason shown before confirmation. A failed or declined submission keeps the local record and places its Markdown in Pi's input editor as an offline path.

Configure the view in [`.pi/extensions/review.json`](.pi/extensions/review.json). A project-local `.pi/extensions/review.json` takes precedence over the linked global file. `gui` mode starts a detached graphical editor while Pi keeps the terminal; `terminal` mode releases the TUI until the editor exits. Command tokens support `{path}`, `{line}`, `{column}`, and `{dir}`.

```json
{
  "editor": {
    "command": ["zed", "--wait", "{path}:{line}"],
    "mode": "gui"
  },
  "highlight": {
    "enabled": true,
    "maxFileBytes": 512000,
    "maxDiffLines": 20000
  },
  "heuristics": {
    "riskPatterns": [],
    "collapsePatterns": []
  }
}
```

For a terminal editor, use a command such as `{"command":["nvim","+{line}","{path}"],"mode":"terminal"}`. Without an explicit `editor`, Zed in GUI mode wins when the `zed` executable is on `PATH`; otherwise `VISUAL` or `EDITOR` selects terminal mode; otherwise the view falls back to the Zed default command even if Zed is not installed. This keeps `$EDITOR` from silently overriding the documented Zed default, since a shell's `$EDITOR` is usually set for commit messages and quick terminal edits, not for reading a code review. The diff view always opens regardless of editor availability; only pressing `e` or `E` needs a working editor, and it reports a failure if the resolved command cannot actually spawn.

Review records live under `~/.pi/agent/choco-pi/reviews/`, separated by repository and target, so `/review pr <number>` can resume across days. Pull request heads are fetched and checked out as detached, pinned worktrees under `~/.pi/agent/choco-pi/reviews/<repository-key>/worktrees/`. The extension removes only worktrees carrying its ownership token and disposes them whenever the review view closes, including after an error; reopening reconstructs the worktree from the pinned SHA.

The diff and records stay inside the extension process and consume no model context. Finishing a session review places the human comments in Pi's input editor but does not send them; model context changes only if the user submits that text. Pull request listing, resolution, and submission require the GitHub CLI: install `gh`, run `gh auth login`, and retry if completion, the picker, or submission reports that GitHub is unavailable. Local records and Markdown export remain available without GitHub authentication. The `a` (ask AI) and `t` (type information) keys arrive in a later phase.

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
- The **Context cap** row on the Model tab of `/preferences` reports the effective value for the current session.

For OpenAI Codex, enable native Responses compaction with `/codex openai`. The tracked [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json) is linked to `~/.pi/agent/choco-pi-codex.json` by `npm run install:profile`, so `/codex` settings are synchronized with the project. It keeps Fast mode off by default.

The minimal compaction-only configuration is:

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

## MCP, goals, web search, and side conversations

- Copy [`.pi/mcp.example.json`](.pi/mcp.example.json) to `~/.pi/agent/mcp.json` and add any local OAuth client settings there. Keep it outside this checkout. Pi reads `~/.pi/agent/mcp.json` and a project `.pi/mcp.json` as separate sources, so a copy inside choco-pi registers every server twice whenever Pi runs from this directory, and a checkout that lacks the ignored file silently starts with no servers at all. `/mcp` shows configuration and runtime state.
- A server whose authorization server does not support dynamic client registration needs a pre-registered client. Add `oauth.clientId` and `oauth.clientSecret` to that server's entry; a `clientSecret` beginning with `!` runs the rest as a shell command, which keeps the secret out of the file. Register `http://localhost:19876/callback` as the redirect URL with the provider.
- `/goal <objective>` drafts a persistent goal from the task and creates it. A bare `/goal` shows its state and usage, and `/goal pause|resume|clear|copy` manages it.
- `synthetic_web_search` provides web search through the Synthetic package.
- `/btw <question>` starts a read-only side conversation while the main agent is working.
- `/btw:model` and `/btw:thinking` select the side conversation model and effort.
- `/btw:inject` and `/btw:summarize` bring selected side-conversation context into the main session.

## TUI and browser automation

The default theme is `nord-dark`. `choco-pi-ui` supplies the editor, framed user messages, status line, and themes; the Preferences tab of `/preferences` configures those regions and stores user preferences in `~/.pi/agent/choco-pi-ui.json`. The package still reads legacy `pi-choco-ui.json` and `zentui.json` files. `/preferences` replaces the former `/zentui` command, which no longer exists.

Browser automation uses the global `agent-browser` skill and CLI rather than a Pi plugin. Install the compatible executable separately:

```sh
npm install --global --allow-scripts=agent-browser agent-browser@0.33.2
agent-browser install
agent-browser --version
```

After installation the skill can open pages, capture interactive snapshots, click, type, take screenshots, and use authenticated browser profiles. `ffmpeg` is required only for WebM recording.

## Agent language and agent style

`/preferences` (alias `/pref`) opens the last tab of the Status/Context/Usage/Preferences view. `Tab` and `Shift+Tab` move between the four tabs from anywhere in the view, `1`/`2`/`3`/`4` jump to one directly, and inside Preferences `←`/`→` move between preference sections. The Status and Context tabs open concise and expand their inventories on `Ctrl+O`. Its **Agent** section holds two global preferences stored in `~/.pi/agent/settings.json`, so they apply to every project:

| Key             | Effect                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `agentLanguage` | Language for prose responses, plans, reports, and generated documents. Unset means the agent matches the language you write in |
| `agentStyle`    | Name of a style file whose instructions are injected on every turn. Unset means no style block                                 |

Both are injected into the system prompt each turn inside a `<choco_pi_agent_preferences>` block, and a change applies from the next turn without restarting Pi.

A configured language overrides the default "answer in the user's language" rule. Two things still win over it, because the block is user configuration rather than project policy: an explicit request in a message, for the artifact it names, so asking for a Japanese document produces one while the conversation continues in the configured language; and a path-scoped project instruction that fixes an artifact's language, such as a repository requiring its prompts, skills, and documentation in English. The same precedence applies to a configured style.

Code, identifiers, and file paths are never affected. Commit messages are decided by the repository, not by this setting: project policy first, then the language of your recent commits in that repository, and English when neither exists. A repository whose history is Korean therefore keeps Korean commit messages while your responses follow the configured language.

Styles are Markdown files with optional frontmatter. `concise` and `explanatory` ship with the profile; add your own to `~/.pi/agent/agent-styles/`, where a file whose `name` matches a shipped style replaces it:

```markdown
---
name: terse
description: Shortest correct answers
---

Answer in at most three sentences unless asked for more.
```

Beyond the dialog, `/preferences language Korean`, `/preferences style concise`, and `/preferences agent` set or open these values directly; a style name with no matching file is reported and ignored rather than silently applied.

## Usage reporting

`/usage` queries Claude Code, OpenAI Codex, and Synthetic in parallel. It displays current utilization and reset or regeneration times without printing credentials or raw provider error bodies.

The open view re-queries the providers every three minutes and again whenever the Usage tab is selected, so the numbers stay current without reopening the command. The previous body stays visible while a refresh runs, and a failed refresh keeps the last successful result.

Each window's bar and percentage are colored by how the quota is holding up. A window that is fully used is red. Otherwise, a Claude Code or OpenAI Codex subscription window is judged against its own clock: the report states the share of the window that has already elapsed, and usage above that share is yellow while usage below it is green. Spending exactly at the elapsed share makes the allowance last until the window resets.

Synthetic regenerates instead of resetting, so its buckets have no window to run out of and a single reading cannot be paced: the level is both the amount spent and the time needed to earn it back. They are paced against the previous stored reading instead. A level that fell between the two readings was drained faster than it refilled and is yellow; a level that held or rose is green. Comparing observed levels also keeps an idle gap between regeneration ticks from reading as overspending. Until a second reading exists, or after a plan change moves the capacity, a Synthetic window is left uncolored.

Claude Code shows the plan resolved from Anthropic's OAuth profile — `Pro`, `Max (5x)`, `Max (20x)`, `Team`, `Team Premium`, or `Enterprise`. OpenAI Codex shows the plan reported by ChatGPT — `Plus`, `Pro (5x)`, `Pro (20x)`, `Team`, `Business`, or `Enterprise`. An unrecognized plan value is shown as returned rather than hidden.

Claude Code and OpenAI Codex usage depend on Pi OAuth credentials and provider endpoints also used by their CLIs. API-key authentication may not expose account quotas. Synthetic reports five-hour request usage and weekly credits; separately purchased subscription credit is outside that quota response.

## Repository layout

```text
.pi/
  SYSTEM.md                 Shared choco-pi operating rules
  mcp.example.json          MCP configuration without local credentials
  settings.json             Packages, theme, and compaction settings
  subagents.json            Sub-agent runtime and fallback settings
  agents/                   Project-aware leaf roles
  extensions/               Provider, session, context, usage, and UI behavior
  extensions/agent-preferences/styles/  Shipped agent styles
  prompts/                  Familiar slash-command templates
  skills/                   Workflow implementations
  scripts/                  Shared workflow utilities
  writing-policy.md         Always-on writing rules
  review-policy.md          Shared adversarial review rules
examples/                   Optional user-level configuration examples
```

Run the baseline check after installation or configuration changes:

```text
/check
```

The check validates Node and Pi versions, local package manifests, required harness resources, command aliases, and semantic-tool assets without reading credentials.

## Q&A

### Why build choco-pi instead of using an existing coding agent?

Three things were missing: using models from multiple providers in one session, OpenAI server-side compaction across the agent stack, and a harness built around the author's own workflow.

- **Codex** is an excellent agent, but its multi-agent system is split across V1 and V2 protocols, which made working with non-OpenAI models uncomfortable.
- **Claude Code** naturally does not relay OpenAI server-side compaction, so on a ChatGPT subscription with a limited context window, long sessions repeatedly fall back to slow local compaction.
- **OpenCode** is not as easy to extend as Pi and does not support OpenAI server-side compaction.

Pi's extension model solved all three in one profile. The absence of a sandbox layer was also a plus. With clear constraints in the system prompt the agent does not act dangerously — the author has run Codex in YOLO mode and Claude Code with dangerously-skip-permissions without incident, so Pi's trust-based model is a natural fit.

### Why cap 1M-window models at 600K and move the compaction threshold?

Recent models handle longer contexts better than earlier generations, but output quality still drops as context grows. The ChatGPT subscription caps input at 272K (plus 128K output), so the 600K soft cap already exceeds the largest provider's practical ceiling. Models without server-side compaction rely on local summary fallback, which is slower and less predictable. 600K keeps the working window where quality holds while accommodating providers that do not compact remotely.

### What does choco-pi bring from existing coding agents?

choco-pi is a harness built around the author's workflow, but it deliberately carries over features that made Claude Code, Codex, and similar agents productive.

- `/context` shows token usage, active and deferred tools, MCP servers, context state, and autocompact status in one view.
- `/usage` displays Claude Code, OpenAI Codex, and Synthetic subscription quotas side by side, so consumption limits across providers are visible at a glance.
- choco-pi includes a tool-search tool that lazy-loads MCP and extension tools through BM25 matching instead of registering every tool at startup. This keeps model context small, the same approach adopted by agents like Codex and Claude Code.
- `/rewind` and `/fork` open one checkpoint picker that can rewind the conversation, roll back files and the Git index with it, or fork a new session from any turn.
- Independent sessions can be created, listed, steered, and waited on, providing the same cross-session coordination found in other multi-session agents.

The goal was to keep these conveniences while adding multi-provider model mixing and the extensibility that Pi offers.

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
