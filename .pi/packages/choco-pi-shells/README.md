# choco-pi-shells

First-party managed background processes with bounded, in-memory output buffers.
The `shell_start` tool retains its originating `toolCallId` while the shell record
is retained; it does not change the tool-result or persisted-entry format.

## Lifecycle events

Each activation emits `pi.events` notifications only for its owning session:

- `shells:started`: the manager starts a shell record.
- `shells:exited`: the process exits or the manager reports a failed start.
- `shells:stopped`: a requested stop completes; no duplicate `exited` event follows.
- `shells:lost`: a root session is replaced by a new, resumed, or forked session
  while its shells are still running. Reload does not emit `lost`.

Every event has the same flat payload: `id`, `name`, `command`, `cwd`, `pid`,
`exitCode`, `startedAt`, `finishedAt`, `toolCallId`, and `tailPath`. Missing values
are explicit `null`; a failed spawn has no process exit code. `tailPath` is always
`null` because output is buffered in memory, not written to a transcript file.

The host bridge validates and mirrors these events using the shell schema in
[`docs/waku-integration.md`](../../../docs/waku-integration.md). Its runtime
adapter reads `globalThis[Symbol.for("choco-pi-shells:manager")]`, including
`list`, `read`, `stop`, and `toolCallIdOf`. The registry is removed synchronously
when the owning root quits; delivery of shutdown-time events is best-effort.

## Manager ownership

The manager is a process singleton shared by root and child sessions. Only the
root activation whose manager still occupies the registry slot disposes it on
`quit`. A child session's shutdown, including the synthetic `quit` that subagents
emits, stops only that child's shells (`shells:stopped`) and leaves the manager
running for the root. Children are recognised by the subagents child-context
marker or by the `pi-subagents:manager` registry's `isChildSessionId`.
