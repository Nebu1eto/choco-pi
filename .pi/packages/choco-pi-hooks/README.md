# choco-pi-hooks

`choco-pi-hooks` is a Claude Code hook compatibility engine and Pi extension. It reads hook blocks in increasing precedence from:

- Claude fallback: `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`
- Agent-shared: `~/.agents/settings.json`, `<project>/.agents/settings.json`, `<project>/.agents/settings.local.json`
- Pi preferred: `$PI_CODING_AGENT_DIR/settings.json`, `<project>/.pi/settings.json`, `<project>/.pi/settings.local.json`
- caller-provided managed, plugin, skill, agent, and session sources

The engine exports all 31 documented hook event names and supports command, HTTP, MCP-tool, prompt, and agent handlers. The Pi extension supplies MCP and model backends and bridges task, sub-agent, worktree, elicitation, configuration, file, and session events. `PermissionRequest` and `PermissionDenied` are ignored because Pi has no permission subsystem.

## Pi integration

The bundled extension maps Pi lifecycle events to their direct Claude Code equivalents:

- `session_start` → `SessionStart`
- `input` → `UserPromptSubmit`
- `tool_call` → `PreToolUse`
- successful or failed `tool_result` → `PostToolUse` or `PostToolUseFailure`
- `session_before_compact` / `session_compact` → `PreCompact` / `PostCompact`
- `agent_end` → `Stop`
- `session_shutdown` → `SessionEnd`

`COMPATIBILITY.md` records every live binding and explicit host exclusion.

## Public API

```ts
import { HookEngine, loadHookSources } from "choco-pi-hooks";

const { sources } = loadHookSources({ cwd: process.cwd() });
const hooks = new HookEngine(sources, {
  mcpTool: async (handler, input, signal) => /* call connected MCP tool */,
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
