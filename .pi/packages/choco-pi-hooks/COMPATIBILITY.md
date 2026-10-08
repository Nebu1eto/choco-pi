# Claude Code hook compatibility

The package executes the standard Claude hook configuration and records a live
choco-pi lifecycle source or explicit host exclusion for every documented
event. `src/live-coverage.ts` is the machine-checked inventory; removing or
omitting an event fails the package tests.

The main host adaptations are:

- Pi input, tool, turn, message, compaction, and session events provide the direct lifecycle events.
- `choco-pi-subagents` supplies subagent, teammate, workflow-task, and worktree bridges.
- The package supplies Claude-compatible task tools, setup flags, notifications, environment persistence, and filesystem watchers where Pi has no native equivalent.

MCP-tool handlers fail closed with a command-hook migration message, and no
producer emits `Elicitation` or `ElicitationResult`: Pi's built-in MCP
replaced the adapter that supplied those bridges.

`PermissionRequest` and `PermissionDenied` configurations are intentionally
ignored because choco-pi has no permission subsystem. `PreToolUse` allow and
deny decisions remain supported; an `ask` decision falls through to Pi's normal
tool execution behavior.

Compatibility is validated at three levels: pure protocol tests, live extension-host tests, and a dedicated tmux Pi run using the configured Luna model.
