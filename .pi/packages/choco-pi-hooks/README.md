# choco-pi-hooks

`choco-pi-hooks` is a Claude Code hook compatibility engine and Pi extension. It reads hook blocks in increasing precedence from:

- Claude fallback: `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`
- Agent-shared: `~/.agents/settings.json`, `<project>/.agents/settings.json`, `<project>/.agents/settings.local.json`
- Pi preferred: `$PI_CODING_AGENT_DIR/settings.json`, `<project>/.pi/settings.json`, `<project>/.pi/settings.local.json`
- caller-provided managed, plugin, skill, agent, and session sources

The engine exports all 33 documented hook event names and supports command, HTTP, prompt, and agent handlers. The Pi extension supplies the model backend and bridges task, sub-agent, worktree, configuration, file, and session events. `mcp_tool` handlers still parse but fail with a message to use a command hook, because Pi's built-in MCP runs tools only inside tool calls. `PermissionRequest` and `PermissionDenied` are ignored because Pi has no permission subsystem.

## Pi integration

The bundled extension maps Pi lifecycle events to their direct Claude Code equivalents:

- `session_start` → `SessionStart` (`new` arrives as `clear`), and again with `compact` after each compaction
- `input` → `UserPromptSubmit`, also for runs started by an idle custom message such as a subagent report
- `tool_call` → `PreToolUse`
- successful or failed `tool_result` → `PostToolUse` or `PostToolUseFailure`
- `turn_end` after tool calls → `PostToolBatch`
- `session_before_compact` / `session_compact` → `PreCompact` / `PostCompact`
- `model_select` → `PostModelSwitch`
- `agent_end` → `Stop`, or `SubagentStop` in a subagent session
- `before_agent_start` in a subagent session → `SubagentStart`
- `session_shutdown` → `SessionEnd`

A blocking `Stop` or `SubagentStop` reason, or their `additionalContext`, continues the session with a follow-up message. Both count against `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8), which resets on the next tool call or user input.

### Subagent sessions

Each subagent is a separate Pi session in the parent's process, but Claude Code runs a subagent's hooks as part of the parent session. Hook input from a subagent session therefore carries the top-level session's `session_id` and `transcript_path`, plus `agent_id`, `agent_type`, and the choco-pi field `root_session_id`. A subagent session fires tool, compaction, task, and instruction events, plus `SubagentStart` (whose `additionalContext` reaches the subagent) and `SubagentStop` (which can keep it working). It never fires `SessionStart`, `Setup`, `SessionEnd`, prompt, `Stop`, `StopFailure`, idle-notification, display, model-switch, working-directory, or file-watcher events, so session-scoped hooks such as session naming run once per user session.

`COMPATIBILITY.md` records every live binding and explicit host exclusion.

### Scratch-path warnings

For `write`, `edit`, `apply_patch` and `ast_grep_replace`, a destination under `/tmp` but outside `/tmp/choco-pi/<root session id>/` adds a warning to the tool result; the call still runs. To allow other temporary directories, list absolute paths under `scratchGrants` in a user-level settings file (`~/.claude/settings.json`, `~/.agents/settings.json` or `$PI_CODING_AGENT_DIR/settings.json`). Project settings are not read for this key. Command contents (`bash`, `exec_command`, `write_stdin`), browser, image and MCP tools are not inspected.

## Public API

```ts
import { HookEngine, loadHookSources } from "choco-pi-hooks";

const { sources } = loadHookSources({ cwd: process.cwd() });
const hooks = new HookEngine(sources, {
  model: async (handler, input, signal) => /* run prompt or agent evaluator */,
});

const result = await hooks.run({
  session_id: "...",
  transcript_path: "...",
  cwd: process.cwd(),
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
});
```

`result` contains the merged decision, context, rewritten input or output, messages, and every individual handler result. Matching handlers run concurrently. Pre-tool decisions use Claude Code’s `deny > defer > ask > allow` precedence.

## Development

```sh
pnpm --dir .pi/packages/choco-pi-hooks test
pnpm --dir .pi/packages/choco-pi-hooks typecheck
```
