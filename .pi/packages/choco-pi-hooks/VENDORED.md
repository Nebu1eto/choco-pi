# Package provenance

## 2026-11-05 choco-pi patch: Claude Code hook reference parity

Subagent sessions now fire only the hooks Claude Code fires for a subagent.
Their input carries the top-level `session_id` and transcript with `agent_id`
and `agent_type` from the subagent marker; `root_session_id` stays.
`SubagentStart` runs in the subagent at each run start and injects its
context once; `SubagentStop` runs at the subagent's `agent_end` with the
Stop continuation cap. The parent no longer dispatches either, nor an
`agent_completed` notification, and `TeammateIdle` is limited to workflow
members. SessionStart, Setup, SessionEnd, prompt, Stop, StopFailure, idle,
display, model-switch, working-directory, and watcher events are skipped in
subagent sessions, so a SessionStart hook no longer runs once per subagent.

Protocol changes from the current hooks reference: one-object stdout parsing
with parse failures kept out of context, async one-line responses, the
10,000-character cap, reminder-tag escaping, `onFailure`, the missing-script
rule for continuation events, cross-settings-file deduplication, `once` only
after success, the SessionEnd budget, untimed `async` hooks,
`CLAUDE_PROJECT_DIR` fixed to the session's start directory, `CLAUDE_EFFORT`,
a fallback working directory, `prompt_id`, `scratchpad_dir`,
`session_title`, resume-cost fields, and per-event prompt/agent hook
outcomes. Events gain SessionStart `clear`/`compact`, UserPromptSubmit on
custom-message runs and its `sessionTitle`/`suppressOriginalPrompt`,
PreToolUse context and exit-2 messages on tool results, PostToolUse feedback
and `updatedMCPToolOutput`, PostToolBatch control, `continue: false` on
Stop, background DirectoryAdded, line-batched MessageDisplay,
`PostModelSwitch`, the `PreModelSwitch` name without a producer, and
per-event output discarding. `if` rules match Bash subcommands and
substitutions and gitignore-style file paths.

## 2026-10-12 choco-pi patch: subagent hook input names its root session

Subagents run in the parent's process and share its terminal, so hook
consumers keyed by terminal (the Zellij status bridge) could not tell a
subagent's events from the parent's. Hook input from a subagent session now
carries `root_session_id`, the top-level session it belongs to; other
sessions omit it. `session_start` asks the `pi-subagents:manager` registry
`isChildSessionId` once, because the registry drops a child id before that
child's shutdown. The parent comes from the in-memory `choco-pi:subagent`
entry, and a process-wide table resolves nested subagents to the top level.
A subagent transcript resumed as an ordinary session is not in the registry
and gets no `root_session_id`.

## 2026-10-11 choco-pi patch: contain hook transport failures

Command hooks handle stdin write callbacks and stream errors before writing the
payload. EPIPE and ERR_STREAM_DESTROYED preserve the child's actual exit result;
other stdin failures are recorded in stderr. Command completion settles once,
and rejected async result delivery is reported without an unhandled rejection.
Regression tests exercise large payloads with real children and inject transport
and delivery failures. This remains a first-party package, not an external fork.

## 2026-10-08 choco-pi patch: truthful MCP elicitation coverage

Labels `Elicitation` and `ElicitationResult` as having no producer, matching
`COMPATIBILITY.md`. Pi's built-in MCP handles elicitation; this package does
not bridge its requests or responses.

`choco-pi-hooks` is a first-party choco-pi package. It is not vendored from an external project.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4

Pi SDK peer and development pins move from `0.87.1` to exactly `1.0.4`,
matching the harness target. Other dependency contracts are unchanged.

## 2026-10-08 choco-pi patch: MCP hook backend retired

Removes the custom `choco-pi-hooks:mcp-call` request and response event and
the dead `choco-pi-hooks:elicitation` consumer. MCP hook configuration still
parses, but the executor fails closed with a command-hook migration message:
the public Pi SDK offers approved `executeTool` only inside `tool.execute`,
not from lifecycle hooks. This is an intentional user-visible removal, not an
approval bypass.

## 2026-10-08 choco-pi patch: shared Stop continuation budget

Applies `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to both blocking reasons and
additional-context follow-ups. Preserves the existing default of 8 and the
blocking branch's exclusive threshold (at most 7 follow-ups by default).
Non-extension `input` starts a fresh user-task budget; extension-generated
continuations retain `stop_hook_active`. Pending Stop results are discarded
when a new user task or lifecycle generation supersedes their owner.

## choco-pi patch: no compaction hooks for background adoption

Background compaction (`choco-pi-compaction`, off by default) adopts prepared
checkpoints without running `PreCompact` or `PostCompact`; this includes a
`/compact` or programmatic `compact()` (RPC, SDK, `ctx.compact()`) that the
feature defers to a background preparation. The prepared checkpoint is adopted
when the next prompt or turn end arrives (an idle session adopts it as soon as
it is ready), still without either hook. Host compactions the feature does not
answer still run each hook once. No new hook event type exists.

- `src/extension.ts`: `session_before_compact` and `session_compact` first
  consult the compaction package's adoption signal
  (`Symbol.for("choco-pi:compaction-background-adoption")`, typebox-validated).
  `willAdopt(sessionId, event)` shares the coordinator's per-event arbitration,
  so the PreCompact skip and the adoption are one decision;
  `isAdoption(sessionId, entry)` recognizes this process's adopted entries. An
  absent or foreign slot, or a throwing `willAdopt`, leaves behavior unchanged.
  Boundary adoption emits no host event and needs no change.
- Structural divergence (behavior-preserving, same call and dispatch order):
  inside `chocoPiHooks`, `/hooks` uses `configuredHookRows` and
  `sourceHookRows`, `input` uses `warnBlockedReason`, and the `tool_call`
  worktree branch uses `createHookWorktree(dispatch, ctx, event)`.
- `tests/background-compaction-hooks.test.ts` (new): real SDK session with the
  real hooks and compaction extensions and temporary HOME/agent dir; an
  idle-route adoption runs no hook despite its real host events, and a later
  host compaction runs PreCompact and PostCompact once each.
  Updated when `choco-pi-compaction` began taking over an idle session's
  `AgentSession.prototype.compact`: the deferred plain and instructed
  `compact()` calls now resolve `undefined` instead of rejecting with
  `Compaction cancelled`, and their adoption is still hook-free. Test-only.

## 2026-10-09 choco-pi patch: Pi SDK 1.2.0

Pi SDK peer and development pins move from `1.0.4` to exactly `1.2.0`.
A SessionStart `initialUserMessage` is sent with `deliverAs: "followUp"`, which
1.2.0 requires while a run is starting.

## 2026-10-16 choco-pi patch: Pi SDK target 1.3.0

Pi SDK peer and development pins move from `1.2.0` to exactly `1.3.0`.
Verification: `node --test tests/pi-sdk-target.test.ts` and `pnpm typecheck` pass.

## 2026-10-22 choco-pi patch: Pi SDK target 1.4.0

Pi SDK peer and development pins move from `1.3.0` to exactly `1.4.0`.
Verification: `node --test tests/pi-sdk-target.test.ts` and `pnpm typecheck` pass.

## 2026-11-03 choco-pi patch: Pi SDK target 1.5.0 + pi-schema dependency

Pi SDK pins move from `1.4.0` to exactly `1.5.0` and `@earendil-works/pi-schema@1.5.0` is added as a peer dependency (the extension loader has no alias for it).

## 2026-11-03 choco-pi patch: TypeBox removed (pi-schema + predicates)

All TypeBox use is gone except `src/schema-bridge.ts` (`hostParams`, `Type.Unsafe`), which wraps pi-schema objects for `registerTool`, still TypeBox-typed in Pi 1.5.0.

- `src/tasks.ts`: `TaskCreate`/`TaskUpdate` parameters are open pi-schema objects (as TypeBox objects were) behind `hostParams`.
- `src/executor.ts`: the stdin-closed error code check is a compiled open `obj` + `oneOf` (EPIPE, ENOTCONN, ECONNRESET, ERR_STREAM_DESTROYED).
- `src/validation.ts`, `src/extension.ts`: runtime guards for strings, booleans, functions, property bags, the subagents registry and the adoption signal are pi-schema `str` checks or plain predicates (`instanceof Function`, identity); their accept/reject behaviour is unchanged.
- `tests/schema-guards.test.ts` (new): guards and task tool parameter schemas.

## 2026-11-03 choco-pi patch: scratch-path warnings in PreToolUse (P15)

`tool_call` computes, after the PreToolUse hooks ran (so after any `updatedInput`), whether a `write`/`edit`/`apply_patch`/`ast_grep_replace` destination lies under `/tmp` but outside the session's scratch directory, and `tool_result` appends `Scratch path warning: <path> is outside this session's scratch directory <dir>. Use <dir> for temporary files unless the user granted this path.` to the result content (once per tool and directory per session; the call is never blocked). Grants: `scratchGrants`, an array of absolute directories in user-level settings (`~/.claude/settings.json`, `~/.agents/settings.json`, `$PI_CODING_AGENT_DIR/settings.json`); absent means none, project settings are ignored so a repository cannot silence the warning. Limits (warn mode): only the host `write`, `edit`, `apply_patch` and `ast_grep_replace` destinations and the `shell_start` cwd are inspected. The stock host `bash` tool now receives `PI_ROOT_SESSION_ID`, `PI_SCRATCH_DIR` and `PI_PREVIOUS_SCRATCH_DIR` from `.pi/extensions/scratch-env.ts` (a spawn hook on the built-in tool; inherited values are kept; the user `!`-bash path is not covered). Command contents of `bash`/`exec_command`/`write_stdin`, browser outputs, imagegen, MCP tools and notebook filesystem operations are not; the warning is advisory and never blocks. Only paths under `/tmp` (or macOS `/private/tmp`) are judged; `os.tmpdir()` locations such as `/var/folders` are not. The one shared implementation is `.pi/extensions/lib/scratch-path.ts`, imported by relative path. Tests: `tests/scratch-warning.test.ts`.

## 2026-11-03 choco-pi patch: stop-control participant (P4b-3)

`src/stop-control.ts` is the package-local copy of the choco-pi stop-control v1 contract (read-only use here). `src/extension.ts` `agent_end`: for the root session (own session id, or `root_session_id` in a subagent) the Stop hook is not dispatched while the stop state is closed, and the continuation is dropped when the state closes during the awaited dispatch; both reset `stopHookActive`/`stopHookBlocks` and notify `Stop hook continuation skipped: session work is stopped.` once per epoch. An Esc-aborted run (last assistant `stopReason === "aborted"`) dispatches no Stop hook and sends no continuation, matching Claude Code, which does not run Stop hooks on a user interrupt. Tests: `tests/stop-control.test.ts`.
