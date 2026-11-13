# Claude Code hook compatibility

The package executes the standard Claude hook configuration and records a live
choco-pi lifecycle source or explicit host exclusion for every documented
event. `src/live-coverage.ts` is the machine-checked inventory; removing or
omitting an event fails the package tests.

The main host adaptations are:

- Pi input, tool, turn, message, compaction, and session events provide the direct lifecycle events.
- `choco-pi-subagents` supplies teammate, workflow-task, and worktree bridges. Workflow members stand in for agent-team teammates, so only they fire `TeammateIdle`.
- A subagent session's hooks fire as Claude Code fires them for a subagent: with the top-level `session_id` and transcript, `agent_id`, `agent_type`, and the extra `root_session_id`. `SubagentStart` and `SubagentStop` run inside the subagent session; session-level, prompt, `Stop`, idle-notification, display, model-switch, and watcher events do not.
- The package supplies Claude-compatible task tools, setup flags, notifications, environment persistence, and filesystem watchers where Pi has no native equivalent.
- `Notification` fires only for `idle_prompt`, and not while a background subagent runs. Claude Code's `agent_completed` reports background sessions in agent view, which choco-pi does not have, so a finished subagent sends no notification.
- `UserPromptSubmit` also runs for a run that an idle custom message starts, such as a subagent reporting back; a block aborts that run.
- Hook strings over 10,000 characters are saved under the session's hook-output directory and replaced by the path and a 2,000-character preview.

MCP-tool handlers fail closed with a command-hook migration message, and no
producer emits `Elicitation` or `ElicitationResult`: Pi's built-in MCP
replaced the adapter that supplied those bridges.

No producer emits `PreModelSwitch`: Pi reports a model change only after it
happens. `PostModelSwitch` runs for every switch Pi reports after the first
selection.

`PermissionRequest` and `PermissionDenied` configurations are intentionally
ignored because choco-pi has no permission subsystem. `PreToolUse` allow and
deny decisions remain supported; an `ask` decision falls through to Pi's normal
tool execution behavior, and `defer` is ignored because Pi has no deferred
tool-call protocol. Auto mode, `classifierContext`, and PowerShell-specific
behavior have no Pi counterpart.

Hooks declared in skill or subagent frontmatter are not loaded: Pi skills and
choco-pi agent definitions have no `hooks` field. Command hooks inherit Pi's
controlling terminal rather than running in a session without one.

Compatibility is validated at three levels: pure protocol tests, live extension-host tests, and a dedicated tmux Pi run using the configured Luna model.
