# Package provenance

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
checkpoints without running `PreCompact` or `PostCompact`; host and manual
compactions still run each once. No new hook event type exists.

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

## 2026-10-09 choco-pi patch: Pi SDK 1.2.0

Pi SDK peer and development pins move from `1.0.4` to exactly `1.2.0`.
A SessionStart `initialUserMessage` is sent with `deliverAs: "followUp"`, which
1.2.0 requires while a run is starting.
