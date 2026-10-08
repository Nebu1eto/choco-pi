# choco-pi-hooks

`choco-pi-hooks` is a Claude Code hook compatibility engine and Pi extension. It reads hook blocks in increasing precedence from:

- Claude fallback: `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`
- Agent-shared: `~/.agents/settings.json`, `<project>/.agents/settings.json`, `<project>/.agents/settings.local.json`
- Pi preferred: `$PI_CODING_AGENT_DIR/settings.json`, `<project>/.pi/settings.json`, `<project>/.pi/settings.local.json`
- caller-provided managed, plugin, skill, agent, and session sources

The engine exports all 31 documented hook event names and supports command, HTTP, prompt, and agent handlers. The Pi extension supplies the model backend and bridges task, sub-agent, worktree, configuration, file, and session events. `mcp_tool` handlers still parse but fail with a message to use a command hook, because Pi's built-in MCP runs tools only inside tool calls. `PermissionRequest` and `PermissionDenied` are ignored because Pi has no permission subsystem.

## Pi integration

The bundled extension maps Pi lifecycle events to their direct Claude Code equivalents:

- `session_start` → `SessionStart`
- `input` → `UserPromptSubmit`
- `tool_call` → `PreToolUse`
- successful or failed `tool_result` → `PostToolUse` or `PostToolUseFailure`
- `session_before_compact` / `session_compact` → `PreCompact` / `PostCompact`
- `agent_end` → `Stop`
- `session_shutdown` → `SessionEnd`

A blocking `Stop` reason or `additionalContext` from `Stop` hooks continues the session with a follow-up message. Both count against `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8), which resets on the next user input.

`COMPATIBILITY.md` records every live binding and explicit host exclusion.

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
